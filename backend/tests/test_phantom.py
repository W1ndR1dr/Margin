"""Fast smoke test for the synthetic neck-CT phantom generator.

Run from the backend directory:

    .venv\\Scripts\\python.exe -m pytest -q tests/test_phantom.py
"""

from __future__ import annotations

import numpy as np
import pydicom
import pytest

from hnrad import phantom

N = 12
SEED = 7


@pytest.fixture(scope="module")
def series(tmp_path_factory):
    out = tmp_path_factory.mktemp("phantom")
    info = phantom.generate(out, n_slices=N, seed=SEED, progress=False)
    return out, info


def test_writes_expected_number_of_files(series):
    out, info = series
    files = sorted(out.glob("IMG_*.dcm"))
    assert len(files) == N
    assert info["n_files"] == N
    assert info["seconds"] < 60.0


def test_validation_passes(series):
    out, _ = series
    v = phantom.validate(out, N)
    assert v["size"] == (512, 512, N)
    assert v["spacing"][0] == pytest.approx(0.45, abs=1e-4)
    assert v["spacing"][1] == pytest.approx(0.45, abs=1e-4)
    assert v["spacing"][2] == pytest.approx(1.0, abs=1e-4)
    # 512 x 0.45 mm = 230.4 mm, a realistic neck field of view
    assert 512 * v["spacing"][0] == pytest.approx(230.4, abs=1e-3)
    assert v["hu_range"][0] <= -900          # air
    assert v["hu_range"][1] >= 900           # cortical bone


def test_tags_and_geometry(series):
    out, info = series
    files = sorted(out.glob("IMG_*.dcm"))
    ds0 = pydicom.dcmread(str(files[0]))
    ds1 = pydicom.dcmread(str(files[-1]))

    assert ds0.PatientName == "PHANTOM^NECK"
    assert ds0.PatientID == "PHANTOM001"
    assert ds0.PatientSex == "O"
    assert ds0.PatientBirthDate == "19700101"
    assert ds0.Modality == "CT"
    assert ds0.BodyPartExamined == "NECK"
    assert ds0.StudyDescription == "CT NECK W CONTRAST (SYNTHETIC)"
    assert ds0.SeriesDescription == "AX SOFT TISSUE 1.0mm (SYNTHETIC)"
    assert ds0.SeriesNumber == 2
    assert int(ds0.KVP) == 120
    assert int(ds0.WindowCenter) == 40 and int(ds0.WindowWidth) == 350
    assert ds0.Manufacturer == "HNRad Phantom"
    assert "SYNTHETIC" in str(ds0.ImageComments)

    # pixel format: signed int16 HU with no rescale
    assert (ds0.BitsAllocated, ds0.BitsStored, ds0.HighBit) == (16, 16, 15)
    assert ds0.PixelRepresentation == 1
    assert ds0.SamplesPerPixel == 1
    assert ds0.PhotometricInterpretation == "MONOCHROME2"
    assert float(ds0.RescaleIntercept) == 0.0 and float(ds0.RescaleSlope) == 1.0
    assert ds0.pixel_array.dtype == np.int16
    assert ds0.pixel_array.shape == (512, 512)

    # geometry: head-first supine, z increasing superiorly
    assert [float(v) for v in ds0.ImageOrientationPatient] == [1, 0, 0, 0, 1, 0]
    assert [float(v) for v in ds0.PixelSpacing] == [0.45, 0.45]
    assert float(ds0.SliceThickness) == 1.0
    assert float(ds0.SpacingBetweenSlices) == 1.0
    assert ds0.InstanceNumber == 1 and ds1.InstanceNumber == N
    z0 = float(ds0.ImagePositionPatient[2])
    z1 = float(ds1.ImagePositionPatient[2])
    assert z1 > z0
    assert z1 - z0 == pytest.approx(N - 1, abs=1e-4)

    # one study / series / frame of reference across the whole run
    uids = {(str(d.StudyInstanceUID), str(d.SeriesInstanceUID),
             str(d.FrameOfReferenceUID))
            for d in (pydicom.dcmread(str(f), stop_before_pixels=True)
                      for f in files)}
    assert len(uids) == 1
    assert len({str(pydicom.dcmread(str(f), stop_before_pixels=True).SOPInstanceUID)
                for f in files}) == N


def test_uids_are_deterministic(series, tmp_path):
    _, info = series
    again = phantom.generate(tmp_path / "again", n_slices=N, seed=SEED, progress=False)
    assert again["study_uid"] == info["study_uid"]
    assert again["series_uid"] == info["series_uid"]
    assert again["frame_uid"] == info["frame_uid"]

    other = phantom.generate(tmp_path / "other", n_slices=N, seed=SEED + 1,
                             progress=False)
    assert other["series_uid"] != info["series_uid"]


def test_anatomy_present_and_tumor_abuts_carotid(series):
    _, info = series
    # the acceptance criterion from CONTRACT.md: ~120 deg of ICA circumference
    assert 100.0 <= info["contact_angle_deg"] <= 140.0

    zz = phantom.TUMOR_CZ
    rng = np.random.default_rng(1234)
    img, mask = phantom.build_slice(zz, rng, collect_tumor=True)
    assert mask is not None and mask.sum() > 200

    def hu(x_mm, y_mm, r=2):
        j = int(round(x_mm / phantom.PS + 255.5))
        i = int(round(y_mm / phantom.PS + 255.5))
        return float(np.median(img[i - r:i + r + 1, j - r:j + r + 1]))

    assert hu(0, -150) < -900                       # air outside the patient
    assert hu(*phantom.carotid_center(zz, -1), 1) > 200   # enhancing right ICA
    assert hu(*phantom.carotid_center(zz, 1), 1) > 200    # enhancing left ICA
    assert 55 <= hu(phantom.TUMOR_CX, phantom.TUMOR_CY) <= 100   # tumour ~+75 HU

    # airway lumen is air at every level and narrows focally around zz 60
    def lumen_width(z):
        a, _, _ = phantom.airway_params(z)
        im, _ = phantom.build_slice(z, np.random.default_rng(5))
        half = int(round(40.0 / phantom.PS))          # +/- 40 mm about midline
        row = im[int(round(a / phantom.PS + 255.5)), 256 - half:256 + half]
        air = np.where(row < -500)[0]
        return (air.max() - air.min() + 1) * phantom.PS if len(air) else 0.0

    trachea = lumen_width(20.0)
    stenosis = lumen_width(60.0)
    assert 15.0 <= trachea <= 22.0
    assert 6.0 <= stenosis <= 10.0
    assert stenosis < trachea / 1.8


def test_cli_runs(tmp_path):
    rc = phantom.main(["--out", str(tmp_path / "cli"), "--slices", "4", "--seed", "3"])
    assert rc == 0
    assert len(list((tmp_path / "cli").glob("IMG_*.dcm"))) == 4
