"""SQLite index for the local DICOM library.

Plain stdlib :mod:`sqlite3` in WAL mode.  One connection per operation via the
:func:`connect` context manager -- cheap, and safe with FastAPI's thread pool.

Schema::

    patients(patient_id PK)
      studies(study_uid PK, patient_id FK)
        series(series_uid PK, study_uid FK)
          instances(sop_uid PK, series_uid FK)

Series carry denormalised geometry (rows/cols/spacing/orientation) copied from
the first instance seen so that the browser listing needs no joins.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional, Sequence

from . import config

__all__ = [
    "connect",
    "init_db",
    "ensure_db",
    "upsert_patient",
    "upsert_study",
    "upsert_series",
    "upsert_instance",
    "list_patients",
    "list_studies",
    "list_series",
    "get_series",
    "get_series_instances",
    "get_instance",
    "counts",
]

_init_lock = threading.Lock()
_initialised: set[str] = set()

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS patients (
    patient_id   TEXT PRIMARY KEY,
    name         TEXT,
    sex          TEXT,
    birth_date   TEXT
);

CREATE TABLE IF NOT EXISTS studies (
    study_uid    TEXT PRIMARY KEY,
    patient_id   TEXT,
    study_date   TEXT,
    study_time   TEXT,
    description  TEXT,
    accession    TEXT
);
CREATE INDEX IF NOT EXISTS idx_studies_patient ON studies(patient_id);
CREATE INDEX IF NOT EXISTS idx_studies_date    ON studies(study_date);

CREATE TABLE IF NOT EXISTS series (
    series_uid              TEXT PRIMARY KEY,
    study_uid               TEXT,
    series_number           INTEGER,
    modality                TEXT,
    description             TEXT,
    body_part               TEXT,
    rows                    INTEGER,
    cols                    INTEGER,
    pixel_spacing_row       REAL,
    pixel_spacing_col       REAL,
    slice_thickness         REAL,
    spacing_between_slices  REAL,
    orientation             TEXT,
    frame_of_reference_uid  TEXT
);
CREATE INDEX IF NOT EXISTS idx_series_study ON series(study_uid);

CREATE TABLE IF NOT EXISTS instances (
    sop_uid                 TEXT PRIMARY KEY,
    series_uid              TEXT,
    file_path               TEXT NOT NULL,
    instance_number         INTEGER,
    ipp_x                   REAL,
    ipp_y                   REAL,
    ipp_z                   REAL,
    iop_0                   REAL,
    iop_1                   REAL,
    iop_2                   REAL,
    iop_3                   REAL,
    iop_4                   REAL,
    iop_5                   REAL,
    rows                    INTEGER,
    cols                    INTEGER,
    pixel_spacing_row       REAL,
    pixel_spacing_col       REAL,
    slice_thickness         REAL,
    spacing_between_slices  REAL,
    rescale_slope           REAL,
    rescale_intercept       REAL,
    number_of_frames        INTEGER,
    transfer_syntax         TEXT,
    modality                TEXT
);
CREATE INDEX IF NOT EXISTS idx_instances_series ON instances(series_uid);
CREATE INDEX IF NOT EXISTS idx_instances_series_num
    ON instances(series_uid, instance_number);
CREATE INDEX IF NOT EXISTS idx_instances_path ON instances(file_path);
"""


@contextmanager
def connect(path: Optional[Path] = None) -> Iterator[sqlite3.Connection]:
    """Yield a sqlite3 connection with row access by name, committing on exit."""
    p = Path(path) if path is not None else config.db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p), timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(path: Optional[Path] = None) -> Path:
    """Create the schema (idempotent) and return the database path."""
    p = Path(path) if path is not None else config.db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p), timeout=30.0)
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()
    with _init_lock:
        _initialised.add(str(p))
    return p


def ensure_db(path: Optional[Path] = None) -> Path:
    """Run :func:`init_db` once per process per database file."""
    p = Path(path) if path is not None else config.db_path()
    with _init_lock:
        known = str(p) in _initialised
    if known:
        return p
    return init_db(p)


# --------------------------------------------------------------------------
# upserts
# --------------------------------------------------------------------------

def _coalesce_update(table: str, key: str, cols: Sequence[str]) -> str:
    """ON CONFLICT clause that keeps an existing non-NULL value."""
    sets = ", ".join("{c}=COALESCE(excluded.{c}, {t}.{c})".format(c=c, t=table)
                     for c in cols)
    return " ON CONFLICT({k}) DO UPDATE SET {s}".format(k=key, s=sets)


def upsert_patient(conn: sqlite3.Connection, row: dict[str, Any]) -> None:
    cols = ("name", "sex", "birth_date")
    conn.execute(
        "INSERT INTO patients (patient_id, name, sex, birth_date)"
        " VALUES (:patient_id, :name, :sex, :birth_date)"
        + _coalesce_update("patients", "patient_id", cols),
        row,
    )


def upsert_study(conn: sqlite3.Connection, row: dict[str, Any]) -> None:
    cols = ("patient_id", "study_date", "study_time", "description", "accession")
    conn.execute(
        "INSERT INTO studies (study_uid, patient_id, study_date, study_time,"
        " description, accession) VALUES (:study_uid, :patient_id, :study_date,"
        " :study_time, :description, :accession)"
        + _coalesce_update("studies", "study_uid", cols),
        row,
    )


_SERIES_COLS = (
    "study_uid", "series_number", "modality", "description", "body_part",
    "rows", "cols", "pixel_spacing_row", "pixel_spacing_col", "slice_thickness",
    "spacing_between_slices", "orientation", "frame_of_reference_uid",
)


def upsert_series(conn: sqlite3.Connection, row: dict[str, Any]) -> None:
    names = ("series_uid",) + _SERIES_COLS
    placeholders = ", ".join(":" + n for n in names)
    conn.execute(
        "INSERT INTO series ({cols}) VALUES ({ph})".format(
            cols=", ".join(names), ph=placeholders)
        + _coalesce_update("series", "series_uid", _SERIES_COLS),
        row,
    )


_INSTANCE_COLS = (
    "series_uid", "file_path", "instance_number",
    "ipp_x", "ipp_y", "ipp_z",
    "iop_0", "iop_1", "iop_2", "iop_3", "iop_4", "iop_5",
    "rows", "cols", "pixel_spacing_row", "pixel_spacing_col",
    "slice_thickness", "spacing_between_slices",
    "rescale_slope", "rescale_intercept", "number_of_frames",
    "transfer_syntax", "modality",
)


def upsert_instance(conn: sqlite3.Connection, row: dict[str, Any]) -> None:
    names = ("sop_uid",) + _INSTANCE_COLS
    placeholders = ", ".join(":" + n for n in names)
    # file_path is overwritten unconditionally: the same SOP may have moved.
    sets = ", ".join(
        ("{c}=excluded.{c}" if c == "file_path"
         else "{c}=COALESCE(excluded.{c}, instances.{c})").format(c=c)
        for c in _INSTANCE_COLS
    )
    conn.execute(
        "INSERT INTO instances ({cols}) VALUES ({ph})"
        " ON CONFLICT(sop_uid) DO UPDATE SET {sets}".format(
            cols=", ".join(names), ph=placeholders, sets=sets),
        row,
    )


# --------------------------------------------------------------------------
# queries
# --------------------------------------------------------------------------

def counts(conn: sqlite3.Connection) -> dict[str, int]:
    out: dict[str, int] = {}
    for table in ("patients", "studies", "series", "instances"):
        out[table] = conn.execute(
            "SELECT COUNT(*) AS n FROM " + table).fetchone()["n"]
    return out


def list_patients(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT p.patient_id, p.name, p.sex, p.birth_date,
               (SELECT COUNT(*) FROM studies s WHERE s.patient_id = p.patient_id)
                   AS study_count
        FROM patients p
        ORDER BY p.name IS NULL, p.name, p.patient_id
        """
    ).fetchall()
    return [dict(r) for r in rows]


def list_studies(
    conn: sqlite3.Connection, patient_id: Optional[str] = None
) -> list[dict[str, Any]]:
    sql = """
        SELECT st.study_uid, st.patient_id, p.name AS patient_name,
               st.study_date, st.study_time, st.description, st.accession
        FROM studies st
        LEFT JOIN patients p ON p.patient_id = st.patient_id
    """
    params: list[Any] = []
    if patient_id is not None:
        sql += " WHERE st.patient_id = ?"
        params.append(patient_id)
    sql += " ORDER BY st.study_date DESC, st.study_time DESC, st.study_uid"

    out: list[dict[str, Any]] = []
    for r in conn.execute(sql, params).fetchall():
        d = dict(r)
        agg = conn.execute(
            """
            SELECT COUNT(*) AS series_count,
                   COALESCE(SUM((SELECT COUNT(*) FROM instances i
                                 WHERE i.series_uid = se.series_uid)), 0)
                       AS instance_count
            FROM series se WHERE se.study_uid = ?
            """,
            (d["study_uid"],),
        ).fetchone()
        d["series_count"] = agg["series_count"]
        d["instance_count"] = agg["instance_count"]
        mods = conn.execute(
            "SELECT DISTINCT modality FROM series WHERE study_uid = ?"
            " AND modality IS NOT NULL ORDER BY modality",
            (d["study_uid"],),
        ).fetchall()
        d["modalities"] = [m["modality"] for m in mods]
        out.append(d)
    return out


def _series_dict(conn: sqlite3.Connection, r: sqlite3.Row) -> dict[str, Any]:
    """Shape a series row the way the contract describes it."""
    d = dict(r)
    series_uid = d["series_uid"]
    instance_count = conn.execute(
        "SELECT COUNT(*) AS n FROM instances WHERE series_uid = ?", (series_uid,)
    ).fetchone()["n"]

    max_frames = conn.execute(
        "SELECT COALESCE(MAX(number_of_frames), 1) AS n FROM instances"
        " WHERE series_uid = ?",
        (series_uid,),
    ).fetchone()["n"]
    max_frames = int(max_frames or 1)
    is_multiframe = max_frames > 1

    # Largest group of instances that share one ImageOrientationPatient.
    same_orient = conn.execute(
        """
        SELECT COUNT(*) AS n FROM instances
        WHERE series_uid = ? AND iop_0 IS NOT NULL
        GROUP BY iop_0, iop_1, iop_2, iop_3, iop_4, iop_5
        ORDER BY n DESC LIMIT 1
        """,
        (series_uid,),
    ).fetchone()
    n_same_orient = same_orient["n"] if same_orient else 0
    is_3d = bool(n_same_orient >= 3 or (is_multiframe and max_frames >= 3))

    orientation = None
    if d.get("orientation"):
        try:
            orientation = [float(v) for v in json.loads(d["orientation"])]
        except (ValueError, TypeError):
            orientation = None

    ps_row = d.get("pixel_spacing_row")
    ps_col = d.get("pixel_spacing_col")
    pixel_spacing = (
        [float(ps_row), float(ps_col)]
        if ps_row is not None and ps_col is not None
        else None
    )

    return {
        "series_uid": series_uid,
        "study_uid": d.get("study_uid"),
        "series_number": d.get("series_number"),
        "modality": d.get("modality"),
        "description": d.get("description"),
        "body_part": d.get("body_part"),
        "instance_count": instance_count,
        "rows": d.get("rows"),
        "cols": d.get("cols"),
        "pixel_spacing": pixel_spacing,
        "slice_thickness": d.get("slice_thickness"),
        "spacing_between_slices": d.get("spacing_between_slices"),
        "orientation": orientation,
        "is_multiframe": is_multiframe,
        "is_3d": is_3d,
    }


def list_series(conn: sqlite3.Connection, study_uid: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM series WHERE study_uid = ?"
        " ORDER BY series_number IS NULL, series_number, series_uid",
        (study_uid,),
    ).fetchall()
    return [_series_dict(conn, r) for r in rows]


def get_series(conn: sqlite3.Connection, series_uid: str) -> Optional[dict[str, Any]]:
    r = conn.execute(
        "SELECT * FROM series WHERE series_uid = ?", (series_uid,)
    ).fetchone()
    if r is None:
        return None
    return _series_dict(conn, r)


def get_series_instances(
    conn: sqlite3.Connection, series_uid: str
) -> list[sqlite3.Row]:
    """Raw instance rows for a series, in InstanceNumber order."""
    return conn.execute(
        "SELECT * FROM instances WHERE series_uid = ?"
        " ORDER BY instance_number IS NULL, instance_number, sop_uid",
        (series_uid,),
    ).fetchall()


def get_instance(conn: sqlite3.Connection, sop_uid: str) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM instances WHERE sop_uid = ?", (sop_uid,)
    ).fetchone()


def study_exists(conn: sqlite3.Connection, study_uid: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM studies WHERE study_uid = ?", (study_uid,)
    ).fetchone() is not None
