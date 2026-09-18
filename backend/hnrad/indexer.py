"""Recursive DICOM folder indexer.

Walks a folder, header-reads every file that plausibly is DICOM and upserts
patients / studies / series / instances into the SQLite index.  Non-DICOM files
are skipped quietly and cheaply: a 132-byte magic probe runs before pydicom is
ever asked to parse anything.

The walk is idempotent -- SOPInstanceUID is the primary key, so re-importing the
same tree just refreshes the rows.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional, Sequence

import pydicom
from pydicom.errors import InvalidDicomError

from . import db, mr

log = logging.getLogger("hnrad.indexer")

__all__ = [
    "looks_like_dicom",
    "iter_candidate_files",
    "index_path",
    "orientation_normal",
    "slice_position",
]

# Extensions that are certainly not DICOM; skipping them avoids even the open().
_SKIP_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp",
    ".txt", ".md", ".rst", ".log", ".csv", ".tsv", ".json", ".xml", ".yaml",
    ".yml", ".ini", ".cfg", ".toml", ".html", ".htm", ".pdf", ".doc", ".docx",
    ".xls", ".xlsx", ".ppt", ".pptx", ".zip", ".gz", ".bz2", ".xz", ".7z",
    ".tar", ".rar", ".exe", ".dll", ".so", ".dylib", ".py", ".pyc", ".js",
    ".ts", ".css", ".stl", ".obj", ".ply", ".nii", ".mha", ".mhd", ".nrrd",
    ".db", ".sqlite", ".sqlite3", ".wal", ".shm", ".lnk",
}

# Directories that never hold study data.
_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "$RECYCLE.BIN",
              "System Volume Information"}


# --------------------------------------------------------------------------
# cheap DICOM detection
# --------------------------------------------------------------------------

def looks_like_dicom(path: Path) -> bool:
    """True if *path* is plausibly a DICOM file, judged from its first bytes.

    Accepts Part-10 files (``DICM`` at offset 128) and the common
    preamble-less variants whose first element is in group 0x0002 or 0x0008.
    """
    try:
        with open(path, "rb") as fh:
            head = fh.read(140)
    except OSError:
        return False
    if len(head) < 8:
        return False
    if head[128:132] == b"DICM":
        return True
    # Preamble-less: first tag should be (0002,xxxx) or (0008,xxxx), LE.
    group = head[0] | (head[1] << 8)
    if group in (0x0002, 0x0008):
        # Explicit VR -> bytes 4..6 are two uppercase letters; implicit VR ->
        # bytes 4..8 are a length.  Either is fine; the group check is enough
        # of a filter and pydicom does the real validation.
        return True
    return False


def iter_candidate_files(root: Path) -> Iterator[Path]:
    """Yield every regular file under *root*, skipping housekeeping folders."""
    root = Path(root)
    if root.is_file():
        yield root
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
        for name in filenames:
            yield Path(dirpath) / name


def _worth_probing(path: Path) -> bool:
    """Cheap name-based rejection before the file is even opened."""
    name = path.name
    if name.upper() == "DICOMDIR":
        return False  # the directory record file itself carries no pixels
    return os.path.splitext(name)[1].lower() not in _SKIP_EXT


# --------------------------------------------------------------------------
# tag helpers -- every one of these tolerates a missing / unparsable tag
# --------------------------------------------------------------------------

def _s(ds: Any, name: str) -> Optional[str]:
    v = getattr(ds, name, None)
    if v is None:
        return None
    try:
        text = str(v).strip()
    except Exception:
        return None
    return text or None


def _f(ds: Any, name: str) -> Optional[float]:
    v = getattr(ds, name, None)
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _i(ds: Any, name: str) -> Optional[int]:
    v = getattr(ds, name, None)
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _floats(ds: Any, name: str, n: int) -> Optional[list[float]]:
    v = getattr(ds, name, None)
    if v is None:
        return None
    try:
        vals = [float(x) for x in v]
    except (TypeError, ValueError):
        return None
    if len(vals) != n:
        return None
    return vals


def _synthetic_uid(path: Path, prefix: str) -> str:
    digest = hashlib.sha1(str(path.resolve()).encode("utf-8", "replace")).hexdigest()
    return "{p}.{d}".format(p=prefix, d=digest)


# --------------------------------------------------------------------------
# geometry
# --------------------------------------------------------------------------

def orientation_normal(iop: Optional[Sequence[float]]) -> Optional[tuple[float, float, float]]:
    """Slice normal = rowDir x colDir for a 6-element ImageOrientationPatient."""
    if iop is None or len(iop) != 6:
        return None
    r = (float(iop[0]), float(iop[1]), float(iop[2]))
    c = (float(iop[3]), float(iop[4]), float(iop[5]))
    n = (
        r[1] * c[2] - r[2] * c[1],
        r[2] * c[0] - r[0] * c[2],
        r[0] * c[1] - r[1] * c[0],
    )
    mag = (n[0] ** 2 + n[1] ** 2 + n[2] ** 2) ** 0.5
    if mag < 1e-9:
        return None
    return (n[0] / mag, n[1] / mag, n[2] / mag)


def slice_position(
    ipp: Optional[Sequence[float]],
    normal: Optional[Sequence[float]],
    fallback: Optional[float] = None,
) -> Optional[float]:
    """dot(IPP, normal); *fallback* (usually InstanceNumber) when unavailable."""
    if ipp is None or normal is None or len(ipp) != 3:
        return float(fallback) if fallback is not None else None
    return float(
        ipp[0] * normal[0] + ipp[1] * normal[1] + ipp[2] * normal[2]
    )


# --------------------------------------------------------------------------
# indexing
# --------------------------------------------------------------------------

def _rows_from_dataset(ds: Any, path: Path) -> tuple[dict, dict, dict, dict]:
    """Turn a header-only dataset into patient/study/series/instance rows."""
    patient_id = _s(ds, "PatientID") or "NO_PATIENT_ID"
    study_uid = _s(ds, "StudyInstanceUID") or _synthetic_uid(path.parent, "nostudy")
    series_uid = _s(ds, "SeriesInstanceUID") or _synthetic_uid(path.parent, "noseries")
    sop_uid = _s(ds, "SOPInstanceUID") or _synthetic_uid(path, "nosop")

    ipp = _floats(ds, "ImagePositionPatient", 3)
    iop = _floats(ds, "ImageOrientationPatient", 6)
    ps = _floats(ds, "PixelSpacing", 2)
    if ps is None:
        ps = _floats(ds, "ImagerPixelSpacing", 2)

    transfer_syntax = None
    meta = getattr(ds, "file_meta", None)
    if meta is not None:
        ts = getattr(meta, "TransferSyntaxUID", None)
        if ts is not None:
            transfer_syntax = str(ts)

    n_frames = _i(ds, "NumberOfFrames") or 1

    patient = {
        "patient_id": patient_id,
        "name": _s(ds, "PatientName"),
        "sex": _s(ds, "PatientSex"),
        "birth_date": _s(ds, "PatientBirthDate"),
    }
    study = {
        "study_uid": study_uid,
        "patient_id": patient_id,
        "study_date": _s(ds, "StudyDate"),
        "study_time": _s(ds, "StudyTime"),
        "description": _s(ds, "StudyDescription"),
        "accession": _s(ds, "AccessionNumber"),
    }
    series = {
        "series_uid": series_uid,
        "study_uid": study_uid,
        "series_number": _i(ds, "SeriesNumber"),
        "modality": _s(ds, "Modality"),
        "description": _s(ds, "SeriesDescription"),
        "body_part": _s(ds, "BodyPartExamined"),
        "rows": _i(ds, "Rows"),
        "cols": _i(ds, "Columns"),
        "pixel_spacing_row": ps[0] if ps else None,
        "pixel_spacing_col": ps[1] if ps else None,
        "slice_thickness": _f(ds, "SliceThickness"),
        "spacing_between_slices": _f(ds, "SpacingBetweenSlices"),
        "orientation": json.dumps(iop) if iop else None,
        "frame_of_reference_uid": _s(ds, "FrameOfReferenceUID"),
    }
    # v0.4: modality-specific columns (MR sequence parameters and the derived
    # sequence_kind / acquired_plane / is_thick, CT kernel and contrast).  A
    # booleans-as-INTEGER column wants 0/1, not True/False, so that a row read
    # back out of sqlite compares equal to what went in.
    extra = mr.series_metadata(ds, iop)
    for key, value in extra.items():
        series[key] = int(value) if isinstance(value, bool) else value
    instance = {
        "sop_uid": sop_uid,
        "series_uid": series_uid,
        "file_path": str(path),
        "instance_number": _i(ds, "InstanceNumber"),
        "ipp_x": ipp[0] if ipp else None,
        "ipp_y": ipp[1] if ipp else None,
        "ipp_z": ipp[2] if ipp else None,
        "iop_0": iop[0] if iop else None,
        "iop_1": iop[1] if iop else None,
        "iop_2": iop[2] if iop else None,
        "iop_3": iop[3] if iop else None,
        "iop_4": iop[4] if iop else None,
        "iop_5": iop[5] if iop else None,
        "rows": _i(ds, "Rows"),
        "cols": _i(ds, "Columns"),
        "pixel_spacing_row": ps[0] if ps else None,
        "pixel_spacing_col": ps[1] if ps else None,
        "slice_thickness": _f(ds, "SliceThickness"),
        "spacing_between_slices": _f(ds, "SpacingBetweenSlices"),
        "rescale_slope": _f(ds, "RescaleSlope"),
        "rescale_intercept": _f(ds, "RescaleIntercept"),
        "number_of_frames": n_frames,
        "transfer_syntax": transfer_syntax,
        "modality": _s(ds, "Modality"),
    }
    return patient, study, series, instance


def index_path(root: Path, db_file: Optional[Path] = None) -> dict[str, Any]:
    """Index every DICOM file under *root*.

    Returns ``{patients, studies, series, instances, skipped, seconds}`` where
    the first four are counts of the distinct entities seen in *this* run, so a
    repeated import of the same tree reports the same numbers.
    """
    started = time.perf_counter()
    root = Path(root)
    db.ensure_db(db_file)

    patients: set[str] = set()
    studies: set[str] = set()
    series: set[str] = set()
    instances = 0
    skipped = 0

    seen_patients: set[str] = set()
    seen_studies: set[str] = set()
    seen_series: set[str] = set()

    with db.connect(db_file) as conn:
        for path in iter_candidate_files(root):
            if not _worth_probing(path) or not looks_like_dicom(path):
                skipped += 1
                continue
            try:
                ds = pydicom.dcmread(
                    str(path), stop_before_pixels=True, force=True
                )
            except (InvalidDicomError, OSError, ValueError, AttributeError) as exc:
                log.debug("skip %s: %s", path, exc)
                skipped += 1
                continue
            except Exception as exc:  # pragma: no cover - defensive
                log.debug("skip %s: %s", path, exc)
                skipped += 1
                continue

            # force=True happily returns an empty dataset for garbage files.
            if not getattr(ds, "_dict", None) and _s(ds, "SOPInstanceUID") is None:
                skipped += 1
                continue
            if _s(ds, "SOPClassUID") == "1.2.840.10008.1.3.10":
                skipped += 1  # Media Storage Directory (DICOMDIR)
                continue

            try:
                p_row, st_row, se_row, in_row = _rows_from_dataset(ds, path)
            except Exception as exc:  # pragma: no cover - defensive
                log.debug("skip %s: %s", path, exc)
                skipped += 1
                continue

            if p_row["patient_id"] not in seen_patients:
                db.upsert_patient(conn, p_row)
                seen_patients.add(p_row["patient_id"])
            if st_row["study_uid"] not in seen_studies:
                db.upsert_study(conn, st_row)
                seen_studies.add(st_row["study_uid"])
            if se_row["series_uid"] not in seen_series:
                db.upsert_series(conn, se_row)
                seen_series.add(se_row["series_uid"])
            db.upsert_instance(conn, in_row)

            patients.add(p_row["patient_id"])
            studies.add(st_row["study_uid"])
            series.add(se_row["series_uid"])
            instances += 1

    seconds = round(time.perf_counter() - started, 3)
    result = {
        "patients": len(patients),
        "studies": len(studies),
        "series": len(series),
        "instances": instances,
        "skipped": skipped,
        "seconds": seconds,
    }
    log.info(
        "indexed %s: %d instances / %d series / %d studies / %d patients,"
        " %d skipped in %.3fs",
        root, instances, len(series), len(studies), len(patients), skipped, seconds,
    )
    return result
