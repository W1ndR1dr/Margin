"""Segmentation, volumetrics and label export (Analysis API v0.2).

The suite owns a purpose-made 64 x 64 x 40 CT series written as real DICOM in
its own data store, so it can check every number against an analytic value:

* a soft-tissue cylinder ("body") of radius 21 mm, all slices
* two bright spheres (300 HU), radius 5 mm and 4 mm, centres 18 mm apart
* an air tube along z with a focal narrowing (the airway, used by
  ``test_airway.py``)
* air everywhere outside the body

The store is kept entirely separate from the one in ``conftest.py`` -- the
``HNRAD_*`` environment variables are re-pointed per test with ``monkeypatch``
so neither suite can see the other's database whatever order they run in.
"""

from __future__ import annotations

import gzip
import math
import struct

import numpy as np
import pytest
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

# --------------------------------------------------------------------------
# the phantom
# --------------------------------------------------------------------------

NX = NY = 64
NZ = 40
DX = DY = 0.8            # column / row spacing, mm
DZ = 1.0                 # slice spacing, mm

AIR_HU = -1000.0
SOFT_HU = 40.0
BRIGHT_HU = 300.0
INTERCEPT = -1024.0

BODY_R = 21.0            # mm, soft-tissue cylinder

AIRWAY_X = -10.0         # mm, lumen centre (patient right of midline)
AIRWAY_Y = 0.0

# (x_mm, y_mm, k_centre, radius_mm)
SPHERE_A = (9.0, -9.0, 20, 5.0)
SPHERE_B = (9.0, 9.0, 20, 4.0)
SPHERE_GAP_MM = 18.0     # centre-to-centre

# Airway radius profile: 6 mm trachea, 2.5 mm subglottic stenosis, 6 mm again.
AIRWAY_PROFILE_K = [0, 14, 18, 21, 25, NZ - 1]
AIRWAY_PROFILE_R = [6.0, 6.0, 2.5, 2.5, 6.0, 6.0]
STENOSIS_K = (18, 21)

ORIGIN = (-(NX - 1) / 2.0 * DX, -(NY - 1) / 2.0 * DY, -10.0)

STUDY_UID = "1.2.826.0.1.3680043.10.1338.1"
SERIES_UID = "1.2.826.0.1.3680043.10.1338.2"
SOP_ROOT = "1.2.826.0.1.3680043.10.1338.3"
FOR_UID = "1.2.826.0.1.3680043.10.1338.9"


def airway_radius(k: float) -> float:
    return float(np.interp(k, AIRWAY_PROFILE_K, AIRWAY_PROFILE_R))


def _grids() -> tuple[np.ndarray, np.ndarray]:
    xs = (np.arange(NX) - (NX - 1) / 2.0) * DX
    ys = (np.arange(NY) - (NY - 1) / 2.0) * DY
    return np.meshgrid(xs, ys)          # (row j, col i)


def slice_hu(k: int) -> np.ndarray:
    """HU image for slice *k*, painted in the same order as the real phantom."""
    X, Y = _grids()
    img = np.full((NY, NX), AIR_HU, dtype=np.float64)
    img[(X ** 2 + Y ** 2) <= BODY_R ** 2] = SOFT_HU
    for cx, cy, kc, r in (SPHERE_A, SPHERE_B):
        dz = (k - kc) * DZ
        if abs(dz) <= r:
            img[((X - cx) ** 2 + (Y - cy) ** 2 + dz ** 2) <= r * r] = BRIGHT_HU
    r = airway_radius(k)
    img[((X - AIRWAY_X) ** 2 + (Y - AIRWAY_Y) ** 2) <= r * r] = AIR_HU
    return img


def mm_to_ij(x_mm: float, y_mm: float) -> tuple[int, int]:
    """Phantom millimetres -> (i = column, j = row)."""
    return (int(round(x_mm / DX + (NX - 1) / 2.0)),
            int(round(y_mm / DY + (NY - 1) / 2.0)))


def lps_of(i: float, j: float, k: float) -> tuple[float, float, float]:
    return (i * DX + ORIGIN[0], j * DY + ORIGIN[1], k * DZ + ORIGIN[2])


def write_series(out_dir) -> str:
    """Write the phantom as a DICOM series and return its SeriesInstanceUID."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for k in range(NZ):
        sop_uid = "{r}.{k}".format(r=SOP_ROOT, k=k + 1)

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
        ds.FrameOfReferenceUID = FOR_UID

        ds.PatientID = "SEG001"
        ds.PatientName = "SEG^PHANTOM"
        ds.PatientSex = "O"
        ds.PatientBirthDate = "19700101"

        ds.StudyDate = "20260917"
        ds.StudyTime = "130000"
        ds.StudyDescription = "CT NECK SEG PHANTOM"
        ds.SeriesDescription = "AXIAL SEG PHANTOM"
        ds.SeriesNumber = 3
        ds.BodyPartExamined = "NECK"
        ds.Modality = "CT"
        ds.InstanceNumber = k + 1

        ds.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
        ds.ImagePositionPatient = [ORIGIN[0], ORIGIN[1], ORIGIN[2] + k * DZ]
        ds.PixelSpacing = [DY, DX]              # [row, column]
        ds.SliceThickness = DZ
        ds.SpacingBetweenSlices = DZ

        ds.Rows = NY
        ds.Columns = NX
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 0
        ds.RescaleSlope = 1.0
        ds.RescaleIntercept = INTERCEPT

        stored = np.rint(slice_hu(k) - INTERCEPT).astype(np.uint16)
        ds.PixelData = stored.tobytes()
        ds.save_as(str(out_dir / "SEG{n:04d}".format(n=k + 1)),
                   enforce_file_format=True)
    return SERIES_UID


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------

@pytest.fixture(scope="session")
def seg_store(tmp_path_factory) -> dict:
    """An isolated data store holding only the segmentation phantom."""
    root = tmp_path_factory.mktemp("hnrad_seg")
    studies = root / "studies"
    series_uid = write_series(studies / "SEG_PHANTOM")
    return {
        "root": root,
        "studies": studies,
        "series_uid": series_uid,
        "env": {
            "HNRAD_DATA_ROOT": str(root),
            "HNRAD_STUDIES_ROOT": str(studies),
            "HNRAD_DB_PATH": str(root / "db" / "hnrad.sqlite"),
        },
        "imported": False,
    }


@pytest.fixture()
def seg_client(seg_store, monkeypatch):
    """A TestClient pointed at the segmentation store, for one test.

    ``monkeypatch`` puts the environment back afterwards, so the session-scoped
    fixtures in ``conftest.py`` keep their own database no matter which module
    pytest happens to run first.
    """
    from fastapi.testclient import TestClient

    from hnrad import config, db

    for key, value in seg_store["env"].items():
        monkeypatch.setenv(key, value)
    config.ensure_dirs()
    db.init_db()

    from hnrad.app import app

    client = TestClient(app)
    if not seg_store["imported"]:
        r = client.post("/api/import", json={"path": str(seg_store["studies"])})
        assert r.status_code == 200, r.text
        assert r.json()["instances"] == NZ
        seg_store["imported"] = True
    return client


@pytest.fixture()
def uid(seg_store) -> str:
    return seg_store["series_uid"]


def grow_sphere(client, series_uid, sphere, **kw) -> dict:
    """Region grow one of the bright spheres and return the response body."""
    cx, cy, kc, _r = sphere
    i, j = mm_to_ij(cx, cy)
    body = {
        "series_uid": series_uid,
        "seed_ijk": [i, j, kc],
        "lower_hu": 250.0,
        "upper_hu": 400.0,
        "max_radius_mm": 15.0,
    }
    body.update(kw)
    r = client.post("/api/analysis/region-grow", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------
# region grow
# --------------------------------------------------------------------------

def test_region_grow_volume_matches_the_analytic_sphere(seg_client, uid):
    out = grow_sphere(seg_client, uid, SPHERE_A)

    analytic_ml = 4.0 / 3.0 * math.pi * SPHERE_A[3] ** 3 / 1000.0
    assert out["volume_ml"] == pytest.approx(analytic_ml, rel=0.05)
    assert out["n_voxels"] == pytest.approx(
        analytic_ml * 1000.0 / (DX * DY * DZ), rel=0.05)

    # It grew the sphere and nothing else.
    assert out["mean_hu"] == pytest.approx(BRIGHT_HU, abs=0.5)
    assert out["std_hu"] == pytest.approx(0.0, abs=0.5)

    # PCA extents of a 10 mm sphere, within a voxel.
    for d in out["diameters_mm"]:
        assert 2 * SPHERE_A[3] - 1.5 <= d <= 2 * SPHERE_A[3] + 1.5
    assert out["longest_axis_mm"] == pytest.approx(2 * SPHERE_A[3], abs=1.5)

    cx, cy, kc, _r = SPHERE_A
    assert out["centroid_lps"] == pytest.approx(lps_of(*mm_to_ij(cx, cy), kc),
                                                abs=0.6)

    i0, j0, k0, i1, j1, k1 = out["bbox_ijk"]
    assert 0 < i0 < i1 < NX and 0 < j0 < j1 < NY and 0 < k0 < k1 < NZ
    assert out["took_ms"] > 0
    assert len(out["label_id"]) == 36


def test_region_grow_accepts_a_seed_in_patient_coordinates(seg_client, uid):
    cx, cy, kc, _r = SPHERE_B
    i, j = mm_to_ij(cx, cy)
    by_index = grow_sphere(seg_client, uid, SPHERE_B)
    r = seg_client.post("/api/analysis/region-grow", json={
        "series_uid": uid,
        "seed_lps": list(lps_of(i, j, kc)),
        "lower_hu": 250.0, "upper_hu": 400.0, "max_radius_mm": 15.0,
    })
    assert r.status_code == 200, r.text
    assert r.json()["n_voxels"] == by_index["n_voxels"]


def test_region_grow_radius_cap_stops_the_grow(seg_client, uid):
    """A 2 mm cap around the seed cannot return the whole 5 mm sphere."""
    capped = grow_sphere(seg_client, uid, SPHERE_A, max_radius_mm=2.0)
    full = grow_sphere(seg_client, uid, SPHERE_A)
    assert capped["n_voxels"] < full["n_voxels"]
    assert capped["longest_axis_mm"] < 2 * 2.0 + 2 * DX


def test_region_grow_rejects_bad_input(seg_client, uid):
    i, j = mm_to_ij(0.0, 15.0)                      # plain soft tissue
    r = seg_client.post("/api/analysis/region-grow", json={
        "series_uid": uid, "seed_ijk": [i, j, 20],
        "lower_hu": 250.0, "upper_hu": 400.0,
    })
    assert r.status_code == 400
    assert "seed HU" in r.json()["detail"]

    r = seg_client.post("/api/analysis/region-grow", json={
        "series_uid": uid, "seed_ijk": [999, 999, 999],
        "lower_hu": 250.0, "upper_hu": 400.0,
    })
    assert r.status_code == 400
    assert "outside the volume" in r.json()["detail"]

    r = seg_client.post("/api/analysis/region-grow", json={
        "series_uid": uid, "lower_hu": 250.0, "upper_hu": 400.0,
    })
    assert r.status_code == 400
    assert "seed_ijk" in r.json()["detail"]

    r = seg_client.post("/api/analysis/region-grow", json={
        "series_uid": "1.2.3.nope", "seed_ijk": [10, 10, 10],
        "lower_hu": 250.0, "upper_hu": 400.0,
    })
    assert r.status_code == 404


# --------------------------------------------------------------------------
# threshold
# --------------------------------------------------------------------------

def test_threshold_inside_body_excludes_the_air_around_the_patient(seg_client, uid):
    payload = {"series_uid": uid, "lower_hu": -1024.0, "upper_hu": -400.0,
               "min_component_ml": 0.0}

    inside = seg_client.post("/api/analysis/threshold",
                             json={**payload, "inside_body": True}).json()
    outside = seg_client.post("/api/analysis/threshold",
                              json={**payload, "inside_body": False}).json()

    # With the body mask the only air left is the airway lumen.
    analytic_voxels = sum(math.pi * airway_radius(k) ** 2
                          for k in range(NZ)) / (DX * DY)
    assert inside["n_voxels"] == pytest.approx(analytic_voxels, rel=0.05)

    # Without it, every voxel of room air comes too.
    assert outside["n_voxels"] > 10 * inside["n_voxels"]

    # ...and the body-masked label really does sit inside the body cylinder.
    i0, j0, _k0, i1, j1, _k1 = inside["bbox_ijk"]
    for i, j in ((i0, j0), (i1, j1)):
        x = (i - (NX - 1) / 2.0) * DX
        y = (j - (NY - 1) / 2.0) * DY
        assert math.hypot(x, y) < BODY_R


def test_threshold_keep_largest_and_min_component(seg_client, uid):
    both = seg_client.post("/api/analysis/threshold", json={
        "series_uid": uid, "lower_hu": 250.0, "upper_hu": 400.0,
        "inside_body": True, "keep_largest": False, "min_component_ml": 0.0,
    }).json()
    biggest = seg_client.post("/api/analysis/threshold", json={
        "series_uid": uid, "lower_hu": 250.0, "upper_hu": 400.0,
        "inside_body": True, "keep_largest": True,
    }).json()

    a_ml = 4.0 / 3.0 * math.pi * SPHERE_A[3] ** 3 / 1000.0
    b_ml = 4.0 / 3.0 * math.pi * SPHERE_B[3] ** 3 / 1000.0
    assert both["volume_ml"] == pytest.approx(a_ml + b_ml, rel=0.05)
    assert biggest["volume_ml"] == pytest.approx(a_ml, rel=0.05)

    # min_component_ml big enough to swallow the small sphere.
    culled = seg_client.post("/api/analysis/threshold", json={
        "series_uid": uid, "lower_hu": 250.0, "upper_hu": 400.0,
        "inside_body": True, "min_component_ml": 0.4,
    }).json()
    assert culled["volume_ml"] == pytest.approx(a_ml, rel=0.05)


def test_threshold_rejects_an_empty_band(seg_client, uid):
    r = seg_client.post("/api/analysis/threshold", json={
        "series_uid": uid, "lower_hu": 1500.0, "upper_hu": 2000.0,
    })
    assert r.status_code == 400
    r = seg_client.post("/api/analysis/threshold", json={
        "series_uid": uid, "lower_hu": 400.0, "upper_hu": 250.0,
    })
    assert r.status_code == 400


# --------------------------------------------------------------------------
# label export
# --------------------------------------------------------------------------

def test_label_mesh_is_a_parseable_binary_stl(seg_client, uid):
    label_id = grow_sphere(seg_client, uid, SPHERE_A)["label_id"]
    r = seg_client.get("/api/analysis/label/{i}/mesh?smooth_iters=10&step=1"
                       .format(i=label_id))
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/sla"
    assert label_id in r.headers["content-disposition"]

    blob = r.content
    n_tri = struct.unpack("<I", blob[80:84])[0]
    assert n_tri > 100
    assert len(blob) == 84 + 50 * n_tri

    rec = np.frombuffer(blob[84:], dtype=np.dtype([
        ("normal", "<f4", (3,)), ("verts", "<f4", (3, 3)), ("attr", "<u2"),
    ]))
    verts = rec["verts"].reshape(-1, 3)
    assert np.isfinite(verts).all()

    # A closed 10 mm sphere around the seed, in patient LPS millimetres.
    cx, cy, kc, r_mm = SPHERE_A
    centre = np.asarray(lps_of(*mm_to_ij(cx, cy), kc))
    radii = np.linalg.norm(verts - centre, axis=1)
    assert radii.max() < r_mm + 1.5
    assert radii.mean() == pytest.approx(r_mm, abs=1.0)


def test_label_mask_is_gzipped_with_the_geometry_headers(seg_client, uid):
    grown = grow_sphere(seg_client, uid, SPHERE_A)
    r = seg_client.get("/api/analysis/label/{i}/mask".format(i=grown["label_id"]))
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/gzip"
    assert r.headers["x-shape"] == "{z},{y},{x}".format(z=NZ, y=NY, x=NX)
    assert r.headers["x-spacing"] == "{z:g},{y:g},{x:g}".format(z=DZ, y=DY, x=DX)
    assert [float(v) for v in r.headers["x-origin"].split(",")] == pytest.approx(
        list(ORIGIN))
    assert [float(v) for v in r.headers["x-direction"].split(",")] == pytest.approx(
        [1, 0, 0, 0, 1, 0, 0, 0, 1])
    assert r.headers["x-label-id"] == grown["label_id"]

    raw = gzip.decompress(r.content)
    arr = np.frombuffer(raw, dtype=np.uint8).reshape((NZ, NY, NX))
    assert int(arr.sum()) == grown["n_voxels"]
    # The label sits where the sphere is.
    cx, cy, kc, _r = SPHERE_A
    i, j = mm_to_ij(cx, cy)
    assert arr[kc, j, i] == 1


def test_label_stats_delete_and_404(seg_client, uid):
    grown = grow_sphere(seg_client, uid, SPHERE_A)
    label_id = grown["label_id"]

    again = seg_client.get("/api/analysis/label/{i}/stats".format(i=label_id))
    assert again.status_code == 200
    for key in ("n_voxels", "volume_ml", "mean_hu", "diameters_mm",
                "centroid_lps", "bbox_ijk", "longest_axis_mm", "std_hu"):
        assert again.json()[key] == grown[key]

    assert seg_client.delete(
        "/api/analysis/label/{i}".format(i=label_id)).status_code == 200
    for path in ("/api/analysis/label/{i}/stats", "/api/analysis/label/{i}/mesh",
                 "/api/analysis/label/{i}/mask"):
        assert seg_client.get(path.format(i=label_id)).status_code == 404
    assert seg_client.delete(
        "/api/analysis/label/{i}".format(i=label_id)).status_code == 404


def test_label_store_is_an_lru(seg_client):
    from hnrad.segmentation import LabelStore

    store = LabelStore(capacity=3)
    ids = [store.put("s", np.ones((1, 1, 1), dtype=np.uint8)).label_id
           for _ in range(4)]
    assert len(store) == 3
    assert store.get(ids[0]) is None
    assert store.get(ids[3]) is not None


# --------------------------------------------------------------------------
# label-to-label distance
# --------------------------------------------------------------------------

def test_distance_between_two_spheres(seg_client, uid):
    a = grow_sphere(seg_client, uid, SPHERE_A)
    b = grow_sphere(seg_client, uid, SPHERE_B)

    r = seg_client.post("/api/analysis/distance",
                        json={"label_a": a["label_id"], "label_b": b["label_id"]})
    assert r.status_code == 200, r.text
    out = r.json()

    expected = SPHERE_GAP_MM - SPHERE_A[3] - SPHERE_B[3]
    voxel = max(DX, DY, DZ)
    assert out["min_distance_mm"] == pytest.approx(expected, abs=voxel)

    # The two reported points are that far apart, and each sits on its sphere.
    pa = np.asarray(out["point_a_lps"])
    pb = np.asarray(out["point_b_lps"])
    assert float(np.linalg.norm(pa - pb)) == pytest.approx(expected, abs=1.5 * voxel)
    for point, sphere in ((pa, SPHERE_A), (pb, SPHERE_B)):
        cx, cy, kc, rad = sphere
        centre = np.asarray(lps_of(*mm_to_ij(cx, cy), kc))
        assert float(np.linalg.norm(point - centre)) == pytest.approx(
            rad, abs=1.5 * voxel)


def test_distance_needs_two_known_labels(seg_client, uid):
    a = grow_sphere(seg_client, uid, SPHERE_A)
    r = seg_client.post("/api/analysis/distance",
                        json={"label_a": a["label_id"], "label_b": "nope"})
    assert r.status_code == 404
