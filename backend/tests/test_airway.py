"""Airway analyser (Analysis API v0.2, TOOLS-SPEC section 4).

Runs against the same purpose-made 64 x 64 x 40 phantom as
``test_segmentation.py``: a 6 mm radius air tube with a focal narrowing to
2.5 mm over slices 18..21, so the true area stenosis is

    1 - (2.5 / 6.0) ** 2 = 82.6 %

which is squarely a Myer-Cotton grade III.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

# The fixtures and the phantom live with the segmentation tests; importing the
# fixture functions into this module's namespace is enough for pytest to find
# them by name.
from test_segmentation import (  # noqa: F401  (fixtures are used by name)
    AIRWAY_X,
    AIRWAY_Y,
    DZ,
    LUNG_K,
    NZ,
    ORIGIN,
    STENOSIS_K,
    airway_radius,
    mm_to_ij,
    seg_client,
    seg_store,
    uid,
    write_series,
)

SEED_K = 5                                  # well inside the wide trachea
REF_RADIUS = 6.0
MIN_RADIUS = 2.5
ANALYTIC_PCT = 100.0 * (1.0 - (MIN_RADIUS / REF_RADIUS) ** 2)


def _seed() -> list[int]:
    i, j = mm_to_ij(AIRWAY_X, AIRWAY_Y)
    return [i, j, SEED_K]


def k_of_lps(lps) -> float:
    """Slice index of an LPS point in this (axial, +z = +k) phantom."""
    return (lps[2] - ORIGIN[2]) / DZ


@pytest.fixture()
def lung_uid(seg_client, seg_store) -> str:
    """The same phantom with a wide air blob swallowing the bottom of the tube.

    It lives in its own folder beside the store's ``studies`` tree, so the
    import the ``seg_client`` fixture does still sees exactly one series.
    """
    if "lung_series_uid" not in seg_store:
        folder = seg_store["root"] / "lung_phantom"
        seg_store["lung_series_uid"] = write_series(folder, lung=True)
        r = seg_client.post("/api/import", json={"path": str(folder)})
        assert r.status_code == 200, r.text
        assert r.json()["instances"] == NZ
    return seg_store["lung_series_uid"]


@pytest.fixture()
def profile(seg_client, uid) -> dict:
    r = seg_client.post("/api/analysis/airway", json={
        "series_uid": uid, "seed_ijk": _seed(),
        "lower_hu": -1024.0, "upper_hu": -400.0,
    })
    assert r.status_code == 200, r.text
    return r.json()


def test_airway_reports_the_narrowing(profile):
    assert profile["stenosis_pct"] == pytest.approx(ANALYTIC_PCT, abs=8.0)
    assert profile["myer_cotton_grade"] == "III"

    # The minimum is at the right level.
    k_min = k_of_lps(profile["min_csa_lps"])
    assert STENOSIS_K[0] - 1 <= k_min <= STENOSIS_K[1] + 1
    assert profile["csa_mm2"][profile["min_csa_index"]] == profile["min_csa_mm2"]

    # ...and the areas themselves are right.
    assert profile["csa_ref_mm2"] == pytest.approx(math.pi * REF_RADIUS ** 2,
                                                   rel=0.10)
    assert profile["min_csa_mm2"] == pytest.approx(math.pi * MIN_RADIUS ** 2,
                                                   rel=0.15)

    # The stenotic segment is a few millimetres long, not the whole airway.
    assert 3.0 < profile["stenosis_length_mm"] < 20.0


def test_airway_profile_arrays_are_consistent(profile):
    n = len(profile["csa_mm2"])
    assert n >= NZ - 4                       # the tube spans the whole volume
    for key in ("centerline_lps", "arclength_mm", "eq_diameter_mm",
                "min_diameter_mm", "max_diameter_mm"):
        assert len(profile[key]) == n

    arclen = np.asarray(profile["arclength_mm"])
    assert arclen[0] == 0.0
    assert np.all(np.diff(arclen) > 0)
    assert arclen[-1] == pytest.approx((n - 1) * DZ, rel=0.05)

    # Sample 0 is the most inferior point of the airway.
    zs = [p[2] for p in profile["centerline_lps"]]
    assert zs[0] < zs[-1]

    # Equivalent diameter agrees with the area, and tracks the painted radius.
    csa = np.asarray(profile["csa_mm2"])
    eq = np.asarray(profile["eq_diameter_mm"])
    assert eq == pytest.approx(2.0 * np.sqrt(csa / math.pi), rel=1e-9)

    for idx in (0, n - 1):
        k = int(round(k_of_lps(profile["centerline_lps"][idx])))
        assert eq[idx] == pytest.approx(2.0 * airway_radius(k), abs=0.6)

    # A round lumen: the PCA diameters bracket the equivalent diameter.
    dmin = np.asarray(profile["min_diameter_mm"])
    dmax = np.asarray(profile["max_diameter_mm"])
    assert np.all(dmin <= dmax + 1e-9)
    assert dmin[0] == pytest.approx(2.0 * REF_RADIUS, abs=1.0)
    assert dmax[0] == pytest.approx(2.0 * REF_RADIUS, abs=1.0)

    # The centreline sits on the painted lumen axis.
    xs = np.asarray([p[0] for p in profile["centerline_lps"]])
    ys = np.asarray([p[1] for p in profile["centerline_lps"]])
    assert np.abs(xs - AIRWAY_X).max() < 1.0
    assert np.abs(ys - AIRWAY_Y).max() < 1.0


def test_airway_label_is_stored_and_measurable(seg_client, profile):
    label_id = profile["label_id"]
    stats = seg_client.get("/api/analysis/label/{i}/stats".format(i=label_id))
    assert stats.status_code == 200
    body = stats.json()

    analytic_ml = sum(math.pi * airway_radius(k) ** 2 * DZ
                      for k in range(NZ)) / 1000.0
    assert body["volume_ml"] == pytest.approx(analytic_ml, rel=0.10)
    assert body["mean_hu"] < -900.0

    mesh = seg_client.get("/api/analysis/label/{i}/mesh".format(i=label_id))
    assert mesh.status_code == 200
    assert len(mesh.content) > 84


def test_airway_manual_reference_uses_the_bracketed_range(seg_client, uid):
    r = seg_client.post("/api/analysis/airway", json={
        "series_uid": uid, "seed_ijk": _seed(),
        "reference": "manual", "ref_range_k": [0, 10],
    })
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["csa_ref_mm2"] == pytest.approx(math.pi * REF_RADIUS ** 2, rel=0.10)
    assert out["stenosis_pct"] == pytest.approx(ANALYTIC_PCT, abs=8.0)

    # A reference bracketed across the stenosis itself must read lower.
    tight = seg_client.post("/api/analysis/airway", json={
        "series_uid": uid, "seed_ijk": _seed(),
        "reference": "manual", "ref_range_k": list(STENOSIS_K),
    }).json()
    assert tight["csa_ref_mm2"] < 0.3 * out["csa_ref_mm2"]
    assert tight["stenosis_pct"] < 20.0
    assert tight["myer_cotton_grade"] == "I"


def test_airway_manual_reference_needs_a_range(seg_client, uid):
    r = seg_client.post("/api/analysis/airway", json={
        "series_uid": uid, "seed_ijk": _seed(), "reference": "manual",
    })
    assert r.status_code == 400
    assert "ref_range_k" in r.json()["detail"]

    r = seg_client.post("/api/analysis/airway", json={
        "series_uid": uid, "seed_ijk": _seed(), "reference": "sideways",
    })
    assert r.status_code == 400


def test_airway_distance_from_the_glottis(seg_client, uid, profile):
    glottis_k = 30
    r = seg_client.post("/api/analysis/airway", json={
        "series_uid": uid, "seed_ijk": _seed(), "glottis_slice": glottis_k,
    })
    assert r.status_code == 200, r.text
    out = r.json()

    k_min = k_of_lps(out["min_csa_lps"])
    assert out["distance_from_glottis_mm"] == pytest.approx(
        abs(glottis_k - k_min) * DZ, abs=1.5)
    # Without a glottis level the field is null, not zero.
    assert profile["distance_from_glottis_mm"] is None


def test_airway_rejects_a_seed_outside_the_lumen(seg_client, uid):
    i, j = mm_to_ij(10.0, 15.0)                      # solid soft tissue
    r = seg_client.post("/api/analysis/airway", json={
        "series_uid": uid, "seed_ijk": [i, j, 20],
    })
    assert r.status_code == 400
    assert "seed" in r.json()["detail"].lower()

    r = seg_client.post("/api/analysis/airway",
                        json={"series_uid": "1.2.3.nope", "seed_ijk": _seed()})
    assert r.status_code == 404


def test_airway_echoes_the_reference_and_sample_slices(profile, seg_client, uid):
    # Every sample carries its slice index, in the same inferior-to-superior
    # order as the rest of the profile (this phantom has +k = +z).
    ks = profile["sample_k"]
    assert len(ks) == len(profile["csa_mm2"])
    assert all(isinstance(k, int) for k in ks)
    assert ks == sorted(ks)
    for idx in (0, len(ks) - 1):
        assert ks[idx] == round(k_of_lps(profile["centerline_lps"][idx]))

    assert profile["reference"] == "auto"
    assert profile["ref_range_k"] is None
    assert profile["ref_method"].startswith("auto")
    assert profile["capped_at_glottis"] is False

    manual = seg_client.post("/api/analysis/airway", json={
        "series_uid": uid, "seed_ijk": _seed(),
        "reference": "manual", "ref_range_k": [10, 2],
    }).json()
    assert manual["reference"] == "manual"
    assert manual["ref_range_k"] == [2, 10]              # sorted on the way out
    assert manual["ref_method"] == "manual k 2..10"


def test_airway_cap_at_glottis_trims_the_profile(seg_client, uid):
    # A glottis mark below the narrowing: with the cap, the profile stops there
    # and the stenosis at k 18..21 is no longer part of the graded segment.
    glottis_k = 15
    r = seg_client.post("/api/analysis/airway", json={
        "series_uid": uid, "seed_ijk": _seed(),
        "glottis_slice": glottis_k, "cap_at_glottis": True,
    })
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["capped_at_glottis"] is True
    assert max(out["sample_k"]) == glottis_k
    assert min(out["sample_k"]) == 0
    assert len(out["csa_mm2"]) == len(out["sample_k"])
    # The taper towards the narrowing starts at k 14, so the last kept
    # samples are already a little smaller than the trachea: grade I, not III.
    assert out["stenosis_pct"] < 50.0
    assert out["myer_cotton_grade"] == "I"
    assert out["distance_from_glottis_mm"] is not None

    # The lumen label is left whole even though the profile was trimmed.
    stats = seg_client.get("/api/analysis/label/{i}/stats".format(
        i=out["label_id"])).json()
    analytic_ml = sum(math.pi * airway_radius(k) ** 2 * DZ
                      for k in range(NZ)) / 1000.0
    assert stats["volume_ml"] == pytest.approx(analytic_ml, rel=0.10)

    # Without the flag the same glottis mark leaves the profile alone.
    full = seg_client.post("/api/analysis/airway", json={
        "series_uid": uid, "seed_ijk": _seed(), "glottis_slice": glottis_k,
    }).json()
    assert full["capped_at_glottis"] is False
    assert max(full["sample_k"]) > glottis_k
    assert full["myer_cotton_grade"] == "III"

    # A glottis mark below the seed leaves nothing to grade -> 400.
    r = seg_client.post("/api/analysis/airway", json={
        "series_uid": uid, "seed_ijk": _seed(),
        "glottis_slice": 1, "cap_at_glottis": True,
    })
    assert r.status_code == 400
    assert "glottis" in r.json()["detail"].lower()


def test_airway_walk_stops_where_the_trachea_stops(seg_client, lung_uid, profile):
    # Without the blob the walk runs the whole tube down to the bottom slice.
    assert min(profile["sample_k"]) == 0

    r = seg_client.post("/api/analysis/airway", json={
        "series_uid": lung_uid, "seed_ijk": _seed(),
        "lower_hu": -1024.0, "upper_hu": -400.0,
    })
    assert r.status_code == 200, r.text
    out = r.json()

    # The 572 mm2 blob at k 0..3 is more than four times the 113 mm2 trachea,
    # so the walk ends above it instead of following the merged component and
    # dragging the centroid (and the tangent with it) out into the blob.
    assert min(out["sample_k"]) > LUNG_K[1]
    assert min(out["sample_k"]) <= LUNG_K[1] + 2
    assert max(out["sample_k"]) == max(profile["sample_k"])

    # No section anywhere near the blob, and the inferior end of the profile is
    # a real tracheal cut rather than an oblique one taken on the way out.
    csa = np.asarray(out["csa_mm2"])
    assert csa.max() < 2.0 * math.pi * REF_RADIUS ** 2
    assert csa[0] == pytest.approx(math.pi * REF_RADIUS ** 2, rel=0.20)

    # ...so the phantom still grades as the same subglottic stenosis.
    assert out["stenosis_pct"] == pytest.approx(ANALYTIC_PCT, abs=8.0)
    assert out["myer_cotton_grade"] == "III"
    k_min = k_of_lps(out["min_csa_lps"])
    assert STENOSIS_K[0] - 1 <= k_min <= STENOSIS_K[1] + 1

    # The lumen label is still grown whole -- only the profile stops early.
    stats = seg_client.get("/api/analysis/label/{i}/stats".format(
        i=out["label_id"])).json()
    tube_ml = sum(math.pi * airway_radius(k) ** 2 * DZ
                  for k in range(NZ)) / 1000.0
    assert stats["volume_ml"] > tube_ml


def test_centerline_walk_stops_at_a_lateral_jump():
    """A component that swallows the previous centroid but sits 20 mm away is
    not the lumen any more, however it was picked."""
    from hnrad.airway import _track_centerline

    nz, ny, nx = 12, 64, 64
    mask = np.zeros((nz, ny, nx), dtype=np.uint8)
    yy, xx = np.mgrid[0:ny, 0:nx]
    mask[:, ((yy - 32) ** 2 + (xx - 10) ** 2) <= 16] = 1   # r = 4 px at i = 10
    # One slice where a thin bar joins the tube: small enough not to trip the
    # merge rule, but its centroid is 23 px (= 23 mm here) to the right.
    mask[4, 30:34, 10:64] = 1

    ks, js, is_ = _track_centerline(mask, (10, 32, 8), 1.0, 1.0)
    assert ks.min() == 5
    assert ks.max() == nz - 1
    assert np.abs(is_ - 10.0).max() < 1.0
