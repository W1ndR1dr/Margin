"""Registration: known-shift recovery, the transform algebra and the routes.

The load-bearing test is :func:`test_rigid_recovers_a_known_shift`: a phantom
translated by ``[4, -3, 2]`` mm has to come back within 0.5 mm.  Everything
else -- caching, persistence, point mapping, label warping -- is bookkeeping
around that one number, and bookkeeping is exactly where a registration module
goes quietly wrong.
"""

from __future__ import annotations

import numpy as np
import pytest

from hnrad import registration as R
from hnrad.analysis import SeriesVolume

SHIFT = np.array([4.0, -3.0, 2.0])          # mm, LPS
TOL_MM = 0.5

N = 64
SPACING_MM = 1.0


# --------------------------------------------------------------------------
# phantom helpers
# --------------------------------------------------------------------------

def _phantom(n: int = N) -> np.ndarray:
    """A small asymmetric HU phantom: soft tissue, two bones, an air lumen."""
    z, y, x = np.mgrid[0:n, 0:n, 0:n].astype(np.float32)
    a = np.full((n, n, n), -1000.0, np.float32)
    r = np.sqrt((x - n / 2) ** 2 + (y - n / 2) ** 2 + (z - n / 2) ** 2)
    a[r < n * 0.35] = 40.0
    a[(np.abs(x - n * 0.35) < 4) & (np.abs(y - n * 0.45) < 4)
      & (np.abs(z - n / 2) < 12)] = 900.0
    a[(np.abs(x - n * 0.62) < 3) & (np.abs(y - n * 0.60) < 6)
      & (np.abs(z - n / 2) < 8)] = 300.0
    a[(x - n * 0.50) ** 2 + (y - n * 0.30) ** 2 < 25] = -900.0
    return a


def _volume(arr: np.ndarray, uid: str, origin=(0.0, 0.0, 0.0)) -> SeriesVolume:
    return SeriesVolume(
        series_uid=uid,
        hu=np.ascontiguousarray(arr, dtype=np.float32),
        spacing=(SPACING_MM, SPACING_MM, SPACING_MM),
        origin=np.asarray(origin, dtype=np.float64),
        row_dir=np.array([1.0, 0.0, 0.0]),
        col_dir=np.array([0.0, 1.0, 0.0]),
        slice_dir=np.array([0.0, 0.0, 1.0]),
        sop_uids=[], positions=[],
    )


@pytest.fixture(scope="module")
def pair(store):
    """A fixed phantom and the same phantom translated by SHIFT millimetres."""
    import SimpleITK as sitk

    base = _phantom()
    fixed = _volume(base, "PHANTOM.FIXED")
    f_img = R.patient_image(fixed)
    # Move the *content* by +SHIFT: resampling with -SHIFT pulls each voxel's
    # value from the position SHIFT behind it.
    tx = sitk.TranslationTransform(3, [float(-v) for v in SHIFT])
    moved = sitk.Resample(f_img, f_img, tx, sitk.sitkLinear, -1000.0)
    moving = _volume(sitk.GetArrayFromImage(moved), "PHANTOM.MOVING")
    return fixed, moving


def _register(pair, **kw):
    fixed, moving = pair
    kw.setdefault("mode", "rigid")
    kw.setdefault("mask", None)
    kw.setdefault("resample_mm", SPACING_MM)
    return R.register(
        fixed.series_uid, moving.series_uid,
        fixed=(fixed, "CT"), moving=(moving, "CT"), **kw)


def _max_point_error(reg, expected=SHIFT) -> float:
    """Worst error, in mm, of the transform against a pure translation.

    Evaluated at the corners of the phantom rather than at the origin, so a
    residual rotation or scale shows up instead of cancelling.
    """
    m = np.asarray(reg.transform_4x4, dtype=np.float64)
    probe = np.array([[0.0, 0.0, 0.0], [10.0, 20.0, 30.0],
                      [40.0, 5.0, 12.0], [63.0, 63.0, 63.0]])
    mapped = probe @ m[:3, :3].T + m[:3, 3]
    return float(np.abs((mapped - probe) - np.asarray(expected)).max())


def _rotation_deg(reg) -> float:
    m = np.asarray(reg.transform_4x4, dtype=np.float64)[:3, :3]
    return float(np.degrees(np.arccos(np.clip((np.trace(m) - 1.0) / 2.0, -1, 1))))


# --------------------------------------------------------------------------
# the headline: a known shift comes back
# --------------------------------------------------------------------------

def test_rigid_recovers_a_known_shift(pair):
    reg, cached = _register(pair, mode="rigid")
    assert cached is False
    assert reg.transform_4x4 is not None
    err = _max_point_error(reg)
    assert err < TOL_MM, "recovered shift is off by {e:.3f} mm".format(e=err)
    # A pure translation: no rotation should have been invented.
    assert _rotation_deg(reg) < 0.1
    assert np.asarray(reg.transform_4x4)[3].tolist() == [0.0, 0.0, 0.0, 1.0]


def test_affine_recovers_the_same_shift(pair):
    reg, _cached = _register(pair, mode="affine")
    assert _max_point_error(reg) < TOL_MM


def test_bspline_reports_no_4x4_but_still_scores_itself(pair):
    reg, _cached = _register(pair, mode="bspline")
    # A free-form deformation is not a linear map, so there is no 4x4 ...
    assert reg.transform_4x4 is None
    # ... but the quality report still has to say whether it worked, which it
    # does from the image elastix resampled onto the fixed grid.
    assert reg.quality["nmi_after"] > reg.quality["nmi_before"]
    assert reg.quality["dice_body_after"] > reg.quality["dice_body_before"]
    # rigid stage + B-spline stage, chained by elastix itself.
    assert reg.param_object.GetNumberOfParameterMaps() == 2


def test_bspline_refuses_to_transform_points(pair):
    reg, _cached = _register(pair, mode="bspline")
    with pytest.raises(R.RegistrationError):
        R.transform_points(reg, [[0.0, 0.0, 0.0]])


def test_registration_improves_the_similarity_metrics(pair):
    reg, _cached = _register(pair, mode="rigid")
    q = reg.quality
    assert q["metric"] == "normalized_mutual_information"
    assert q["nmi_after"] > q["nmi_before"]
    assert q["nmi_gain"] > 0
    assert q["final_metric"] == q["nmi_after"]
    # Both series are CT, so the bone MSD term is populated and collapses.
    assert q["msd_bone_after"] < q["msd_bone_before"]
    assert q["dice_body_after"] > q["dice_body_before"]
    assert q["dice_body_after"] > 0.95
    assert q["engine"] in ("itk-elastix", "simpleitk")
    assert set(q["timings_ms"]) == {"load", "prepare", "optimise"}


# A metric mask makes the fit noisier -- it throws away most of the image --
# so these get the 0.5 mm budget rather than the sub-0.01 mm the unmasked fit
# actually achieves.  Measured on this phantom: 0.19 mm (bone), 0.25 mm (body).
@pytest.mark.parametrize("mask", ["bone", "body"])
def test_masked_rigid_also_recovers_the_shift(pair, mask):
    reg, _cached = _register(pair, mask=mask)
    assert reg.mask == mask
    assert _max_point_error(reg) < TOL_MM
    assert _rotation_deg(reg) < 1.0


# --------------------------------------------------------------------------
# caching and persistence
# --------------------------------------------------------------------------

def test_second_identical_request_is_served_from_cache(pair):
    first, cached_first = _register(pair, mode="rigid")
    second, cached_second = _register(pair, mode="rigid")
    assert cached_second is True
    assert second.registration_id == first.registration_id
    assert second.transform_4x4 == first.transform_4x4


def test_force_recomputes(pair):
    first, _c = _register(pair, mode="rigid")
    again, cached = _register(pair, mode="rigid", force=True)
    assert cached is False
    assert again.registration_id == first.registration_id


def test_a_different_mode_is_a_different_registration(pair):
    rigid, _a = _register(pair, mode="rigid")
    affine, _b = _register(pair, mode="affine")
    assert rigid.registration_id != affine.registration_id


def test_result_and_parameter_files_are_written(pair):
    reg, _cached = _register(pair, mode="rigid")
    root = R.registrations_root()
    names = {p.name for p in root.iterdir()}
    assert any(n.endswith(".json") for n in names)
    assert reg.json_path and ".rigid.json" in reg.json_path
    if reg.engine == "itk-elastix":
        assert reg.param_path and ".rigid.txt" in reg.param_path
        text = (root / reg.param_path.rsplit("\\", 1)[-1]).read_text(
            encoding="utf-8")
        assert "Transform" in text


def test_get_finds_a_registration_after_the_memory_cache_is_dropped(pair):
    reg, _cached = _register(pair, mode="rigid")
    R.clear_caches()
    again = R.get(reg.registration_id)
    assert again is not None
    assert again.registration_id == reg.registration_id
    assert np.allclose(np.asarray(again.transform_4x4),
                       np.asarray(reg.transform_4x4))


def test_get_unknown_id_is_none(store):
    assert R.get("0" * 16) is None


# --------------------------------------------------------------------------
# point transformation
# --------------------------------------------------------------------------

def test_transform_points_matches_the_matrix(pair):
    reg, _cached = _register(pair, mode="rigid")
    pts = [[0.0, 0.0, 0.0], [10.0, -5.0, 22.0]]
    out = R.transform_points(reg, pts, "fixed_to_moving")
    assert len(out) == 2
    for p, q in zip(pts, out):
        assert np.allclose(np.asarray(q) - np.asarray(p), SHIFT, atol=TOL_MM)


def test_transform_points_round_trips(pair):
    reg, _cached = _register(pair, mode="rigid")
    pts = [[3.0, 14.0, 1.0], [-20.0, 7.0, 40.0]]
    there = R.transform_points(reg, pts, "fixed_to_moving")
    back = R.transform_points(reg, there, "moving_to_fixed")
    assert np.allclose(np.asarray(back), np.asarray(pts), atol=1e-6)


def test_transform_points_rejects_a_bad_direction(pair):
    reg, _cached = _register(pair, mode="rigid")
    with pytest.raises(R.RegistrationError):
        R.transform_points(reg, [[0, 0, 0]], "sideways")


def test_transform_points_rejects_bad_geometry(pair):
    reg, _cached = _register(pair, mode="rigid")
    with pytest.raises(R.RegistrationError):
        R.transform_points(reg, [[0, 0]], "fixed_to_moving")


# --------------------------------------------------------------------------
# input validation
# --------------------------------------------------------------------------

@pytest.mark.parametrize("kwargs", [
    {"mode": "elastic"},
    {"mask": "teeth"},
    {"resample_mm": 0.0},
    {"resample_mm": 50.0},
])
def test_bad_input_raises(pair, kwargs):
    with pytest.raises(R.RegistrationError):
        _register(pair, **kwargs)


def test_fixed_and_moving_must_differ(pair):
    fixed, _moving = pair
    with pytest.raises(R.RegistrationError):
        R.register(fixed.series_uid, fixed.series_uid,
                   fixed=(fixed, "CT"), moving=(fixed, "CT"))


def test_unknown_series_raises(store):
    with pytest.raises(R.RegistrationError):
        R.register("no.such.series.1", "no.such.series.2")


# --------------------------------------------------------------------------
# metric helpers
# --------------------------------------------------------------------------

def test_nmi_is_higher_for_an_aligned_pair():
    rng = np.random.default_rng(3)
    a = rng.normal(size=(24, 24, 24)).astype(np.float32)
    same = R.normalized_mutual_information(a, a)
    other = R.normalized_mutual_information(a, rng.normal(size=a.shape))
    assert same > other
    assert other == pytest.approx(1.0, abs=0.35)


def test_nmi_ignores_non_finite_voxels():
    a = np.arange(1000, dtype=np.float32).reshape(10, 10, 10)
    b = a.copy()
    b[0, 0, 0] = np.nan
    assert np.isfinite(R.normalized_mutual_information(a, b))


def test_dice_edges():
    a = np.zeros((4, 4), bool)
    a[:2] = True
    assert R.dice(a, a) == pytest.approx(1.0)
    assert R.dice(a, ~a) == pytest.approx(0.0)
    assert np.isnan(R.dice(np.zeros((4, 4), bool), np.zeros((4, 4), bool)))


def test_patient_image_direction_is_orthonormal():
    vol = _volume(_phantom(16), "X")
    vol.slice_dir = np.array([0.02, -0.01, 0.999])      # slightly off
    img = R.patient_image(vol)
    d = np.asarray(img.GetDirection()).reshape(3, 3)
    assert np.allclose(d.T @ d, np.eye(3), atol=1e-9)
    assert np.allclose(np.asarray(img.GetOrigin()), vol.origin)


# --------------------------------------------------------------------------
# the routes, against two real DICOM series in the isolated store
# --------------------------------------------------------------------------

REG_STUDY_UID = "1.2.826.0.1.3680043.10.1337.700"
REG_FIXED_UID = "1.2.826.0.1.3680043.10.1337.701"
REG_MOVING_UID = "1.2.826.0.1.3680043.10.1337.702"
REG_N = 40
REG_XY = 48


def _write_phantom_series(out_dir, series_uid, series_number, origin_shift,
                          modality="CT", description="PHANTOM AX"):
    """Write a small axial series; *origin_shift* moves it in LPS millimetres."""
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

    out_dir.mkdir(parents=True, exist_ok=True)
    arr = _phantom(REG_XY)[:REG_N]
    stored = np.rint(arr + 1024.0).clip(0, 4095).astype(np.uint16)

    for k in range(REG_N):
        sop_uid = "{s}.{k}".format(s=series_uid, k=k + 1)
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
        ds.StudyInstanceUID = REG_STUDY_UID
        ds.SeriesInstanceUID = series_uid
        ds.FrameOfReferenceUID = "{s}.9".format(s=series_uid)
        ds.PatientID = "REGPHANTOM"
        ds.PatientName = "REG^PHANTOM"
        ds.StudyDate = "20260917"
        ds.StudyDescription = "REGISTRATION PHANTOM"
        ds.SeriesDescription = description
        ds.SeriesNumber = series_number
        ds.Modality = modality
        ds.InstanceNumber = k + 1
        ds.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
        ds.ImagePositionPatient = [
            0.0 + origin_shift[0], 0.0 + origin_shift[1],
            float(k) * SPACING_MM + origin_shift[2],
        ]
        ds.PixelSpacing = [SPACING_MM, SPACING_MM]
        ds.SliceThickness = SPACING_MM
        ds.SpacingBetweenSlices = SPACING_MM
        ds.Rows = REG_XY
        ds.Columns = REG_XY
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 0
        ds.RescaleSlope = 1.0
        ds.RescaleIntercept = -1024.0
        ds.PixelData = stored[k].tobytes()
        ds.save_as(str(out_dir / "IM{n:04d}".format(n=k)),
                   enforce_file_format=True)


@pytest.fixture(scope="module")
def api_pair(client, store):
    """Two real DICOM series in the store: identical content, offset by SHIFT.

    Because the pixels are identical and only ImagePositionPatient moves, the
    exact fixed->moving transform is a pure translation by SHIFT -- there is no
    interpolation anywhere in the ground truth.
    """
    root = store["studies"] / "REG_PHANTOM"
    _write_phantom_series(root / "fixed", REG_FIXED_UID, 10, (0.0, 0.0, 0.0))
    _write_phantom_series(root / "moving", REG_MOVING_UID, 11, SHIFT)
    r = client.post("/api/import", json={"path": str(root)})
    assert r.status_code == 200, r.text
    return {"fixed": REG_FIXED_UID, "moving": REG_MOVING_UID}


@pytest.fixture(scope="module")
def api_reg(client, api_pair):
    r = client.post("/api/registration", json={
        "fixed_series_uid": api_pair["fixed"],
        "moving_series_uid": api_pair["moving"],
        "mode": "rigid",
        "mask": "bone",
        "resample_mm": SPACING_MM,
    })
    assert r.status_code == 200, r.text
    return r.json()


def test_post_registration_returns_the_contract_shape(api_reg):
    for key in ("registration_id", "fixed_series_uid", "moving_series_uid",
                "mode", "mask", "engine", "transform_4x4", "quality",
                "took_ms", "cached"):
        assert key in api_reg, key
    assert api_reg["mode"] == "rigid"
    assert len(api_reg["transform_4x4"]) == 4


def test_post_registration_recovers_the_ipp_offset(api_reg):
    m = np.asarray(api_reg["transform_4x4"], dtype=np.float64)
    assert np.allclose(m[:3, 3], SHIFT, atol=TOL_MM)
    angle = np.degrees(np.arccos(np.clip((np.trace(m[:3, :3]) - 1) / 2, -1, 1)))
    assert angle < 1.0


def test_get_registration(client, api_reg):
    r = client.get("/api/registration/{i}".format(i=api_reg["registration_id"]))
    assert r.status_code == 200, r.text
    assert r.json()["registration_id"] == api_reg["registration_id"]
    assert r.json()["cached"] is True


def test_get_registration_unknown_is_404(client):
    assert client.get("/api/registration/deadbeefdeadbeef").status_code == 404


def test_post_registration_unknown_series_is_404(client, api_pair):
    r = client.post("/api/registration", json={
        "fixed_series_uid": api_pair["fixed"],
        "moving_series_uid": "1.2.3.4.5",
    })
    assert r.status_code == 404


def test_post_registration_bad_mode_is_400(client, api_pair):
    r = client.post("/api/registration", json={
        "fixed_series_uid": api_pair["fixed"],
        "moving_series_uid": api_pair["moving"],
        "mode": "warp-drive",
    })
    assert r.status_code == 400


def test_registration_is_cached_across_requests(client, api_pair, api_reg):
    r = client.post("/api/registration", json={
        "fixed_series_uid": api_pair["fixed"],
        "moving_series_uid": api_pair["moving"],
        "mode": "rigid",
        "mask": "bone",
        "resample_mm": SPACING_MM,
    })
    assert r.status_code == 200
    assert r.json()["cached"] is True
    assert r.json()["registration_id"] == api_reg["registration_id"]


def test_transform_points_route(client, api_reg):
    r = client.post(
        "/api/registration/{i}/transform-points".format(
            i=api_reg["registration_id"]),
        json={"points_lps": [[0.0, 0.0, 0.0], [12.0, 8.0, 20.0]]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["direction"] == "fixed_to_moving"
    got = np.asarray(body["points_lps"])
    assert np.allclose(got[0], SHIFT, atol=TOL_MM)
    assert np.allclose(got[1] - np.array([12.0, 8.0, 20.0]), SHIFT, atol=TOL_MM)


def test_resample_moving_volume(client, api_reg):
    r = client.post(
        "/api/registration/{i}/resample".format(i=api_reg["registration_id"]),
        json={"series": "moving"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["series"] == "moving"
    assert body["shape"] == [REG_N, REG_XY, REG_XY]


def test_resample_warps_a_label_into_the_fixed_frame(client, api_reg, api_pair):
    # A bone label on the *moving* series ...
    grow = client.post("/api/analysis/threshold", json={
        "series_uid": api_pair["moving"],
        "lower_hu": 200.0, "upper_hu": 3000.0,
        "inside_body": False, "keep_largest": True,
    })
    assert grow.status_code == 200, grow.text
    moving_label = grow.json()

    warped = client.post(
        "/api/registration/{i}/resample".format(i=api_reg["registration_id"]),
        json={"label_id": moving_label["label_id"]})
    assert warped.status_code == 200, warped.text
    body = warped.json()
    assert body["series_uid"] == api_pair["fixed"]
    assert body["source_label_id"] == moving_label["label_id"]
    assert body["n_voxels"] > 0

    # The warped label has to land on the fixed series' own bone.
    fixed_bone = client.post("/api/analysis/threshold", json={
        "series_uid": api_pair["fixed"],
        "lower_hu": 200.0, "upper_hu": 3000.0,
        "inside_body": False, "keep_largest": True,
    }).json()
    d = client.post("/api/analysis/distance", json={
        "label_a": body["label_id"], "label_b": fixed_bone["label_id"]})
    assert d.status_code == 200, d.text
    # Overlapping labels report a negative (or ~zero) minimum distance.
    assert d.json()["min_distance_mm"] <= 1.0

    # And the centroid must have moved back by SHIFT relative to the moving one.
    moved = np.asarray(body["centroid_lps"]) - np.asarray(
        moving_label["centroid_lps"])
    assert np.allclose(moved, -SHIFT, atol=1.5)


def test_resample_rejects_a_label_from_the_wrong_series(client, api_reg,
                                                       api_pair, store):
    other = client.post("/api/analysis/threshold", json={
        "series_uid": api_pair["fixed"],
        "lower_hu": 200.0, "upper_hu": 3000.0,
        "inside_body": False, "keep_largest": True,
    }).json()
    r = client.post(
        "/api/registration/{i}/resample".format(i=api_reg["registration_id"]),
        json={"label_id": other["label_id"]})
    assert r.status_code == 400


def test_moving_slice_is_a_png(client, api_reg):
    r = client.get("/api/registration/{i}/moving-slice?k=20".format(
        i=api_reg["registration_id"]))
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/png"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert "X-Window-Lower" in r.headers


def test_moving_slice_out_of_range_is_400(client, api_reg):
    r = client.get("/api/registration/{i}/moving-slice?k=9999".format(
        i=api_reg["registration_id"]))
    assert r.status_code == 400


def test_moving_slice_unknown_registration_is_404(client):
    assert client.get(
        "/api/registration/deadbeefdeadbeef/moving-slice?k=0").status_code == 404


# --------------------------------------------------------------------------
# the B-spline route, which resamples through transformix rather than a 4x4
# --------------------------------------------------------------------------

@pytest.fixture(scope="module")
def api_bspline(client, api_pair):
    r = client.post("/api/registration", json={
        "fixed_series_uid": api_pair["fixed"],
        "moving_series_uid": api_pair["moving"],
        "mode": "bspline",
        "mask": None,
        "resample_mm": SPACING_MM,
    })
    assert r.status_code == 200, r.text
    return r.json()


def test_bspline_route_reports_no_transform(api_bspline):
    assert api_bspline["mode"] == "bspline"
    assert api_bspline["transform_4x4"] is None
    assert api_bspline["quality"]["nmi_after"] >= api_bspline["quality"]["nmi_before"]


def test_bspline_transform_points_is_400(client, api_bspline):
    r = client.post(
        "/api/registration/{i}/transform-points".format(
            i=api_bspline["registration_id"]),
        json={"points_lps": [[0.0, 0.0, 0.0]]})
    assert r.status_code == 400


def test_bspline_resample_goes_through_transformix(client, api_bspline):
    r = client.post(
        "/api/registration/{i}/resample".format(
            i=api_bspline["registration_id"]),
        json={"series": "moving"})
    assert r.status_code == 200, r.text
    assert r.json()["shape"] == [REG_N, REG_XY, REG_XY]

    png = client.get("/api/registration/{i}/moving-slice?k=20".format(
        i=api_bspline["registration_id"]))
    assert png.status_code == 200, png.text
    assert png.content[:8] == b"\x89PNG\r\n\x1a\n"
