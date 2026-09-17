"""Tests for the Margin MCP server (backend/hnrad/mcp_server.py).

Two layers:

* unit tests that mock the backend with ``httpx.MockTransport`` -- health
  mapping, HTTP error conversion, airway array summarisation, the STL export
  path guard and the "AI routes not available" fallback;
* live smoke tests against a running backend on ``MARGIN_API`` (default
  http://127.0.0.1:8765), skipped automatically when nothing answers.
"""

from __future__ import annotations

import json
import math
import os
import struct

import sys
from pathlib import Path

import anyio
import httpx
import pytest

# Work whether pytest is run from backend/ (the usual way) or from the repo
# root as `backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_mcp.py`.
_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from hnrad import mcp_server as M  # noqa: E402

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _no_real_backend():
    """Make sure no test leaks a client override into the next one."""
    yield
    M._client_override = None


def mock_backend(handler):
    """Point the MCP server at a fake backend and return the httpx client."""
    client = httpx.Client(transport=httpx.MockTransport(handler),
                          base_url="http://mock-backend")
    M._client_override = client
    return client


def json_response(payload, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=payload)


def fake_stl(n_triangles: int = 7) -> bytes:
    """A minimal but structurally valid binary STL."""
    return (b"margin test stl".ljust(80, b"\0")
            + struct.pack("<I", n_triangles)
            + b"\0" * (50 * n_triangles))


def make_airway_payload(n: int = 180) -> dict:
    """An airway result with *n* samples, tuned to a known narrative."""
    # A smooth tube that pinches at sample 60 (or at the end of a short run).
    pinch = min(60, n - 1)
    csa = []
    for i in range(n):
        base = 268.0
        dip = 217.1 * math.exp(-((i - pinch) ** 2) / (2 * 4.0 ** 2))
        csa.append(round(base - dip, 4))
    csa[pinch] = 50.9                    # exact minimum
    arclen = [round(i * 0.5, 4) for i in range(n)]
    eq = [round(2.0 * math.sqrt(a / math.pi), 4) for a in csa]
    return {
        "label_id": "lab-airway-1",
        "centerline_lps": [[0.0, 0.0, -100.0 + i * 0.5] for i in range(n)],
        "arclength_mm": arclen,
        "csa_mm2": csa,
        "eq_diameter_mm": eq,
        "min_diameter_mm": [round(e * 0.9, 4) for e in eq],
        "max_diameter_mm": [round(e * 1.1, 4) for e in eq],
        "csa_ref_mm2": 267.9,
        "min_csa_mm2": 50.9,
        "min_csa_index": pinch,
        "min_csa_lps": [1.0, 2.0, -70.0],
        "stenosis_pct": 81.0,
        "stenosis_length_mm": 12.0,
        "distance_from_glottis_mm": 6.0,
        "myer_cotton_grade": "III",
        "took_ms": 4321.0,
    }


# --------------------------------------------------------------------------
# health / plumbing
# --------------------------------------------------------------------------


def test_health_maps_backend_payload():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        return json_response({"status": "ok", "version": "0.1.0",
                              "db_path": r"C:\x\hnrad.sqlite",
                              "studies_root": r"C:\x\studies"})

    mock_backend(handler)
    out = M.health()
    assert seen == [("GET", "/api/health")]
    assert out["status"] == "ok"
    assert out["version"] == "0.1.0"
    assert out["studies_root"] == r"C:\x\studies"
    assert out["api"] == M.base_url()          # the tool echoes the base URL


def test_base_url_honours_margin_api(monkeypatch):
    monkeypatch.setenv("MARGIN_API", "http://127.0.0.1:9999/")
    assert M.base_url() == "http://127.0.0.1:9999"
    monkeypatch.delenv("MARGIN_API")
    assert M.base_url() == M.DEFAULT_API


def test_list_studies_passes_patient_filter():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["query"] = dict(request.url.params)
        return json_response([{"study_uid": "1.2.3", "patient_id": "P1"}])

    mock_backend(handler)
    out = M.list_studies(patient_id="P1")
    assert seen["query"] == {"patient_id": "P1"}
    assert out["n"] == 1 and out["studies"][0]["study_uid"] == "1.2.3"

    M.list_studies()
    assert seen["query"] == {}                  # None is dropped, not sent


def test_get_series_summarises_instances():
    instances = [{"sop_uid": "s{i}".format(i=i), "instance_number": i + 1,
                  "ipp": [0.0, 0.0, 5.0 + i], "slice_pos": 5.0 + i}
                 for i in range(180)]

    def handler(request: httpx.Request) -> httpx.Response:
        return json_response({"series_uid": "1.2.9", "modality": "CT",
                              "rows": 512, "cols": 512, "is_3d": True,
                              "instances": instances})

    mock_backend(handler)
    out = M.get_series("1.2.9")
    assert "instances" not in out               # no 180-item dump
    assert out["n_instances"] == 180
    assert out["k_range"] == [0, 179]
    assert out["first_slice"]["slice_pos"] == 5.0
    assert out["last_slice"]["slice_pos"] == 184.0
    assert out["slice_span_mm"] == 179.0

    full = M.get_series("1.2.9", include_instances=True)
    assert len(full["instances"]) == 180


# --------------------------------------------------------------------------
# error conversion
# --------------------------------------------------------------------------


def test_http_404_becomes_readable_error_with_detail():
    def handler(request: httpx.Request) -> httpx.Response:
        return json_response({"detail": "unknown series_uid 1.2.3"}, status=404)

    mock_backend(handler)
    out = M.threshold("1.2.3", lower_hu=300, upper_hu=3000)
    assert set(out) == {"error"}
    assert "404" in out["error"]
    assert "unknown series_uid 1.2.3" in out["error"]
    assert "/api/analysis/threshold" in out["error"]


def test_http_400_detail_is_surfaced():
    def handler(request: httpx.Request) -> httpx.Response:
        return json_response({"detail": "seed HU -12 outside [300, 3000]"},
                             status=400)

    mock_backend(handler)
    out = M.region_grow("1.2.3", 300, 3000, seed_ijk=[10, 10, 10])
    assert "seed HU -12 outside [300, 3000]" in out["error"]


def test_validation_422_detail_is_json_encoded():
    def handler(request: httpx.Request) -> httpx.Response:
        return json_response(
            {"detail": [{"loc": ["body", "lower_hu"], "msg": "field required"}]},
            status=422)

    mock_backend(handler)
    out = M.threshold("1.2.3", 1, 2)
    assert "422" in out["error"] and "field required" in out["error"]


def test_connection_failure_names_the_backend(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    monkeypatch.setenv("MARGIN_API", "http://127.0.0.1:8765")
    mock_backend(handler)
    out = M.health()
    assert "Cannot reach the Margin backend" in out["error"]
    assert "127.0.0.1:8765" in out["error"]
    assert "run.ps1" in out["error"]


def test_seed_validation_never_hits_the_network():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return json_response({})

    mock_backend(handler)
    both = M.region_grow("1.2.3", 0, 100, seed_ijk=[1, 2, 3], seed_lps=[1, 2, 3])
    neither = M.region_grow("1.2.3", 0, 100)
    assert "exactly one" in both["error"] and "exactly one" in neither["error"]
    assert calls == []


# --------------------------------------------------------------------------
# label stats / distance
# --------------------------------------------------------------------------


def test_threshold_returns_compact_rounded_stats():
    payload = {"label_id": "abc", "n_voxels": 123456,
               "volume_ml": 12.3456789, "bbox_ijk": [1, 2, 3, 40, 50, 60],
               "centroid_lps": [1.23456, -2.34567, 3.45678],
               "mean_hu": 812.34567, "std_hu": 210.98765,
               "longest_axis_mm": 98.76543,
               "diameters_mm": [98.7654, 43.2109, 21.0987],
               "took_ms": 1234.5678}

    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["inside_body"] is True
        return json_response(payload)

    mock_backend(handler)
    out = M.threshold("1.2.3", 300, 3000)
    assert out["volume_ml"] == 12.346
    assert out["centroid_lps"] == [1.2, -2.3, 3.5]
    assert out["mean_hu"] == 812.3
    assert out["diameters_mm"] == [98.8, 43.2, 21.1]
    assert out["took_ms"] == 1235


def test_label_distance_keeps_the_sign():
    def handler(request: httpx.Request) -> httpx.Response:
        return json_response({"min_distance_mm": -1.234,
                              "point_a_lps": [1.0, 2.0, 3.0],
                              "point_b_lps": [1.1, 2.1, 3.1]})

    mock_backend(handler)
    out = M.label_distance("a", "b")
    assert out["min_distance_mm"] == -1.23
    assert "overlap" in out["note"]


# --------------------------------------------------------------------------
# airway summarisation
# --------------------------------------------------------------------------


def test_airway_profile_summarises_180_samples():
    payload = make_airway_payload(180)
    instances = [{"sop_uid": "s{i}".format(i=i), "ipp": [0.0, 0.0, -100.0 + i],
                  "slice_pos": -100.0 + i} for i in range(180)]
    paths = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path == "/api/analysis/airway":
            body = json.loads(request.content)
            assert body["seed_ijk"] == [256, 195, 20]
            assert body["glottis_slice"] == 66
            return json_response(payload)
        return json_response({"series_uid": "1.2.9", "instances": instances})

    mock_backend(handler)
    out = M.airway_profile("1.2.9", seed_ijk=[256, 195, 20], glottis_slice=66)

    # The raw arrays are gone; only the 12-point table survives.
    assert out["n_samples"] == 180
    for key in ("csa_mm2", "eq_diameter_mm", "arclength_mm"):
        assert set(out[key]) == {"min", "max"}
    assert len(out["profile"]) == M.PROFILE_POINTS == 12
    assert out["profile"][0]["i"] == 0
    assert out["profile"][-1]["i"] == 179
    assert [p["i"] for p in out["profile"]] == sorted(p["i"] for p in out["profile"])
    for point in out["profile"]:
        assert set(point) == {"i", "arclength_mm", "csa_mm2", "eq_diameter_mm"}

    # Nothing else sneaks a long array through.
    for key, value in out.items():
        if isinstance(value, list):
            assert len(value) <= M.MAX_ARRAY, key

    assert out["min_csa_mm2"] == 50.9
    assert out["min_eq_diameter_mm"] == 8.1
    assert out["min_csa_arclength_mm"] == 30.0
    assert out["myer_cotton_grade"] == "III"
    assert out["label_id"] == "lab-airway-1"


def test_airway_narrative_reads_like_a_surgeon_wrote_it():
    payload = make_airway_payload(180)
    instances = [{"ipp": [0.0, 0.0, -100.0 + i]} for i in range(180)]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/analysis/airway":
            return json_response(payload)
        return json_response({"instances": instances})

    mock_backend(handler)
    out = M.airway_profile("1.2.9", seed_ijk=[256, 195, 20], glottis_slice=66)
    # the sentence and the structured fields must agree
    assert "{a} mm".format(a=out["min_csa_mm2"]) in out["narrative"]
    assert "{d} mm".format(d=out["min_eq_diameter_mm"]) in out["narrative"]
    assert out["narrative"] == (
        "Minimum cross-sectional area 50.9 mm\u00b2 (equivalent diameter "
        "8.1 mm) at 6 mm below the glottis; 81% area reduction over 12 mm; "
        "Myer\u2013Cotton grade III")


def test_airway_narrative_without_glottis_uses_arclength():
    payload = make_airway_payload(40)
    payload["distance_from_glottis_mm"] = None
    payload["myer_cotton_grade"] = None

    def handler(request: httpx.Request) -> httpx.Response:
        return json_response(payload)

    mock_backend(handler)
    out = M.airway_profile("1.2.9", seed_lps=[0.0, 0.0, 0.0])
    assert "glottis" not in out["narrative"]
    assert "along the airway from the caudal end" in out["narrative"]
    assert "Myer" not in out["narrative"]
    assert len(out["profile"]) == 12


def test_airway_profile_keeps_short_series_intact():
    payload = make_airway_payload(5)

    def handler(request: httpx.Request) -> httpx.Response:
        return json_response(payload)

    mock_backend(handler)
    out = M.airway_profile("1.2.9", seed_ijk=[1, 2, 3])
    assert [p["i"] for p in out["profile"]] == [0, 1, 2, 3, 4]


def test_downsample_indices_are_evenly_spread():
    idxs = M._downsample_indices(180, 12)
    assert idxs[0] == 0 and idxs[-1] == 179 and len(idxs) == 12
    assert M._downsample_indices(0) == []
    assert M._downsample_indices(3) == [0, 1, 2]


# --------------------------------------------------------------------------
# STL export guard
# --------------------------------------------------------------------------


@pytest.fixture()
def exports(tmp_path, monkeypatch):
    monkeypatch.setenv("HNRAD_DATA_ROOT", str(tmp_path))
    root = tmp_path / "exports"
    root.mkdir(parents=True, exist_ok=True)
    return root


def test_export_label_stl_writes_inside_the_exports_folder(exports):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/analysis/label/lab1/mesh"
        assert dict(request.url.params) == {"smooth_iters": "10"}
        return httpx.Response(200, content=fake_stl(1234),
                              headers={"content-type": "application/sla"})

    mock_backend(handler)
    out = M.export_label_stl("lab1", "airway.stl")
    assert out["n_triangles"] == 1234
    assert out["path"] == str(exports / "airway.stl")
    assert (exports / "airway.stl").read_bytes()[:6] == b"margin"


def test_export_label_stl_adds_the_extension(exports):
    mock_backend(lambda r: httpx.Response(200, content=fake_stl(2)))
    out = M.export_label_stl("lab1", "sub/dir/mandible")
    assert out["path"].endswith(".stl")
    assert (exports / "sub" / "dir" / "mandible.stl").exists()


@pytest.mark.parametrize("bad", [
    r"C:\Windows\System32\evil.stl",
    r"C:\Users\Public\out.stl",
    "../escape.stl",
    r"..\..\escape.stl",
    "sub/../../escape.stl",
    ".",
])
def test_export_label_stl_refuses_paths_outside_exports(exports, bad):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, content=fake_stl())

    mock_backend(handler)
    out = M.export_label_stl("lab1", bad)
    assert "error" in out, out
    assert "Refusing to write outside" in out["error"]
    assert calls == []                      # refused before any HTTP traffic


def test_exports_root_follows_the_data_root(exports, tmp_path):
    assert M.exports_root() == tmp_path / "exports"


# --------------------------------------------------------------------------
# AI routes (may not exist on this backend yet)
# --------------------------------------------------------------------------


def test_ai_tools_report_missing_routes_clearly():
    def handler(request: httpx.Request) -> httpx.Response:
        return json_response({"detail": "Not Found"}, status=404)

    mock_backend(handler)
    for out in (M.ai_models(),
                M.ai_segment("1.2.3", "totalseg"),
                M.ai_job("job-1")):
        assert out["error"] == M._AI_MISSING
        assert "AI routes not available in this backend version" in out["error"]


def test_ai_job_404_for_a_real_route_keeps_the_detail():
    def handler(request: httpx.Request) -> httpx.Response:
        return json_response({"detail": "unknown job_id job-9"}, status=404)

    mock_backend(handler)
    out = M.ai_job("job-9")
    assert "unknown job_id job-9" in out["error"]
    assert "AI routes not available" not in out["error"]


def test_ai_segment_posts_the_expected_body():
    body = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body.update(json.loads(request.content))
        return json_response({"job_id": "j1", "status": "queued"})

    mock_backend(handler)
    out = M.ai_segment("1.2.3", "totalseg", roi_subset=["trachea"], fast=True)
    assert body == {"series_uid": "1.2.3", "model": "totalseg",
                    "fast": True, "roi_subset": ["trachea"]}
    assert out == {"job_id": "j1", "status": "queued"}


def test_ai_job_truncates_huge_structure_lists():
    def handler(request: httpx.Request) -> httpx.Response:
        return json_response({"status": "done", "progress": 1.0,
                              "structures": [{"name": "s%d" % i,
                                              "label_id": "l%d" % i}
                                             for i in range(117)]})

    mock_backend(handler)
    out = M.ai_job("j1")
    assert len(out["structures"]) == M.MAX_ARRAY
    assert out["structures_truncated"] == 117


# --------------------------------------------------------------------------
# MCP wiring: in-process client
# --------------------------------------------------------------------------


def test_tools_and_resources_are_registered():
    async def go():
        tools = await M.mcp.list_tools()
        resources = await M.mcp.list_resources()
        return tools, resources

    tools, resources = anyio.run(go)
    names = {t.name for t in tools}
    assert names == {
        "health", "list_patients", "list_studies", "list_series", "get_series",
        "import_folder", "region_grow", "threshold", "label_stats",
        "label_distance", "delete_label", "export_label_stl", "airway_profile",
        "roi_stats", "ai_models", "ai_segment", "ai_job",
    }
    for tool in tools:
        assert tool.description and len(tool.description) > 60, tool.name
    assert {str(r.uri) for r in resources} == {"margin://studies",
                                              "margin://contract"}
    assert "LPS millimetres" in M.mcp.instructions
    assert "column, row, slice" in M.mcp.instructions


def test_call_tool_through_the_server_returns_structured_json():
    def handler(request: httpx.Request) -> httpx.Response:
        return json_response({"status": "ok", "version": "0.1.0",
                              "db_path": "db", "studies_root": "studies"})

    mock_backend(handler)

    async def go():
        return await M.mcp.call_tool("health", {})

    result = anyio.run(go)
    assert result.is_error is False
    assert result.structured_content["status"] == "ok"
    assert json.loads(result.content[0].text)["version"] == "0.1.0"


def test_contract_resource_is_the_real_document():
    text = M.resource_contract()
    assert "HNRad architecture and API contract" in text
    assert "Analysis API v0.2" in text


def test_studies_resource_returns_json():
    def handler(request: httpx.Request) -> httpx.Response:
        return json_response([{"study_uid": "1.2.3"}])

    mock_backend(handler)
    assert json.loads(M.resource_studies()) == [{"study_uid": "1.2.3"}]


def test_studies_resource_reports_backend_trouble():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope", request=request)

    mock_backend(handler)
    assert "Cannot reach" in json.loads(M.resource_studies())["error"]


# --------------------------------------------------------------------------
# live smoke tests against a running backend
# --------------------------------------------------------------------------


def _backend_live() -> bool:
    try:
        r = httpx.get(M.base_url() + "/api/health", timeout=3.0)
        return r.status_code == 200
    except httpx.HTTPError:
        return False


live = pytest.mark.skipif(not _backend_live(),
                          reason="no Margin backend on " + M.base_url())


@pytest.fixture()
def phantom():
    """(series_uid, n_slices) of the PHANTOM_NECK series, or skip."""
    M._client_override = None
    studies = M.list_studies()
    assert "error" not in studies, studies
    for study in studies["studies"]:
        if "PHANTOM" in (study.get("patient_id") or "").upper():
            series = M.list_series(study["study_uid"])["series"]
            for row in series:
                if row.get("is_3d"):
                    return row["series_uid"], row.get("instance_count")
    pytest.skip("no PHANTOM study imported")


@live
def test_live_health_and_library():
    out = M.health()
    assert out["status"] == "ok"
    studies = M.list_studies()
    assert studies["n"] >= 1
    print("\n[live] studies:",
          [(s["patient_name"], s["description"]) for s in studies["studies"]])


@live
def test_live_get_series_is_summarised(phantom):
    series_uid, n = phantom
    out = M.get_series(series_uid)
    assert "instances" not in out
    assert out["n_instances"] == n
    assert out["k_range"] == [0, n - 1]
    print("\n[live] series {u} {n} slices, span {s} mm".format(
        u=series_uid[-12:], n=out["n_instances"], s=out["slice_span_mm"]))


@live
def test_live_threshold_bone(phantom):
    series_uid, _ = phantom
    out = M.threshold(series_uid, lower_hu=300, upper_hu=3000,
                      inside_body=True, keep_largest=False)
    assert "error" not in out, out
    assert out["n_voxels"] > 0 and out["volume_ml"] > 0
    print("\n[live] bone threshold: {v} mL, mean {h} HU, {n} voxels in {t} ms"
          .format(v=out["volume_ml"], h=out["mean_hu"], n=out["n_voxels"],
                  t=out["took_ms"]))
    # The dev backend runs with --reload, and writing .pyc files under backend/
    # can restart it mid-test, which wipes the in-memory label store. A 404 here
    # is therefore acceptable -- but it must be a readable one.
    stats = M.label_stats(out["label_id"])
    if "error" in stats:
        assert "404" in stats["error"] and "label" in stats["error"].lower()
    else:
        assert stats["n_voxels"] == out["n_voxels"]
        deleted = M.delete_label(out["label_id"])
        assert deleted.get("deleted") == out["label_id"], deleted


@live
def test_live_airway_profile(phantom):
    series_uid, _ = phantom
    out = M.airway_profile(series_uid, seed_ijk=[256, 195, 20],
                           glottis_slice=66)
    assert "error" not in out, out
    assert out["n_samples"] > 12
    assert len(out["profile"]) == 12
    assert out["min_csa_mm2"] > 0
    assert out["myer_cotton_grade"] in {"I", "II", "III", "IV", None}
    print("\n[live] airway ({n} samples, {t} ms)".format(
        n=out["n_samples"], t=out["took_ms"]))
    print("[live] NARRATIVE:", out["narrative"])
    print("[live] profile:", json.dumps(out["profile"]))


@live
def test_live_ai_routes_absent_or_working():
    out = M.ai_models()
    if "error" in out:
        assert "AI routes not available in this backend version" in out["error"]
        print("\n[live] AI routes:", out["error"])
    else:
        print("\n[live] AI models:", out["models"])
