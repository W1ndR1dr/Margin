"""End-to-end tests of the HNRad REST surface against a synthetic CT series."""

from __future__ import annotations

import io
import struct

import numpy as np
import pydicom
import pytest

from conftest import COL_MM, INTERCEPT, N_SLICES, ROW_MM, ROWS, SLICE_MM, SLOPE


# --------------------------------------------------------------------------
# health + import
# --------------------------------------------------------------------------

def test_health(client, store):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["version"] == "0.1.0"
    assert body["db_path"] == str(store["db_path"])
    assert body["studies_root"] == str(store["studies"])


def test_import_counts(client, store):
    res = store["import_result"]
    assert res["patients"] == 1
    assert res["studies"] == 1
    assert res["series"] == 1
    assert res["instances"] == N_SLICES
    # notes.txt, junkfile and DICOMDIR are all rejected.
    assert res["skipped"] == 3
    assert isinstance(res["seconds"], float)
    assert res["seconds"] >= 0.0


def test_import_is_idempotent(client, store):
    first = client.post("/api/import", json={"path": str(store["studies"])}).json()
    second = client.post("/api/import", json={"path": str(store["studies"])}).json()
    for key in ("patients", "studies", "series", "instances", "skipped"):
        assert first[key] == second[key]

    # And the library did not grow.
    studies = client.get("/api/studies").json()
    assert len(studies) == 1
    assert studies[0]["instance_count"] == N_SLICES


def test_import_unknown_path_is_404(client):
    r = client.post("/api/import", json={"path": r"C:\no\such\folder\hnrad"})
    assert r.status_code == 404
    assert "detail" in r.json()


# --------------------------------------------------------------------------
# library listings
# --------------------------------------------------------------------------

def test_patients(client):
    rows = client.get("/api/patients").json()
    assert len(rows) == 1
    p = rows[0]
    assert set(p) == {"patient_id", "name", "sex", "birth_date", "study_count"}
    assert p["patient_id"] == "TEST001"
    assert p["name"] == "TEST^SYNTH"
    assert p["study_count"] == 1


def test_studies(client, store):
    rows = client.get("/api/studies").json()
    assert len(rows) == 1
    s = rows[0]
    assert s["study_uid"] == store["study_uid"]
    assert s["patient_id"] == "TEST001"
    assert s["patient_name"] == "TEST^SYNTH"
    assert s["study_date"] == "20260917"
    assert s["description"] == "CT NECK (TEST)"
    assert s["accession"] == "ACC123"
    assert s["modalities"] == ["CT"]
    assert s["series_count"] == 1
    assert s["instance_count"] == N_SLICES

    filtered = client.get("/api/studies", params={"patient_id": "TEST001"}).json()
    assert filtered == rows
    assert client.get("/api/studies", params={"patient_id": "NOPE"}).json() == []


def test_study_series(client, store):
    rows = client.get(
        "/api/studies/{u}/series".format(u=store["study_uid"])).json()
    assert len(rows) == 1
    se = rows[0]
    assert se["series_uid"] == store["series_uid"]
    assert se["study_uid"] == store["study_uid"]
    assert se["series_number"] == 2
    assert se["modality"] == "CT"
    assert se["description"] == "AXIAL TEST"
    assert se["body_part"] == "NECK"
    assert se["instance_count"] == N_SLICES
    assert se["rows"] == ROWS
    assert se["cols"] == ROWS
    assert se["pixel_spacing"] == pytest.approx([ROW_MM, COL_MM])
    assert se["slice_thickness"] == pytest.approx(SLICE_MM)
    assert se["spacing_between_slices"] == pytest.approx(SLICE_MM)
    assert se["orientation"] == pytest.approx([1, 0, 0, 0, 1, 0])
    assert se["is_multiframe"] is False
    assert se["is_3d"] is True


def test_study_series_unknown_study(client):
    assert client.get("/api/studies/1.2.3.4/series").status_code == 404


def test_series_sort_order(client, store):
    body = client.get("/api/series/{u}".format(u=store["series_uid"])).json()
    assert body["series_uid"] == store["series_uid"]
    inst = body["instances"]
    assert len(inst) == N_SLICES

    positions = [i["slice_pos"] for i in inst]
    assert positions == sorted(positions)
    # normal is +z, so slice_pos == ipp_z == 5 + 2k
    assert positions == pytest.approx([5.0 + k * SLICE_MM for k in range(N_SLICES)])
    assert [i["instance_number"] for i in inst] == list(range(1, N_SLICES + 1))
    assert inst[0]["ipp"] == pytest.approx([-10.0, -20.0, 5.0])
    assert inst[0]["sop_uid"] == store["sop_uids"][0]


def test_series_unknown(client):
    assert client.get("/api/series/1.2.3.4").status_code == 404


# --------------------------------------------------------------------------
# instance bytes
# --------------------------------------------------------------------------

def test_instance_bytes_are_dicom(client, store):
    sop = store["sop_uids"][2]
    r = client.get("/api/instances/{u}".format(u=sop))
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/dicom"
    assert "max-age=31536000" in r.headers["cache-control"]

    data = r.content
    assert data[128:132] == b"DICM"
    ds = pydicom.dcmread(io.BytesIO(data))
    assert ds.SOPInstanceUID == sop
    assert ds.SeriesInstanceUID == store["series_uid"]
    assert ds.Rows == ROWS
    assert ds.pixel_array.shape == (ROWS, ROWS)


def test_instance_unknown(client):
    assert client.get("/api/instances/1.2.3.4").status_code == 404


# --------------------------------------------------------------------------
# thumbnail
# --------------------------------------------------------------------------

def test_thumbnail_is_png(client, store):
    r = client.get("/api/series/{u}/thumbnail".format(u=store["series_uid"]))
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    png = r.content
    assert png[:8] == b"\x89PNG\r\n\x1a\n"

    from PIL import Image

    img = Image.open(io.BytesIO(png))
    assert img.size == (128, 128)
    assert img.mode == "L"
    arr = np.asarray(img)
    # Soft-tissue window on air vs. tissue vs. bone -> genuinely varying pixels.
    assert arr.min() == 0
    assert arr.max() == 255


def test_thumbnail_unknown_series(client):
    assert client.get("/api/series/1.2.3.4/thumbnail").status_code == 404


# --------------------------------------------------------------------------
# ROI statistics
# --------------------------------------------------------------------------

def _reference_hu(client, sop_uid) -> np.ndarray:
    data = client.get("/api/instances/{u}".format(u=sop_uid)).content
    ds = pydicom.dcmread(io.BytesIO(data))
    return ds.pixel_array.astype(np.float64) * SLOPE + INTERCEPT


def test_roi_stats_match_numpy(client, store):
    k = 2
    sop = store["sop_uids"][k]
    # Axis-aligned square covering rows 6..9 and cols 6..9 inclusive.
    polygon = [[6, 6], [9, 6], [9, 9], [6, 9]]
    r = client.post("/api/analysis/roi-stats", json={
        "series_uid": store["series_uid"],
        "sop_uid": sop,
        "polygon": polygon,
    })
    assert r.status_code == 200, r.text
    stats = r.json()

    hu = _reference_hu(client, sop)
    patch = hu[6:10, 6:10]
    assert stats["n_voxels"] == patch.size == 16
    assert stats["mean_hu"] == pytest.approx(float(patch.mean()))
    assert stats["std_hu"] == pytest.approx(float(patch.std()))
    assert stats["min_hu"] == pytest.approx(float(patch.min()))
    assert stats["max_hu"] == pytest.approx(float(patch.max()))
    assert stats["area_mm2"] == pytest.approx(16 * ROW_MM * COL_MM)
    # The synthetic patch is flat at 60 + k HU.
    assert stats["mean_hu"] == pytest.approx(60.0 + k)
    assert stats["std_hu"] == pytest.approx(0.0)


def test_roi_stats_larger_region_matches_numpy(client, store):
    sop = store["sop_uids"][3]
    polygon = [[4, 4], [27, 4], [27, 27], [4, 27]]
    stats = client.post("/api/analysis/roi-stats", json={
        "series_uid": store["series_uid"],
        "sop_uid": sop,
        "polygon": polygon,
    }).json()

    hu = _reference_hu(client, sop)
    patch = hu[4:28, 4:28]
    assert stats["n_voxels"] == patch.size
    assert stats["mean_hu"] == pytest.approx(float(patch.mean()))
    assert stats["max_hu"] == pytest.approx(float(patch.max()))
    assert stats["min_hu"] == pytest.approx(float(patch.min()))


def test_roi_stats_bad_input(client, store):
    # Fewer than 3 points -> 422 from the request model.
    r = client.post("/api/analysis/roi-stats", json={
        "series_uid": store["series_uid"],
        "sop_uid": store["sop_uids"][0],
        "polygon": [[1, 1], [2, 2]],
    })
    assert r.status_code == 422

    # Unknown sop.
    r = client.post("/api/analysis/roi-stats", json={
        "series_uid": store["series_uid"],
        "sop_uid": "1.2.3.4",
        "polygon": [[1, 1], [2, 2], [3, 3]],
    })
    assert r.status_code == 404


# --------------------------------------------------------------------------
# isosurface / STL
# --------------------------------------------------------------------------

def _parse_stl(data: bytes) -> tuple[int, np.ndarray]:
    """Parse a binary STL, returning (n_triangles, vertices (n, 3, 3))."""
    assert len(data) >= 84
    n = struct.unpack("<I", data[80:84])[0]
    assert len(data) == 84 + 50 * n, (len(data), n)
    rec = np.frombuffer(
        data, offset=84, count=n,
        dtype=np.dtype([("normal", "<f4", (3,)),
                        ("verts", "<f4", (3, 3)),
                        ("attr", "<u2")]),
    )
    return n, rec["verts"]


def test_isosurface_stl(client, store):
    r = client.post("/api/analysis/isosurface", json={
        "series_uid": store["series_uid"],
        "lower_hu": 300,
    })
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/sla"
    disp = r.headers["content-disposition"]
    assert disp.startswith("attachment; filename=")
    assert store["series_uid"] in disp
    assert "300HU.stl" in disp

    n, verts = _parse_stl(r.content)
    assert n > 0
    assert np.isfinite(verts).all()

    # The bone cube sits at rows/cols 10..21 and slices 2..4, so in patient LPS
    # coordinates it must land inside the bounds of the imaged volume.
    flat = verts.reshape(-1, 3)
    assert flat[:, 0].min() >= -10.0 - 1e-3          # x = ipp_x + col*0.6
    assert flat[:, 0].max() <= -10.0 + 32 * COL_MM
    assert flat[:, 1].min() >= -20.0 - 1e-3          # y = ipp_y + row*0.8
    assert flat[:, 1].max() <= -20.0 + 32 * ROW_MM
    assert flat[:, 2].min() >= 5.0 - 1e-3            # z = ipp_z + slice*2.0
    assert flat[:, 2].max() <= 5.0 + N_SLICES * SLICE_MM


def test_isosurface_with_band_step_and_smoothing(client, store):
    r = client.post("/api/analysis/isosurface", json={
        "series_uid": store["series_uid"],
        "lower_hu": 300,
        "upper_hu": 1500,
        "step": 1,
        "smooth_iters": 3,
    })
    assert r.status_code == 200, r.text
    n, verts = _parse_stl(r.content)
    assert n > 0
    assert np.isfinite(verts).all()


def test_isosurface_bad_requests(client, store):
    assert client.post("/api/analysis/isosurface", json={
        "series_uid": "1.2.3.4", "lower_hu": 300,
    }).status_code == 404

    # Threshold above everything in the volume.
    r = client.post("/api/analysis/isosurface", json={
        "series_uid": store["series_uid"], "lower_hu": 99999,
    })
    assert r.status_code == 400
    assert "detail" in r.json()

    # upper below lower.
    r = client.post("/api/analysis/isosurface", json={
        "series_uid": store["series_uid"], "lower_hu": 300, "upper_hu": 100,
    })
    assert r.status_code == 400

    # step must be 1 or 2.
    r = client.post("/api/analysis/isosurface", json={
        "series_uid": store["series_uid"], "lower_hu": 300, "step": 5,
    })
    assert r.status_code == 400


# --------------------------------------------------------------------------
# internals worth pinning down
# --------------------------------------------------------------------------

def test_volume_cache_is_lru_of_two(client, store):
    from hnrad import analysis, config, db

    analysis.clear_caches()
    with db.connect() as conn:
        rows = db.get_series_instances(conn, store["series_uid"])
    vol = analysis.load_series_volume(store["series_uid"], rows)
    again = analysis.load_series_volume(store["series_uid"], rows)
    assert again is vol                      # served from cache, not re-read
    assert vol.hu.dtype == np.float32
    assert vol.shape == (N_SLICES, ROWS, ROWS)
    assert vol.spacing == pytest.approx((SLICE_MM, ROW_MM, COL_MM))
    assert config.VOLUME_CACHE_SIZE == 2
    assert len(analysis._volume_cache) == 1


def test_cors_headers(client):
    r = client.get("/api/health", headers={"Origin": "http://127.0.0.1:5173"})
    assert r.headers.get("access-control-allow-origin") == "http://127.0.0.1:5173"
    r = client.get("/api/health", headers={"Origin": "http://localhost:5173"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"


def test_looks_like_dicom(store, tmp_path):
    from hnrad.indexer import looks_like_dicom

    good = next(p for p in (store["studies"] / "TEST_SERIES").iterdir())
    assert looks_like_dicom(good) is True

    junk = tmp_path / "junk.bin"
    junk.write_bytes(b"\xff" * 400)
    assert looks_like_dicom(junk) is False

    tiny = tmp_path / "tiny"
    tiny.write_bytes(b"ab")
    assert looks_like_dicom(tiny) is False
