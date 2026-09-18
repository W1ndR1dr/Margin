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
    "migrate",
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
    "get_series_window",
    "set_series_window",
    "counts",
]

_init_lock = threading.Lock()
_initialised: set[str] = set()

# v0.4 additive migration.  Every column here is added to an existing database
# with ALTER TABLE ADD COLUMN, which sqlite does in O(1) without rewriting the
# table and which is therefore safe on a library that is already populated.
# Adding to this tuple is the *only* supported way to extend the series row:
# nothing is ever dropped or renamed, so an older backend keeps working against
# a newer database.
SERIES_V04_COLUMNS: tuple[tuple[str, str], ...] = (
    # --- MR acquisition parameters, verbatim from the header ---------------
    ("scanning_sequence", "TEXT"),
    ("sequence_variant", "TEXT"),
    ("scan_options", "TEXT"),
    ("image_type", "TEXT"),
    ("echo_time", "REAL"),
    ("repetition_time", "REAL"),
    ("inversion_time", "REAL"),
    ("flip_angle", "REAL"),
    ("magnetic_field_strength", "REAL"),
    ("contrast_agent", "TEXT"),
    # --- derived, modality aware -------------------------------------------
    ("has_contrast", "INTEGER"),        # bool: ContrastBolusAgent or "post"
    ("kernel", "TEXT"),                 # CT ConvolutionKernel
    ("sequence_kind", "TEXT"),          # hnrad.mr.SEQUENCE_KINDS, MR only
    ("acquired_plane", "TEXT"),         # AX / COR / SAG / OBL
    ("is_thick", "INTEGER"),            # bool: through-plane spacing > 2.5 mm
    # --- cached auto window (GET /api/series/{uid}/window) -------------------
    ("window_lower", "REAL"),
    ("window_upper", "REAL"),
    ("window_method", "TEXT"),
    ("window_computed_at", "REAL"),     # unix epoch seconds
)

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
CREATE INDEX IF NOT EXISTS idx_series_modality ON series(modality);

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


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    """The column names of *table* (empty when the table does not exist)."""
    return {r["name"] for r in conn.execute(
        "PRAGMA table_info({t})".format(t=table)).fetchall()}


def migrate(conn: sqlite3.Connection) -> list[str]:
    """Add every missing additive column, in place.  Idempotent.

    Returns the list of columns this call actually added, so a caller (and the
    tests) can tell a fresh migration from a no-op.  Running it twice is a
    no-op the second time; running it against a v0.1 database upgrades it
    without touching a single existing row.
    """
    have = table_columns(conn, "series")
    if not have:                                    # table not created yet
        return []
    added: list[str] = []
    for name, sql_type in SERIES_V04_COLUMNS:
        if name in have:
            continue
        conn.execute("ALTER TABLE series ADD COLUMN {n} {t}".format(
            n=name, t=sql_type))
        added.append(name)
    if added:
        conn.commit()
    return added


def init_db(path: Optional[Path] = None) -> Path:
    """Create the schema (idempotent), migrate it, and return the db path."""
    p = Path(path) if path is not None else config.db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p), timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(SCHEMA)
        conn.commit()
        migrate(conn)
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
) + tuple(
    # The cached window is written by set_series_window, never by an import.
    n for n, _t in SERIES_V04_COLUMNS if not n.startswith("window_")
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

    def opt_bool(key: str) -> Optional[bool]:
        v = d.get(key)
        return None if v is None else bool(v)

    def opt_float(key: str) -> Optional[float]:
        v = d.get(key)
        return None if v is None else float(v)

    window = None
    if d.get("window_lower") is not None and d.get("window_upper") is not None:
        window = {
            "lower": float(d["window_lower"]),
            "upper": float(d["window_upper"]),
            "method": d.get("window_method"),
        }

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
        # --- v0.4: modality-specific metadata -----------------------------
        "frame_of_reference_uid": d.get("frame_of_reference_uid"),
        "sequence_kind": d.get("sequence_kind"),
        "acquired_plane": d.get("acquired_plane"),
        "is_thick": opt_bool("is_thick"),
        "scanning_sequence": d.get("scanning_sequence"),
        "sequence_variant": d.get("sequence_variant"),
        "echo_time": opt_float("echo_time"),
        "repetition_time": opt_float("repetition_time"),
        "inversion_time": opt_float("inversion_time"),
        "flip_angle": opt_float("flip_angle"),
        "magnetic_field_strength": opt_float("magnetic_field_strength"),
        "contrast_agent": d.get("contrast_agent"),
        "has_contrast": opt_bool("has_contrast"),
        "kernel": d.get("kernel"),
        "window": window,
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


def get_series_window(
    conn: sqlite3.Connection, series_uid: str
) -> Optional[dict[str, Any]]:
    """The cached auto window for a series, or ``None`` when never computed."""
    r = conn.execute(
        "SELECT window_lower, window_upper, window_method, window_computed_at"
        " FROM series WHERE series_uid = ?",
        (series_uid,),
    ).fetchone()
    if r is None or r["window_lower"] is None or r["window_upper"] is None:
        return None
    return {
        "lower": float(r["window_lower"]),
        "upper": float(r["window_upper"]),
        "method": r["window_method"],
        "computed_at": (
            float(r["window_computed_at"])
            if r["window_computed_at"] is not None else None
        ),
    }


def set_series_window(
    conn: sqlite3.Connection,
    series_uid: str,
    lower: float,
    upper: float,
    method: str,
    computed_at: Optional[float] = None,
) -> None:
    """Cache the auto window for a series (unconditional overwrite)."""
    import time as _time

    conn.execute(
        "UPDATE series SET window_lower = ?, window_upper = ?,"
        " window_method = ?, window_computed_at = ? WHERE series_uid = ?",
        (float(lower), float(upper), str(method),
         float(computed_at if computed_at is not None else _time.time()),
         series_uid),
    )


def study_exists(conn: sqlite3.Connection, study_uid: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM studies WHERE study_uid = ?", (study_uid,)
    ).fetchone() is not None
