"""Test fixtures: a tiny synthetic CT series and an isolated data store.

Deliberately independent of ``hnrad.phantom`` -- the tests own their data.
"""

from __future__ import annotations

import importlib
import os
from pathlib import Path

import numpy as np
import pydicom
import pytest
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

N_SLICES = 6
ROWS = COLS = 32
ROW_MM = 0.8
COL_MM = 0.6
SLICE_MM = 2.0
INTERCEPT = -1024.0
SLOPE = 1.0

PATIENT_ID = "TEST001"
PATIENT_NAME = "TEST^SYNTH"

# Fixed UID roots so a re-run overwrites rather than accumulates.
STUDY_UID = "1.2.826.0.1.3680043.10.1337.1"
SERIES_UID = "1.2.826.0.1.3680043.10.1337.2"
SOP_ROOT = "1.2.826.0.1.3680043.10.1337.3"


def _slice_pixels(k: int) -> np.ndarray:
    """Deterministic stored values: background air, a bright cube in the middle."""
    hu = np.full((ROWS, COLS), -1000.0, dtype=np.float64)   # air
    hu[4:28, 4:28] = 40.0                                   # soft tissue block
    # A bright "bone" cube spanning slices 2..4 so marching cubes has a closed
    # surface strictly inside the volume.
    if 2 <= k <= 4:
        hu[10:22, 10:22] = 900.0 + 10.0 * k
    # A small graded patch for the ROI test.
    hu[6:10, 6:10] = 60.0 + k
    stored = (hu - INTERCEPT) / SLOPE
    return np.rint(stored).astype(np.uint16)


def write_series(out_dir: Path) -> dict:
    """Write an N_SLICES x ROWS x COLS axial CT series into *out_dir*."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    sop_uids: list[str] = []

    for k in range(N_SLICES):
        sop_uid = "{r}.{k}".format(r=SOP_ROOT, k=k + 1)
        sop_uids.append(sop_uid)

        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = CTImageStorage
        meta.MediaStorageSOPInstanceUID = sop_uid
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        meta.ImplementationClassUID = generate_uid()

        ds = Dataset()
        ds.file_meta = meta
        ds.preamble = b"\0" * 128

        ds.SOPClassUID = CTImageStorage
        ds.SOPInstanceUID = sop_uid
        ds.StudyInstanceUID = STUDY_UID
        ds.SeriesInstanceUID = SERIES_UID
        ds.FrameOfReferenceUID = "1.2.826.0.1.3680043.10.1337.9"

        ds.PatientID = PATIENT_ID
        ds.PatientName = PATIENT_NAME
        ds.PatientSex = "O"
        ds.PatientBirthDate = "19700101"

        ds.StudyDate = "20260917"
        ds.StudyTime = "120000"
        ds.StudyDescription = "CT NECK (TEST)"
        ds.AccessionNumber = "ACC123"
        ds.SeriesDescription = "AXIAL TEST"
        ds.SeriesNumber = 2
        ds.BodyPartExamined = "NECK"
        ds.Modality = "CT"
        # Deliberately out of order on disk / by InstanceNumber vs. position:
        # InstanceNumber ascends with z, but the files are written last-first
        # below so the sort really has to do something.
        ds.InstanceNumber = k + 1

        ds.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
        ds.ImagePositionPatient = [-10.0, -20.0, 5.0 + k * SLICE_MM]
        ds.PixelSpacing = [ROW_MM, COL_MM]
        ds.SliceThickness = SLICE_MM
        ds.SpacingBetweenSlices = SLICE_MM

        ds.Rows = ROWS
        ds.Columns = COLS
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 0
        ds.RescaleSlope = SLOPE
        ds.RescaleIntercept = INTERCEPT
        ds.PixelData = _slice_pixels(k).tobytes()

        # No file extension: the indexer must cope.
        ds.save_as(str(out_dir / "IM{n:04d}".format(n=N_SLICES - k)),
                   enforce_file_format=True)

    return {
        "dir": out_dir,
        "study_uid": STUDY_UID,
        "series_uid": SERIES_UID,
        "sop_uids": sop_uids,
    }


def expected_hu(k: int) -> np.ndarray:
    """The HU array a reader should get back for slice *k*."""
    return _slice_pixels(k).astype(np.float64) * SLOPE + INTERCEPT


@pytest.fixture(scope="session")
def store(tmp_path_factory) -> dict:
    """An isolated HNRad data store with the synthetic series imported."""
    root = tmp_path_factory.mktemp("hnrad_store")
    studies = root / "studies"
    db_file = root / "db" / "hnrad.sqlite"
    os.environ["HNRAD_DATA_ROOT"] = str(root)
    os.environ["HNRAD_STUDIES_ROOT"] = str(studies)
    os.environ["HNRAD_DB_PATH"] = str(db_file)

    info = write_series(studies / "TEST_SERIES")

    # Decoys the indexer must skip.
    (studies / "notes.txt").write_text("not dicom", encoding="utf-8")
    (studies / "junkfile").write_bytes(b"\x01\x02\x03\x04random bytes here")
    (studies / "DICOMDIR").write_bytes(b"\0" * 128 + b"DICM" + b"\0" * 32)

    info["root"] = root
    info["studies"] = studies
    info["db_path"] = db_file
    return info


@pytest.fixture(scope="session")
def client(store):
    """TestClient bound to the isolated store."""
    from fastapi.testclient import TestClient

    from hnrad import analysis, config, db

    importlib.reload(config)
    analysis.clear_caches()
    db._initialised.clear()

    from hnrad.app import app

    with TestClient(app) as c:
        r = c.post("/api/import", json={"path": str(store["studies"])})
        assert r.status_code == 200, r.text
        store["import_result"] = r.json()
        yield c
