"""AI v0.3: NIfTI geometry, the job state machine, colours and /api/ai/models.

Nothing here imports torch, nnU-Net or TotalSegmentator.  The "model" is a
stub script (:data:`STUB_RUNNER`) that speaks the same one-JSON-per-line
protocol as the real runners and writes a two-label segmentation on the input
grid, so the whole job pipeline -- export, subprocess, progress, caching,
label registration, rehydration -- is exercised without a 2.8 GB download.
"""

from __future__ import annotations

import gzip
import json
import os
import struct
import sys
import textwrap
import time
from pathlib import Path

import numpy as np
import pytest

from hnrad import ai, analysis, db, segmentation

from conftest import COL_MM, N_SLICES, ROW_MM, SLICE_MM


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------

@pytest.fixture()
def vol(client, store) -> analysis.SeriesVolume:
    db.ensure_db()
    with db.connect() as conn:
        rows = list(db.get_series_instances(conn, store["series_uid"]))
    return analysis.load_series_volume(store["series_uid"], rows)


@pytest.fixture(autouse=True)
def isolated_ai(monkeypatch, tmp_path):
    """Keep every test away from the developer's real weights and cache."""
    monkeypatch.delenv("TOTALSEG_HOME_DIR", raising=False)
    monkeypatch.delenv("HNRAD_MODELS_ROOT", raising=False)
    monkeypatch.setenv("HNRAD_AI_CACHE", str(tmp_path / "ai-cache"))
    monkeypatch.setenv("HNRAD_AI_PYTHON", sys.executable)
    ai.JOBS.autostart = False
    ai.reset()
    segmentation.clear_caches()
    yield
    ai.JOBS.autostart = True
    ai.reset()
    segmentation.clear_caches()


#: A stand-in for run_totalseg.py / run_hnlnl.py.  Same protocol, no torch.
STUB_RUNNER = textwrap.dedent('''
    import argparse, json, sys
    import numpy as np
    import SimpleITK as sitk

    def emit(event, **kw):
        kw["event"] = event
        sys.stdout.write(json.dumps(kw) + "\\n")
        sys.stdout.flush()

    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tasks", nargs="*", default=[])
    ap.add_argument("--roi-subset", nargs="*", default=None)
    ap.add_argument("--fast", action="store_true")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--weights", default=None)
    ap.add_argument("--fail", action="store_true")
    ap.add_argument("--hang", type=float, default=0.0)
    a = ap.parse_args()

    emit("progress", value=0.2, message="stub starting")
    if a.hang:
        import time
        time.sleep(a.hang)
    if a.fail:
        emit("error", message="stub was told to fail")
        raise SystemExit(1)

    ref = sitk.ReadImage(a.input)
    arr = sitk.GetArrayFromImage(ref)
    seg = np.zeros(arr.shape, dtype=np.uint16)
    # Two blobs entirely inside the volume, on the input grid.
    seg[1:4, 8:20, 8:20] = 1
    seg[2:5, 22:28, 4:12] = 2

    emit("progress", value=0.8, message="stub writing")
    out = sitk.GetImageFromArray(seg)
    out.CopyInformation(ref)
    seg_path = a.out + "/seg.nii.gz"
    sitk.WriteImage(out, seg_path, True)

    sx, sy, sz = ref.GetSpacing()
    ml = sx * sy * sz / 1000.0
    names = {1: "common_carotid_artery_left", 2: "internal_jugular_vein_right"}
    structures = [
        {"label_value": int(v), "name": names[int(v)],
         "n_voxels": int((seg == v).sum()),
         "volume_ml": float((seg == v).sum() * ml)}
        for v in (1, 2)
    ]
    result = {"seg": seg_path, "structures": structures,
              "labels": {"1": names[1], "2": names[2]},
              "tasks": a.tasks, "fast": a.fast, "roi_subset": a.roi_subset}
    emit("progress", value=1.0, message="stub done")
    emit("result", **result)
''')


@pytest.fixture()
def stub(monkeypatch, tmp_path):
    """Point ``ai.build_command`` at the stub runner; returns a knobs dict."""
    script = tmp_path / "stub_runner.py"
    script.write_text(STUB_RUNNER, encoding="utf-8")
    knobs: dict = {"extra": []}

    def build(job, ct_path, out_dir):
        return [sys.executable, str(script), "--input", str(ct_path),
                "--out", str(out_dir), *knobs["extra"]]

    monkeypatch.setattr(ai, "build_command", build)
    return knobs


# --------------------------------------------------------------------------
# 1. NIfTI export geometry round-trip
# --------------------------------------------------------------------------

def _read_nifti_srow(path: Path) -> tuple[np.ndarray, tuple[int, int, int],
                                          tuple[float, float, float]]:
    """Parse srow_x/y/z, dim and pixdim straight out of the NIfTI-1 header.

    Deliberately not via SimpleITK or nibabel: the point of the test is to
    check the bytes on disk against :func:`ai.nifti_affine_ras`, not to check
    a library against itself.
    """
    with gzip.open(path, "rb") as fh:
        head = fh.read(352)
    assert struct.unpack("<i", head[0:4])[0] == 348, "not a NIfTI-1 header"
    assert head[344:348] == b"n+1\x00"
    dim = struct.unpack("<8h", head[40:56])
    pixdim = struct.unpack("<8f", head[76:108])
    sform_code = struct.unpack("<h", head[254:256])[0]
    assert sform_code > 0, "no sform in the written file"
    srow = np.asarray(struct.unpack("<12f", head[280:328]),
                      dtype=np.float64).reshape(3, 4)
    return srow, (dim[1], dim[2], dim[3]), (pixdim[1], pixdim[2], pixdim[3])


def test_nifti_affine_matches_the_analysis_api(vol):
    """The affine must agree voxel-for-voxel with segmentation.ijk_to_lps."""
    aff = ai.nifti_affine_ras(vol)
    nz, ny, nx = vol.hu.shape
    for ijk in [(0, 0, 0), (nx - 1, 0, 0), (0, ny - 1, 0), (0, 0, nz - 1),
                (nx // 2, ny // 3, nz - 1)]:
        lps = np.asarray(segmentation.ijk_to_lps(vol, ijk))
        ras = aff @ np.asarray([ijk[0], ijk[1], ijk[2], 1.0])
        expected = ai.LPS_TO_RAS * lps
        assert np.allclose(ras[:3], expected, atol=1e-6), ijk


def test_nifti_export_roundtrip_on_disk(vol, tmp_path):
    """Write, then read the header bytes back and compare to the affine."""
    import SimpleITK as sitk

    path = ai.export_nifti(vol, tmp_path / "ct.nii.gz")
    assert path.is_file() and path.stat().st_size > 0

    srow, dim, pixdim = _read_nifti_srow(path)

    assert dim == (vol.hu.shape[2], vol.hu.shape[1], vol.hu.shape[0])
    assert np.allclose(pixdim, (COL_MM, ROW_MM, SLICE_MM), atol=1e-5)

    expected = ai.nifti_affine_ras(vol)[:3, :]
    assert np.allclose(srow, expected, atol=1e-4), (srow, expected)

    # ... and SimpleITK must read the LPS geometry back unchanged.
    img = sitk.ReadImage(str(path))
    assert np.allclose(img.GetSpacing(), (COL_MM, ROW_MM, SLICE_MM), atol=1e-6)
    assert np.allclose(img.GetOrigin(), vol.origin, atol=1e-4)
    back = sitk.GetArrayFromImage(img)
    assert back.shape == vol.hu.shape
    assert np.allclose(back.astype(np.float32), vol.hu, atol=0.5)

    # And the physical point of a voxel survives the whole trip.
    for ijk in [(0, 0, 0), (5, 7, 3), (31, 31, N_SLICES - 1)]:
        assert np.allclose(img.TransformIndexToPhysicalPoint(tuple(int(v) for v in ijk)),
                           segmentation.ijk_to_lps(vol, ijk), atol=1e-4)


def test_nifti_affine_handles_a_flipped_slice_direction(vol):
    """A descending series (slice_dir = -z) must still produce a sane affine."""
    import copy

    flipped = copy.copy(vol)
    flipped.slice_dir = -np.asarray(vol.slice_dir, dtype=np.float64)
    aff = ai.nifti_affine_ras(flipped)
    assert aff[2, 2] == pytest.approx(-vol.spacing[0])
    # Right-handedness flips, which is exactly what a negative determinant means.
    assert np.linalg.det(aff[:3, :3]) == pytest.approx(
        -np.linalg.det(ai.nifti_affine_ras(vol)[:3, :3]))


# --------------------------------------------------------------------------
# 2. job state machine (stubbed runner, no torch)
# --------------------------------------------------------------------------

def test_job_runs_through_queued_running_done(client, store, stub):
    job = ai.JOBS.submit(store["series_uid"], "totalseg",
                         tasks=["headneck_bones_vessels"])
    assert job.status == "queued"
    assert job.progress == 0.0
    assert job.started_at is None
    assert ai.JOBS.get(job.job_id) is job

    ai.JOBS.run_job(job)

    assert job.status == "done", job.log
    assert job.error is None
    assert job.progress == 1.0
    assert job.started_at is not None and job.finished_at >= job.started_at
    assert job.cached is False
    assert len(job.structures) == 2
    assert [s["name"] for s in job.structures] == [
        "common_carotid_artery_left", "internal_jugular_vein_right"]
    assert any("stub done" in line for line in job.log)


def test_job_second_run_is_served_from_cache(client, store, stub):
    first = ai.JOBS.submit(store["series_uid"], "totalseg",
                           tasks=["headneck_bones_vessels"])
    ai.JOBS.run_job(first)
    assert first.cached is False

    second = ai.JOBS.submit(store["series_uid"], "totalseg",
                            tasks=["headneck_bones_vessels"])
    ai.JOBS.run_job(second)
    assert second.status == "done", second.log
    assert second.cached is True
    assert [s["name"] for s in second.structures] == \
           [s["name"] for s in first.structures]

    # The cached artefacts really are on disk under <series>/<model>/.
    cdir = ai.cache_dir(store["series_uid"], "totalseg")
    assert cdir.is_dir()
    assert list(cdir.glob("seg-*.nii.gz"))
    assert list(cdir.glob("result-*.json"))

    # A different request shape must not reuse that cache entry.
    third = ai.JOBS.submit(store["series_uid"], "totalseg",
                           tasks=["headneck_bones_vessels"], fast=True)
    ai.JOBS.run_job(third)
    assert third.cached is False


def test_job_reports_runner_failure(client, store, stub):
    stub["extra"] = ["--fail"]
    job = ai.JOBS.submit(store["series_uid"], "totalseg",
                         tasks=["headneck_bones_vessels"])
    ai.JOBS.run_job(job)
    assert job.status == "error"
    assert "stub was told to fail" in (job.error or "")
    assert job.structures is None
    assert job.finished_at is not None


def test_job_reports_a_missing_interpreter(client, store, monkeypatch):
    monkeypatch.setenv("HNRAD_AI_PYTHON", str(Path("does_not_exist_python.exe")))
    job = ai.JOBS.submit(store["series_uid"], "totalseg",
                         tasks=["headneck_bones_vessels"])
    ai.JOBS.run_job(job)
    assert job.status == "error"
    assert "inference venv" in (job.error or "")


def test_cancel_before_start_and_delete_after_done(client, store, stub):
    job = ai.JOBS.submit(store["series_uid"], "totalseg",
                         tasks=["headneck_bones_vessels"])
    ai.JOBS.cancel(job.job_id)
    ai.JOBS.run_job(job)
    assert job.status == "error"
    assert "cancelled" in (job.error or "")

    done = ai.JOBS.submit(store["series_uid"], "totalseg",
                          tasks=["headneck_bones_vessels"])
    ai.JOBS.run_job(done)
    assert done.status == "done"
    ai.JOBS.cancel(done.job_id)
    assert ai.JOBS.get(done.job_id) is None       # finished jobs are removed


def test_submit_rejects_bad_input(client, store):
    with pytest.raises(ai.AiError):
        ai.JOBS.submit(store["series_uid"], "nope")
    with pytest.raises(ai.AiError):
        ai.JOBS.submit(store["series_uid"], "totalseg", tasks=["not_a_task"])
    with pytest.raises(ai.AiError):
        ai.JOBS.submit(store["series_uid"], "hnlnl", tasks=["total"])

    # `total` gets the neck ROI subset by default so it never runs blind.
    job = ai.JOBS.submit(store["series_uid"], "totalseg", tasks=["total"])
    assert "common_carotid_artery_left" in job.roi_subset
    assert "vertebrae_C7" in job.roi_subset


# --------------------------------------------------------------------------
# 3. label registration + colours
# --------------------------------------------------------------------------

def test_structures_register_into_the_existing_label_store(client, store, stub, vol):
    job = ai.JOBS.submit(store["series_uid"], "totalseg",
                         tasks=["headneck_bones_vessels"])
    ai.JOBS.run_job(job)

    carotid = job.structures[0]
    assert carotid["n_voxels"] == 3 * 12 * 12
    voxel_ml = SLICE_MM * ROW_MM * COL_MM / 1000.0
    assert carotid["volume_ml"] == pytest.approx(carotid["n_voxels"] * voxel_ml,
                                                 rel=1e-6)

    # The label is not in the store yet -- registration is lazy on purpose.
    assert segmentation.LABELS.get(carotid["label_id"]) is None

    # ... and every existing label endpoint works once it is asked for.
    r = client.get("/api/analysis/label/{i}/stats".format(i=carotid["label_id"]))
    assert r.status_code == 200, r.text
    stats = r.json()
    assert stats["label_id"] == carotid["label_id"]
    assert stats["n_voxels"] == carotid["n_voxels"]
    assert stats["volume_ml"] == pytest.approx(carotid["volume_ml"], rel=1e-6)

    label = segmentation.LABELS.get(carotid["label_id"])
    assert label is not None
    assert label.label_id == carotid["label_id"]        # the id is stable
    assert label.mask.shape == vol.hu.shape
    assert label.meta["kind"] == "ai"
    assert label.meta["name"] == "common_carotid_artery_left"

    r = client.get("/api/analysis/label/{i}/mask".format(i=carotid["label_id"]))
    assert r.status_code == 200
    assert r.headers["X-Shape"] == "{z},{y},{x}".format(
        z=vol.hu.shape[0], y=vol.hu.shape[1], x=vol.hu.shape[2])

    r = client.get("/api/analysis/label/{i}/mesh".format(i=carotid["label_id"]))
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/sla"

    other = job.structures[1]
    r = client.post("/api/analysis/distance",
                    json={"label_a": carotid["label_id"],
                          "label_b": other["label_id"]})
    assert r.status_code == 200, r.text
    assert "min_distance_mm" in r.json()


def test_label_survives_eviction_from_the_lru(client, store, stub):
    job = ai.JOBS.submit(store["series_uid"], "totalseg",
                         tasks=["headneck_bones_vessels"])
    ai.JOBS.run_job(job)
    label_id = job.structures[0]["label_id"]

    assert client.get("/api/analysis/label/%s/stats" % label_id).status_code == 200
    segmentation.LABELS.clear()                      # simulate LRU eviction
    assert segmentation.LABELS.get(label_id) is None
    # Still resolvable: it is rebuilt from the cached multi-label NIfTI.
    r = client.get("/api/analysis/label/%s/stats" % label_id)
    assert r.status_code == 200, r.text
    assert r.json()["label_id"] == label_id


def test_unknown_label_is_still_404(client):
    r = client.get("/api/analysis/label/not-a-real-label/stats")
    assert r.status_code == 404


@pytest.mark.parametrize("name, channel", [
    ("common_carotid_artery_left", "red"),
    ("internal_carotid_artery_right", "red"),
    ("internal_jugular_vein_left", "blue"),
    ("brachiocephalic_vein_right", "blue"),
    ("trachea", "cyan"),
    ("larynx_air", "cyan"),
    ("thyroid_gland", "yellow"),
    ("parotid_gland_left", "yellow"),
    ("sternocleidomastoid_right", "rose"),
    ("inferior_pharyngeal_constrictor", "rose"),
])
def test_palette_families(name, channel):
    r, g, b = ai.color_for(name)
    if channel == "red":
        assert r > g + 60 and r > b + 60, (name, (r, g, b))
    elif channel == "blue":
        assert b > r + 60 and b > g + 40, (name, (r, g, b))
    elif channel == "cyan":
        assert g > r + 60 and b > r + 60, (name, (r, g, b))
    elif channel == "yellow":
        assert r > b + 60 and g > b + 60, (name, (r, g, b))
    elif channel == "rose":
        assert r > g + 40 and r > b + 30 and g >= 60, (name, (r, g, b))


def test_bone_and_cartilage_are_desaturated_and_light():
    for name in ("vertebrae_C4", "mandible", "skull", "hyoid", "clavicula_left"):
        r, g, b = ai.color_for(name)
        assert min(r, g, b) > 150, (name, (r, g, b))
        assert max(r, g, b) - min(r, g, b) < 60, (name, (r, g, b))
    for name in ("thyroid_cartilage", "cricoid_cartilage"):
        r, g, b = ai.color_for(name)
        assert min(r, g, b) > 130
        assert max(r, g, b) - min(r, g, b) < 40


def test_palette_is_stable_and_bilateral_pairs_match():
    assert ai.color_for("thyroid_gland") == ai.color_for("thyroid_gland")
    assert ai.color_for("parotid_gland_left") == ai.color_for("parotid_gland_right")
    assert ai.color_for("common_carotid_artery_left") == \
           ai.color_for("common_carotid_artery_right")
    # An unknown name still gets a deterministic colour rather than a random one.
    assert ai.color_for("some_unknown_structure") == \
           ai.color_for("some_unknown_structure")


def test_every_nodal_level_gets_its_own_hue():
    colors = [tuple(ai.color_for(v)) for v in ai.HNLNL_LABELS.values()]
    bases = {v.replace("_left", "").replace("_right", "")
             for v in ai.HNLNL_LABELS.values()}
    assert len(set(colors)) == len(bases) == 12
    assert ai.color_for("level_II_left") == ai.color_for("level_II_right")
    assert ai.color_for("level_II_left") != ai.color_for("level_III_left")


def test_hnlnl_label_table_is_complete():
    assert sorted(ai.HNLNL_LABELS) == list(range(1, 21))
    assert ai.HNLNL_LABELS[1] == "level_Ia"
    assert ai.HNLNL_LABELS[20] == "level_VIII_right"
    assert len(set(ai.HNLNL_LABELS.values())) == 20


# --------------------------------------------------------------------------
# 4. /api/ai/models with weights missing vs present
# --------------------------------------------------------------------------

def _stage_fake_weights(root: Path, dataset_ids, hnlnl: bool = False) -> None:
    results = root / "totalseg" / "nnunet" / "results"
    for i in dataset_ids:
        (results / "Dataset{i:03d}_fake".format(i=i)).mkdir(parents=True, exist_ok=True)
    if hnlnl:
        ck = (root / "hnlnl" / "nnunet_v1_results" / "3d_fullres"
              / "Task110_HNLNFixed_MirrorBest" / "nnUNetTrainerV2__nnUNetPlansv2.1")
        (ck / "fold_0").mkdir(parents=True, exist_ok=True)
        (ck / "plans.pkl").write_bytes(b"x")
        (ck / "fold_0" / "model_final_checkpoint.model").write_bytes(b"x")


def test_models_reports_everything_missing(client, monkeypatch, tmp_path):
    monkeypatch.setenv("HNRAD_MODELS_ROOT", str(tmp_path / "empty-models"))
    r = client.get("/api/ai/models")
    assert r.status_code == 200
    body = r.json()

    ts = next(m for m in body["models"] if m["model"] == "totalseg")
    assert ts["available"] is False
    for task in ts["tasks"]:
        assert task["weights_present"] is False
        assert task["missing_weights"], task["task"]

    hn = next(m for m in body["models"] if m["model"] == "hnlnl")
    assert hn["available"] is False
    assert hn["weights_present"] is False


def test_models_reports_weights_present_and_licences(client, monkeypatch, tmp_path):
    root = tmp_path / "models"
    _stage_fake_weights(root, [291, 292, 293, 294, 295, 776, 775, 778, 779,
                               115, 113, 297], hnlnl=True)
    monkeypatch.setenv("HNRAD_MODELS_ROOT", str(root))
    monkeypatch.setenv("HNRAD_AI_PYTHON", sys.executable)

    body = client.get("/api/ai/models").json()
    ts = next(m for m in body["models"] if m["model"] == "totalseg")
    assert ts["available"] is True

    by_task = {t["task"]: t for t in ts["tasks"]}
    assert set(by_task) == set(ai.TOTALSEG_TASKS)
    for name, task in by_task.items():
        assert task["weights_present"] is True, name
        assert task["missing_weights"] == []
        assert task["license"].startswith("Apache-2.0"), name
        assert task["n_classes"] and task["n_classes"] > 0

    # Verified against the installed TotalSegmentator, not against a README.
    assert by_task["headneck_bones_vessels"]["n_classes"] == 12
    assert "internal_carotid_artery_right" in \
           by_task["headneck_bones_vessels"]["classes"].values()
    assert by_task["total"]["n_classes"] == 117
    assert "common_carotid_artery_left" in by_task["total"]["classes"].values()
    assert "mandible" in by_task["craniofacial_structures"]["classes"].values()

    # Only `total` may run in fast mode; the subtasks have no fast weights.
    assert by_task["total"]["fast_allowed"] is True
    assert by_task["total"]["fast_weights_present"] is True
    assert by_task["headneck_bones_vessels"]["fast_allowed"] is False

    # Each subtask depends on another model to crop first.
    assert by_task["headneck_bones_vessels"]["crop_from"] == "total"
    assert by_task["teeth"]["crop_from"] == "craniofacial_structures"

    hn = next(m for m in body["models"] if m["model"] == "hnlnl")
    assert hn["available"] is True
    assert hn["license"].startswith("CC0-1.0")
    assert hn["n_classes"] == 20
    assert hn["classes"]["4"] == "level_II_left"


def test_models_flags_a_missing_crop_model(client, monkeypatch, tmp_path):
    """A subtask whose own weights are present is still unusable without its
    crop model, and must say so."""
    root = tmp_path / "models"
    _stage_fake_weights(root, [776])          # no 291..295 = no `total`
    monkeypatch.setenv("HNRAD_MODELS_ROOT", str(root))

    body = client.get("/api/ai/models").json()
    ts = next(m for m in body["models"] if m["model"] == "totalseg")
    task = next(t for t in ts["tasks"] if t["task"] == "headneck_bones_vessels")
    assert task["weights_present"] is False
    assert "Dataset291_*" in task["missing_weights"]


# --------------------------------------------------------------------------
# 5. the HTTP surface
# --------------------------------------------------------------------------

def test_segment_endpoint_drives_a_job_to_completion(client, store, stub, monkeypatch):
    ai.JOBS.autostart = True                   # let the real worker thread run
    r = client.post("/api/ai/segment",
                    json={"series_uid": store["series_uid"], "model": "totalseg",
                          "tasks": ["headneck_bones_vessels"]})
    assert r.status_code == 200, r.text
    body = r.json()
    # The worker is quick enough with a stub that it can already have picked
    # the job up by the time the POST returns; only 'done' would be a bug.
    assert body["status"] in ("queued", "running")
    job_id = body["job_id"]

    deadline = time.time() + 60
    state = {}
    while time.time() < deadline:
        state = client.get("/api/ai/jobs/{i}".format(i=job_id)).json()
        if state["status"] in ("done", "error"):
            break
        time.sleep(0.1)

    assert state["status"] == "done", state.get("log_tail")
    assert state["progress"] == 1.0
    assert state["started_at"] and state["finished_at"]
    assert isinstance(state["log_tail"], list) and state["log_tail"]
    names = [s["name"] for s in state["structures"]]
    assert names == ["common_carotid_artery_left", "internal_jugular_vein_right"]
    for s in state["structures"]:
        assert len(s["color"]) == 3
        assert all(0 <= c <= 255 for c in s["color"])

    listed = client.get("/api/ai/jobs").json()
    assert any(j["job_id"] == job_id for j in listed)

    r = client.delete("/api/ai/jobs/{i}".format(i=job_id))
    assert r.status_code == 200
    assert client.get("/api/ai/jobs/{i}".format(i=job_id)).status_code == 404


def test_segment_rejects_unknown_series_and_model(client, store):
    r = client.post("/api/ai/segment", json={"series_uid": "1.2.3.nope"})
    assert r.status_code == 404

    r = client.post("/api/ai/segment",
                    json={"series_uid": store["series_uid"], "model": "magic"})
    assert r.status_code == 400
    assert "model must be one of" in r.json()["detail"]

    r = client.post("/api/ai/segment",
                    json={"series_uid": store["series_uid"],
                          "tasks": ["definitely_not_a_task"]})
    assert r.status_code == 400


def test_unknown_job_is_404(client):
    assert client.get("/api/ai/jobs/nope").status_code == 404
    assert client.delete("/api/ai/jobs/nope").status_code == 404


def test_class_map_json_is_present_and_matches_the_catalogue():
    """backend/ai/class_map.json is a build artefact -- fail loudly if stale."""
    data = ai.class_map()
    assert data.get("totalsegmentator_version"), "run backend/ai/dump_classes.py"
    for task in ai.TOTALSEG_TASKS:
        assert task in data["tasks"], task
        assert "error" not in data["tasks"][task], data["tasks"][task]
    # Every default ROI name must really exist in the installed `total` model.
    total = set(data["tasks"]["total"]["classes"].values())
    missing = [n for n in ai.DEFAULT_ROI_SUBSET if n not in total]
    assert not missing, missing
