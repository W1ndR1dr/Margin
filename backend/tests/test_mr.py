"""MR sequence classification, modality-aware windowing and the DB migration.

The classifier table is the point of this file: every row is a synthetic DICOM
header, and the expected ``sequence_kind`` next to it is the contract.  A rule
change that moves any of these rows is a contract change.
"""

from __future__ import annotations

import sqlite3

import numpy as np
import pytest

from hnrad import db, mr


# --------------------------------------------------------------------------
# the sequence classifier
# --------------------------------------------------------------------------

def H(**kw):
    """A synthetic MR header dict for the classifier."""
    return kw


# (label, header, expected sequence_kind)
CLASSIFIER_CASES = [
    # --- localizers ------------------------------------------------------
    ("3-plane loc", H(description="3-Plane Localizer"), "LOCALIZER"),
    ("scout", H(description="SCOUT"), "LOCALIZER"),
    ("survey", H(description="Survey HEAD"), "LOCALIZER"),
    ("localiser via ImageType",
     H(description="AX T2", image_type="DERIVED\\SECONDARY\\LOCALIZER"),
     "LOCALIZER"),

    # --- diffusion -------------------------------------------------------
    ("adc beats dwi", H(description="DWI ADC map"), "ADC"),
    ("eadc", H(description="eADC"), "ADC"),
    ("apparent diffusion", H(description="Apparent Diffusion Coefficient"), "ADC"),
    ("dwi b1000", H(description="DWI b1000", scanning_sequence="EP"), "DWI"),
    ("dwi b800", H(description="AX DIFF b800"), "DWI"),
    ("resolve", H(description="RESOLVE neck"), "DWI"),
    ("ep with no keyword", H(description="ax ep2d", scanning_sequence="EP"), "DWI"),
    ("dti", H(description="DTI 32 dir"), "DWI"),

    # --- susceptibility and angio ----------------------------------------
    ("swi", H(description="AX SWI"), "SWI"),
    ("swan", H(description="SWAN"), "SWI"),
    ("tof mra", H(description="TOF MRA circle of willis"), "MRA"),
    ("mrv", H(description="MRV head"), "MRA"),
    ("angio", H(description="CE Angio neck"), "MRA"),

    # --- inversion recovery ----------------------------------------------
    ("flair by name", H(description="AX FLAIR"), "FLAIR"),
    ("flair by TI", H(description="AX IR long",
                      scanning_sequence="SE\\IR", inversion_time=2500.0,
                      echo_time=125.0), "FLAIR"),
    ("stir by name", H(description="COR STIR"), "STIR"),
    ("stir by TI", H(description="COR IR", scanning_sequence="IR",
                     inversion_time=160.0, echo_time=40.0), "STIR"),

    # --- T1 family -------------------------------------------------------
    ("t1 by name", H(description="AX T1", echo_time=10.0,
                     repetition_time=600.0), "T1"),
    ("t1 by TE/TR", H(echo_time=12.0, repetition_time=500.0), "T1"),
    ("mprage", H(description="SAG MPRAGE"), "T1"),
    ("vibe", H(description="AX VIBE"), "T1"),
    ("t1 post", H(description="AX T1 POST"), "T1C"),
    ("t1 +c", H(description="AX T1 +C"), "T1C"),
    ("t1 gad", H(description="T1 GAD axial"), "T1C"),
    ("t1 with agent tag", H(description="AX T1",
                            contrast_agent="GADOBUTROL 7.5 ML"), "T1C"),
    ("t1 fs post", H(description="AX T1 FS POST"), "T1C_FS"),
    ("t1 post fatsat", H(description="T1 postcontrast fatsat"), "T1C_FS"),
    ("t1 spair +c", H(description="T1 SPAIR +C"), "T1C_FS"),
    ("t1 fs with agent",
     H(description="AX T1 fat sat", contrast_agent="Dotarem"), "T1C_FS"),
    ("t1 pre stays t1", H(description="AX T1 PRE"), "T1"),
    ("t1 fs pre stays t1", H(description="AX T1 FS pre-contrast"), "T1"),
    ("spgr by physics", H(scanning_sequence="GR", sequence_variant="SP",
                          repetition_time=8.0, flip_angle=15.0), "T1"),

    # --- T2 family -------------------------------------------------------
    ("t2 by name", H(description="AX T2", echo_time=100.0,
                     repetition_time=4000.0), "T2"),
    ("t2 by TE/TR", H(echo_time=90.0, repetition_time=4000.0), "T2"),
    ("t2 fs", H(description="AX T2 FS"), "T2_FS"),
    ("t2 dixon", H(description="COR T2 Dixon"), "T2_FS"),
    ("haste", H(description="HASTE cor"), "T2"),
    ("cube", H(description="CUBE T2 neck"), "T2"),

    # --- proton density ---------------------------------------------------
    ("pd by name", H(description="AX PD"), "PD"),
    ("pd by TE/TR", H(echo_time=15.0, repetition_time=3000.0), "PD"),
    ("proton density", H(description="Proton Density"), "PD"),

    # --- the HaN-Seg series this backend actually indexes -----------------
    ("hanseg mr t1", H(description="HaN-Seg MR T1",
                       scanning_sequence="RM", sequence_variant="NONE"), "T1"),

    # --- nothing matched --------------------------------------------------
    ("empty", H(), "OTHER"),
    ("nonsense", H(description="research protocol 7"), "OTHER"),
    ("te only, mid range", H(echo_time=45.0, repetition_time=1000.0), "OTHER"),
]


@pytest.mark.parametrize(
    "label,header,expected",
    CLASSIFIER_CASES,
    ids=[c[0] for c in CLASSIFIER_CASES],
)
def test_classify_sequence(label, header, expected):
    assert mr.classify_sequence(header) == expected


def test_every_classifier_result_is_a_known_kind():
    for _label, header, _expected in CLASSIFIER_CASES:
        assert mr.classify_sequence(header) in mr.SEQUENCE_KINDS


def test_classifier_never_raises_on_junk():
    junk = [
        {"description": None, "echo_time": "not a number"},
        {"description": 42, "repetition_time": [], "inversion_time": {}},
        {"scanning_sequence": ["SE", "IR"], "echo_time": float("nan")},
        {"contrast_agent": ["GAD", "8ML"], "description": "t1"},
    ]
    for header in junk:
        assert mr.classify_sequence(header) in mr.SEQUENCE_KINDS


# --------------------------------------------------------------------------
# plane and thickness
# --------------------------------------------------------------------------

@pytest.mark.parametrize("iop,expected", [
    ([1, 0, 0, 0, 1, 0], "AX"),
    ([-1, 0, 0, 0, -1, 0], "AX"),
    ([1, 0, 0, 0, 0, -1], "COR"),
    ([0, 1, 0, 0, 0, -1], "SAG"),
    ([1, 0, 0, 0, 0.6, 0.8], "OBL"),          # 53 degrees off every axis
    ([1, 0, 0, 0, 0.98, 0.2], "AX"),          # 11 degrees: still axial
    (None, None),
    ([1, 0, 0], None),
    ([1, 0, 0, 1, 0, 0], None),               # degenerate: row == col
])
def test_acquired_plane(iop, expected):
    assert mr.acquired_plane(iop) == expected


@pytest.mark.parametrize("between,thickness,expected", [
    (3.0, None, True),
    (2.5, None, False),                        # strictly greater than
    (2.6, None, True),
    (1.0, 5.0, False),                         # SpacingBetweenSlices wins
    (None, 3.0, True),
    (None, 1.0, False),
    (None, None, None),
    (0.0, None, None),
])
def test_is_thick(between, thickness, expected):
    assert mr.is_thick(between, thickness) is expected


# --------------------------------------------------------------------------
# windowing
# --------------------------------------------------------------------------

def test_ct_keeps_the_fixed_soft_tissue_window():
    rng = np.random.default_rng(0)
    arr = rng.normal(40.0, 500.0, size=(64, 64)).astype(np.float32)
    win = mr.window_for_array(arr, "CT")
    assert win["lower"] == pytest.approx(-135.0)
    assert win["upper"] == pytest.approx(215.0)
    assert win["method"] == "ct-fixed-w350-l40"


def test_unknown_modality_is_treated_as_ct():
    arr = np.zeros((8, 8), dtype=np.float32)
    assert mr.window_for_array(arr, None)["method"] == "ct-fixed-w350-l40"


def test_mr_gets_a_percentile_window_over_non_zero_voxels():
    # A disc of tissue values 800..1200 on an exactly-zero background, which is
    # what an MR reconstruction looks like.
    arr = np.zeros((128, 128), dtype=np.float32)
    yy, xx = np.mgrid[0:128, 0:128]
    disc = (yy - 64) ** 2 + (xx - 64) ** 2 < 40 ** 2
    arr[disc] = np.linspace(800.0, 1200.0, int(disc.sum())).astype(np.float32)

    win = mr.window_for_array(arr, "MR")
    assert win["method"].startswith("percentile-1-99")
    # The background must not drag the window down to zero.
    assert 790.0 < win["lower"] < 830.0
    assert 1170.0 < win["upper"] < 1205.0


def test_mr_window_is_not_the_ct_window():
    arr = np.full((32, 32), 3000.0, dtype=np.float32)
    arr[:16] = 1000.0
    ct = mr.window_for_array(arr, "CT")
    mrw = mr.window_for_array(arr, "MR")
    assert (mrw["lower"], mrw["upper"]) != (ct["lower"], ct["upper"])
    assert mrw["upper"] > 1000.0


def test_pt_is_windowed_like_mr():
    arr = np.zeros((64, 64), dtype=np.float32)
    arr[20:40, 20:40] = np.linspace(1.0, 9.0, 400).reshape(20, 20)
    assert mr.window_for_array(arr, "PT")["method"].startswith("percentile")


def test_window_handles_uniform_and_empty_arrays():
    flat = mr.window_for_array(np.full((16, 16), 7.0, np.float32), "MR")
    assert flat["upper"] > flat["lower"]
    empty = mr.window_for_array(np.zeros((0,), np.float32), "MR")
    assert empty["upper"] > empty["lower"]
    allzero = mr.window_for_array(np.zeros((16, 16), np.float32), "MR")
    assert allzero["upper"] > allzero["lower"]


def test_strided_sample_caps_the_voxel_count():
    arr = np.arange(64 * 64 * 64, dtype=np.float32).reshape(64, 64, 64)
    out = mr.strided_sample(arr, max_voxels=5000)
    assert out.size <= 5000
    assert out.ndim == 3
    # Small arrays come back untouched.
    small = np.arange(10, dtype=np.float32)
    assert mr.strided_sample(small, max_voxels=5000) is small


def test_percentile_window_is_stable_under_striding():
    rng = np.random.default_rng(7)
    arr = rng.lognormal(6.0, 0.4, size=(80, 80, 80)).astype(np.float32)
    full = mr.window_for_array(arr, "MR", max_voxels=arr.size)
    strided = mr.window_for_array(arr, "MR", max_voxels=20_000)
    assert full["lower"] == pytest.approx(strided["lower"], rel=0.05)
    assert full["upper"] == pytest.approx(strided["upper"], rel=0.05)


# --------------------------------------------------------------------------
# series_metadata off a real pydicom dataset
# --------------------------------------------------------------------------

def test_series_metadata_from_a_pydicom_dataset():
    from pydicom.dataset import Dataset

    ds = Dataset()
    ds.Modality = "MR"
    ds.SeriesDescription = "AX T1 FS POST"
    ds.ScanningSequence = "SE"
    ds.SequenceVariant = "SK"
    ds.EchoTime = 11.0
    ds.RepetitionTime = 620.0
    ds.FlipAngle = 90.0
    ds.MagneticFieldStrength = 3.0
    ds.ContrastBolusAgent = "GADOBUTROL"
    ds.SpacingBetweenSlices = 4.0
    ds.SliceThickness = 4.0

    meta = mr.series_metadata(ds, [1, 0, 0, 0, 1, 0])
    assert meta["sequence_kind"] == "T1C_FS"
    assert meta["acquired_plane"] == "AX"
    assert meta["is_thick"] is True
    assert meta["echo_time"] == 11.0
    assert meta["repetition_time"] == 620.0
    assert meta["flip_angle"] == 90.0
    assert meta["magnetic_field_strength"] == 3.0
    assert meta["scanning_sequence"] == "SE"
    assert meta["sequence_variant"] == "SK"
    assert meta["contrast_agent"] == "GADOBUTROL"
    assert meta["has_contrast"] is True
    assert meta["kernel"] is None


def test_series_metadata_on_a_ct_leaves_sequence_kind_null():
    from pydicom.dataset import Dataset

    ds = Dataset()
    ds.Modality = "CT"
    ds.SeriesDescription = "CT NECK W CONTRAST"
    ds.ConvolutionKernel = "B31f"
    ds.SliceThickness = 1.0
    ds.ContrastBolusAgent = "OMNIPAQUE"

    meta = mr.series_metadata(ds, [1, 0, 0, 0, 1, 0])
    assert meta["sequence_kind"] is None
    assert meta["kernel"] == "B31f"
    assert meta["has_contrast"] is True
    assert meta["is_thick"] is False
    assert meta["echo_time"] is None


def test_series_metadata_survives_an_empty_dataset():
    from pydicom.dataset import Dataset

    meta = mr.series_metadata(Dataset(), None)
    assert meta["sequence_kind"] is None
    assert meta["acquired_plane"] is None
    assert meta["is_thick"] is None
    assert set(meta) == {n for n, _t in db.SERIES_V04_COLUMNS
                         if not n.startswith("window_")} | {"scan_options",
                                                            "image_type"}


# --------------------------------------------------------------------------
# DB migration
# --------------------------------------------------------------------------

V01_SERIES_SCHEMA = """
CREATE TABLE series (
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
"""


def test_migration_upgrades_a_v01_database_in_place(tmp_path):
    path = tmp_path / "old.sqlite"
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.executescript(V01_SERIES_SCHEMA)
    conn.execute(
        "INSERT INTO series (series_uid, study_uid, modality, description)"
        " VALUES ('1.2.3', '1.2', 'CT', 'AXIAL NECK')")
    conn.commit()

    before = {r["series_uid"]: dict(r)
              for r in conn.execute("SELECT * FROM series").fetchall()}
    added = db.migrate(conn)
    assert set(added) == {n for n, _t in db.SERIES_V04_COLUMNS}

    after = {r["series_uid"]: dict(r)
             for r in conn.execute("SELECT * FROM series").fetchall()}
    # The existing row is untouched: same keys, same values, new keys all NULL.
    assert set(after) == set(before)
    for key, value in before["1.2.3"].items():
        assert after["1.2.3"][key] == value
    for name, _t in db.SERIES_V04_COLUMNS:
        assert after["1.2.3"][name] is None
    conn.close()


def test_migration_is_idempotent(tmp_path):
    path = tmp_path / "idem.sqlite"
    db.init_db(path)
    with db.connect(path) as conn:
        assert db.migrate(conn) == []
        assert db.migrate(conn) == []
        cols = db.table_columns(conn, "series")
    for name, _t in db.SERIES_V04_COLUMNS:
        assert name in cols

    # init_db again: still a no-op, still every column present.
    db.init_db(path)
    with db.connect(path) as conn:
        assert db.migrate(conn) == []


def test_migration_on_a_missing_table_is_a_no_op(tmp_path):
    path = tmp_path / "empty.sqlite"
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    assert db.migrate(conn) == []
    conn.close()


def test_window_cache_round_trip(tmp_path):
    path = tmp_path / "win.sqlite"
    db.init_db(path)
    with db.connect(path) as conn:
        conn.execute("INSERT INTO series (series_uid, study_uid, modality)"
                     " VALUES ('1.2.3', '1.2', 'MR')")
        assert db.get_series_window(conn, "1.2.3") is None
        db.set_series_window(conn, "1.2.3", 12.5, 987.0, "percentile-1-99-nonzero")
        got = db.get_series_window(conn, "1.2.3")
    assert got["lower"] == pytest.approx(12.5)
    assert got["upper"] == pytest.approx(987.0)
    assert got["method"] == "percentile-1-99-nonzero"
    assert got["computed_at"] > 0


# --------------------------------------------------------------------------
# end to end against the synthetic CT series from conftest
# --------------------------------------------------------------------------

def test_series_listing_exposes_the_v04_fields(client, store):
    rows = client.get(
        "/api/studies/{u}/series".format(u=store["study_uid"])).json()
    assert rows
    row = rows[0]
    for key in ("sequence_kind", "acquired_plane", "is_thick",
                "frame_of_reference_uid", "echo_time", "repetition_time",
                "magnetic_field_strength", "kernel", "has_contrast", "window"):
        assert key in row, key
    # The conftest series is an axial CT at 2 mm.
    assert row["modality"] == "CT"
    assert row["acquired_plane"] == "AX"
    assert row["is_thick"] is False
    assert row["sequence_kind"] is None
    assert row["frame_of_reference_uid"] == "1.2.826.0.1.3680043.10.1337.9"


def test_get_series_exposes_the_v04_fields(client, store):
    row = client.get("/api/series/{u}".format(u=store["series_uid"])).json()
    assert row["acquired_plane"] == "AX"
    assert row["is_thick"] is False
    assert row["frame_of_reference_uid"] == "1.2.826.0.1.3680043.10.1337.9"


def test_window_route_on_a_ct_is_the_fixed_window(client, store):
    r = client.get("/api/series/{u}/window".format(u=store["series_uid"]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["lower"] == pytest.approx(-135.0)
    assert body["upper"] == pytest.approx(215.0)
    assert body["method"] == "ct-fixed-w350-l40"


def test_window_route_caches_in_the_db(client, store):
    uid = store["series_uid"]
    first = client.get("/api/series/{u}/window".format(u=uid)).json()
    second = client.get("/api/series/{u}/window".format(u=uid)).json()
    assert second["cached"] is True
    assert second["lower"] == pytest.approx(first["lower"])
    assert second["upper"] == pytest.approx(first["upper"])
    # The cached window also shows up on the series row.
    row = client.get("/api/series/{u}".format(u=uid)).json()
    assert row["window"]["lower"] == pytest.approx(first["lower"])


def test_window_route_unknown_series_is_404(client):
    assert client.get("/api/series/1.2.3.4/window").status_code == 404


def test_reimport_does_not_duplicate_rows_and_fills_the_new_columns(
    client, store
):
    before = client.get("/api/studies/{u}/series".format(
        u=store["study_uid"])).json()
    r = client.post("/api/import", json={"path": str(store["studies"])})
    assert r.status_code == 200, r.text
    after = client.get("/api/studies/{u}/series".format(
        u=store["study_uid"])).json()
    assert len(after) == len(before)
    assert [s["series_uid"] for s in after] == [s["series_uid"] for s in before]
    assert after[0]["acquired_plane"] == "AX"
    assert after[0]["instance_count"] == before[0]["instance_count"]
