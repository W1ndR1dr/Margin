"""Margin MCP server -- lets Claude drive the local HNRad backend.

A *separate process* from the FastAPI backend: it speaks MCP over stdio to the
client (Claude Code / Claude Desktop) and plain HTTP to
``http://127.0.0.1:8765`` (override with the ``MARGIN_API`` environment
variable).  It never touches the database, the DICOM files or the volume cache
directly -- everything goes through the REST API documented in CONTRACT.md.

Run it with::

    backend\\.venv\\Scripts\\python.exe -m hnrad.mcp_server

or via ``backend\\mcp\\run-mcp.ps1``.
"""

from __future__ import annotations

import json
import logging
import math
import os
import struct
import sys
from functools import wraps
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence, TypeVar

import httpx
from mcp.server.mcpserver import MCPServer

__all__ = ["mcp", "main", "MarginError"]

log = logging.getLogger("hnrad.mcp")

DEFAULT_API = "http://127.0.0.1:8765"

#: Timeout (seconds) for everything that is a database / metadata read.
FAST_TIMEOUT = 15.0
#: Timeout (seconds) for segmentation, ROI and mesh calls.
ANALYSIS_TIMEOUT = 30.0
#: Timeout (seconds) for airway analysis and folder import.
SLOW_TIMEOUT = 120.0

#: How many samples the airway profile table is downsampled to.
PROFILE_POINTS = 12
#: Hard cap on the length of any array a tool returns unencouraged.
MAX_ARRAY = 50


INSTRUCTIONS = """\
Margin is a LOCAL-ONLY head & neck surgical radiology assistant. Every study,
every voxel and every result stays on this machine; nothing is uploaded, and no
tool here reaches the internet. The data is personal/research material, not a
cleared diagnostic device -- treat every number as a measurement to be checked
by the surgeon, never as a diagnosis.

Conventions used by every tool (from CONTRACT.md, readable in full via the
`margin://contract` resource):

* HU -- all intensities are Hounsfield units (stored_value * RescaleSlope +
  RescaleIntercept). Air about -1000, fat -100, water 0, soft tissue 30-70,
  contrast-filled vessels 200-400, cortical bone 700+.
* `ijk` = `[i, j, k]` = `[column, row, slice]`. Slice `k` indexes the series
  sorted ascending by `slice_pos`, i.e. the order `get_series` returns; k = 0 is
  the most inferior (caudal) slice. Voxel arrays are (z, y, x) = (k, j, i).
* `*_lps` are patient coordinates in LPS millimetres: +x = patient Left,
  +y = Posterior, +z = Superior.
* `bbox_ijk` is `[i_min, j_min, k_min, i_max, j_max, k_max]`, inclusive.
* Volumes are millilitres, areas mm^2, distances and diameters millimetres,
  angles degrees, `took_ms` server-side milliseconds.

Labels (segmentations) live in memory on the backend, keyed by `label_id`, in
an LRU of 20 that does NOT survive a backend restart. If a label call returns
404, just re-run the segmentation that produced it.

Typical flow: `list_studies` -> `list_series` -> `get_series` (for geometry) ->
`threshold` / `region_grow` / `airway_profile` -> `label_stats`,
`label_distance`, `export_label_stl`. Ask the user for a seed point or hand
them the ijk you used, so they can verify it in the viewer.
"""


# --------------------------------------------------------------------------
# HTTP plumbing
# --------------------------------------------------------------------------


class MarginError(RuntimeError):
    """A backend call that failed in a way worth showing to the model."""

    def __init__(self, message: str, *, status: int | None = None,
                 detail: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.detail = detail


def base_url() -> str:
    """Backend base URL, honouring the ``MARGIN_API`` environment variable."""
    return os.environ.get("MARGIN_API", DEFAULT_API).rstrip("/")


#: Test hook: assign an ``httpx.Client`` (e.g. one wired to a MockTransport)
#: and every tool will use it instead of talking to a real backend.
_client_override: httpx.Client | None = None
_clients: dict[str, httpx.Client] = {}


def _get_client() -> httpx.Client:
    if _client_override is not None:
        return _client_override
    url = base_url()
    client = _clients.get(url)
    if client is None:
        client = httpx.Client(base_url=url, timeout=FAST_TIMEOUT,
                              headers={"User-Agent": "margin-mcp/0.1"})
        _clients[url] = client
    return client


def _detail_of(resp: httpx.Response) -> str:
    """Pull FastAPI's ``{detail: ...}`` out of an error response."""
    try:
        body = resp.json()
    except Exception:
        text = (resp.text or "").strip()
        return text[:400] if text else "<no body>"
    if isinstance(body, dict) and "detail" in body:
        detail = body["detail"]
        if isinstance(detail, str):
            return detail
        return json.dumps(detail, separators=(",", ":"))[:800]
    return json.dumps(body, separators=(",", ":"))[:400]


def _request(method: str, path: str, *, json_body: Any = None,
             params: dict[str, Any] | None = None,
             timeout: float = FAST_TIMEOUT) -> httpx.Response:
    """One HTTP call, with every failure turned into a readable MarginError."""
    client = _get_client()
    clean = {k: v for k, v in (params or {}).items() if v is not None}
    try:
        resp = client.request(method, path, json=json_body,
                              params=clean or None, timeout=timeout)
    except httpx.TimeoutException as exc:
        raise MarginError(
            "Timed out after {t:.0f}s on {m} {p}. The backend may still be "
            "working -- long segmentations can exceed the limit.".format(
                t=timeout, m=method, p=path)
        ) from exc
    except httpx.HTTPError as exc:
        raise MarginError(
            "Cannot reach the Margin backend at {u} ({e}). Start it with "
            "backend\\run.ps1 and check GET /api/health.".format(
                u=base_url(), e=exc.__class__.__name__)
        ) from exc

    if resp.status_code >= 400:
        detail = _detail_of(resp)
        raise MarginError(
            "{m} {p} failed: HTTP {c} -- {d}".format(
                m=method, p=path, c=resp.status_code, d=detail),
            status=resp.status_code, detail=detail,
        )
    return resp


def _get(path: str, **kw: Any) -> Any:
    return _request("GET", path, **kw).json()


def _post(path: str, body: Any, **kw: Any) -> Any:
    return _request("POST", path, json_body=body, **kw).json()


F = TypeVar("F", bound=Callable[..., Any])


def _tool(fn: F) -> F:
    """Turn MarginError into ``{"error": "..."}`` so the model can read it."""

    @wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return fn(*args, **kwargs)
        except MarginError as exc:
            return {"error": str(exc)}

    return wrapper  # type: ignore[return-value]


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------


def _r(value: Any, digits: int = 2) -> Any:
    """Round floats for compact output; pass anything else through."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int,)):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return round(value, digits)
    if isinstance(value, (list, tuple)):
        return [_r(v, digits) for v in value]
    return value


def _seed_body(seed_ijk: Sequence[int] | None,
               seed_lps: Sequence[float] | None) -> dict[str, Any]:
    """Validate that exactly one seed was given and build the request fragment."""
    if (seed_ijk is None) == (seed_lps is None):
        raise MarginError(
            "Provide exactly one of seed_ijk ([column, row, slice], integers) "
            "or seed_lps ([x, y, z] in LPS millimetres).")
    if seed_ijk is not None:
        if len(seed_ijk) != 3:
            raise MarginError("seed_ijk must be 3 integers [i, j, k] = "
                              "[column, row, slice].")
        return {"seed_ijk": [int(v) for v in seed_ijk]}
    assert seed_lps is not None
    if len(seed_lps) != 3:
        raise MarginError("seed_lps must be 3 floats [x, y, z] in LPS mm.")
    return {"seed_lps": [float(v) for v in seed_lps]}


def _label_stats_out(stats: dict[str, Any]) -> dict[str, Any]:
    """Compact, rounded LabelStats."""
    return {
        "label_id": stats.get("label_id"),
        "n_voxels": stats.get("n_voxels"),
        "volume_ml": _r(stats.get("volume_ml"), 3),
        "bbox_ijk": stats.get("bbox_ijk"),
        "centroid_lps": _r(stats.get("centroid_lps"), 1),
        "mean_hu": _r(stats.get("mean_hu"), 1),
        "std_hu": _r(stats.get("std_hu"), 1),
        "longest_axis_mm": _r(stats.get("longest_axis_mm"), 1),
        "diameters_mm": _r(stats.get("diameters_mm"), 1),
        "took_ms": _r(stats.get("took_ms"), 0),
        "units": "volume_ml = millilitres, lengths mm, HU Hounsfield",
    }


def _downsample_indices(n: int, points: int = PROFILE_POINTS) -> list[int]:
    """Evenly spaced indices over ``range(n)``, always including 0 and n-1."""
    if n <= 0:
        return []
    if n <= points:
        return list(range(n))
    step = (n - 1) / (points - 1)
    out: list[int] = []
    for p in range(points):
        idx = int(round(p * step))
        idx = max(0, min(n - 1, idx))
        if not out or idx != out[-1]:
            out.append(idx)
    return out


def _eq_diameter(csa_mm2: Any) -> float | None:
    """Equivalent circular diameter (mm) of a cross-sectional area (mm^2).

    Derived from the *rounded* area so the narrative never prints an area and a
    diameter that disagree with each other.
    """
    if not isinstance(csa_mm2, (int, float)) or isinstance(csa_mm2, bool):
        return None
    area = round(float(csa_mm2), 1)
    if area <= 0:
        return None
    return round(2.0 * math.sqrt(area / math.pi), 1)


def _span(values: Iterable[float]) -> dict[str, Any] | None:
    vals = [float(v) for v in values if v is not None and not math.isnan(float(v))]
    if not vals:
        return None
    return {"min": _r(min(vals), 2), "max": _r(max(vals), 2)}


# --------------------------------------------------------------------------
# export path guard
# --------------------------------------------------------------------------


def exports_root() -> Path:
    """The only directory ``export_label_stl`` is allowed to write into."""
    env = os.environ.get("HNRAD_DATA_ROOT")
    if env:
        root = Path(env)
    else:
        local = os.environ.get("LOCALAPPDATA")
        base = Path(local) if local else Path.home() / "AppData" / "Local"
        root = base / "HNRad"
    return root / "exports"


def _safe_export_path(out_path: str) -> Path:
    """Resolve *out_path* inside :func:`exports_root`, or refuse."""
    root = Path(os.path.realpath(str(exports_root())))
    candidate = Path(out_path.strip().strip('"'))
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = Path(os.path.realpath(str(candidate)))
    if resolved == root or not resolved.is_relative_to(root):
        raise MarginError(
            "Refusing to write outside the Margin exports folder. "
            "out_path must be a file under {r} (a bare filename like "
            "'airway.stl' works).".format(r=root))
    if resolved.suffix.lower() != ".stl":
        resolved = resolved.with_suffix(".stl")
    return resolved


def _stl_triangles(blob: bytes) -> int | None:
    """Triangle count from a binary STL header (bytes 80..84)."""
    if len(blob) < 84:
        return None
    return int(struct.unpack("<I", blob[80:84])[0])


# --------------------------------------------------------------------------
# server
# --------------------------------------------------------------------------

mcp = MCPServer(
    name="margin",
    title="Margin (HNRad) -- local head & neck radiology",
    instructions=INSTRUCTIONS,
    version="0.1.0",
)


# ---- library -------------------------------------------------------------


@mcp.tool()
@_tool
def health() -> dict[str, Any]:
    """Check that the local Margin backend is running and reachable.

    Returns the backend status, version, SQLite index path and studies root.
    Call this first if anything else fails; if it reports an error the backend
    is not running (start it with backend\\run.ps1).
    """
    out = dict(_get("/api/health"))
    out["api"] = base_url()
    return out


@mcp.tool()
@_tool
def list_patients() -> dict[str, Any]:
    """List every patient in the local DICOM index.

    Returns patient_id, name, sex, birth_date and study_count for each.
    """
    rows = _get("/api/patients")
    return {"n": len(rows), "patients": rows[:MAX_ARRAY],
            "truncated": len(rows) > MAX_ARRAY}


@mcp.tool()
@_tool
def list_studies(patient_id: str | None = None) -> dict[str, Any]:
    """List studies in the local library, optionally for one patient_id.

    Each row has study_uid, patient_id, patient_name, study_date, description,
    modalities, series_count and instance_count. Use the study_uid with
    list_series to get the series you can analyse.
    """
    rows = _get("/api/studies", params={"patient_id": patient_id})
    return {"n": len(rows), "studies": rows[:MAX_ARRAY],
            "truncated": len(rows) > MAX_ARRAY}


@mcp.tool()
@_tool
def list_series(study_uid: str) -> dict[str, Any]:
    """List the series of one study.

    Each row has series_uid, series_number, modality, description, body_part,
    instance_count, rows/cols, pixel_spacing [row_mm, col_mm], slice_thickness
    and is_3d. Only is_3d series (>= 3 instances sharing one orientation) can be
    segmented or profiled; pick the axial soft-tissue CT series for head & neck
    work.
    """
    rows = _get("/api/studies/{u}/series".format(u=study_uid))
    return {"n": len(rows), "series": rows[:MAX_ARRAY],
            "truncated": len(rows) > MAX_ARRAY}


@mcp.tool()
@_tool
def get_series(series_uid: str, include_instances: bool = False) -> dict[str, Any]:
    """Geometry and slice range of one series (summarised, no instance dump).

    Returns the series row plus n_instances, k_range [0, n-1], the slice_pos of
    the first (most inferior, k = 0) and last (most superior) slice and the span
    between them in millimetres -- enough to convert a slice number the user
    quotes into the k index every other tool expects. Set include_instances=true
    only if you really need all per-slice SOP UIDs and positions (can be
    hundreds of rows).
    """
    row = dict(_get("/api/series/{u}".format(u=series_uid)))
    instances = row.pop("instances", []) or []
    n = len(instances)
    out: dict[str, Any] = dict(row)
    out["n_instances"] = n
    out["k_range"] = [0, n - 1] if n else None
    if n:
        first, last = instances[0], instances[-1]
        out["first_slice"] = {"k": 0, "sop_uid": first.get("sop_uid"),
                              "slice_pos": _r(first.get("slice_pos"), 2),
                              "ipp": _r(first.get("ipp"), 2)}
        out["last_slice"] = {"k": n - 1, "sop_uid": last.get("sop_uid"),
                             "slice_pos": _r(last.get("slice_pos"), 2),
                             "ipp": _r(last.get("ipp"), 2)}
        try:
            out["slice_span_mm"] = _r(
                abs(float(last["slice_pos"]) - float(first["slice_pos"])), 2)
        except (KeyError, TypeError, ValueError):
            out["slice_span_mm"] = None
    out["note"] = ("k = 0 is the most inferior slice; ijk = [column, row, "
                   "slice]. Instances omitted -- pass include_instances=true "
                   "for the full list.")
    if include_instances:
        out["instances"] = instances
        out.pop("note", None)
    return out


@mcp.tool()
@_tool
def import_folder(path: str | None = None) -> dict[str, Any]:
    """Index a folder of DICOM files into the local library (idempotent).

    path defaults to the studies root reported by health(). Files are indexed in
    place -- nothing is copied or uploaded. Non-DICOM files are skipped quietly.
    Returns how many patients / studies / series / instances were seen, how many
    were skipped, and the wall time in seconds.
    """
    body: dict[str, Any] = {}
    if path:
        body["path"] = path
    return _post("/api/import", body, timeout=SLOW_TIMEOUT)


# ---- segmentation --------------------------------------------------------


@mcp.tool()
@_tool
def region_grow(series_uid: str, lower_hu: float, upper_hu: float,
                seed_ijk: list[int] | None = None,
                seed_lps: list[float] | None = None,
                max_radius_mm: float = 40.0,
                closing_mm: float = 0.0,
                keep_largest: bool = True) -> dict[str, Any]:
    """Grow a 3D label from a seed point through voxels inside an HU band.

    Give exactly one seed: seed_ijk = [column, row, slice] (integers, k = 0 most
    inferior) or seed_lps = [x, y, z] in LPS millimetres. The seed's own HU must
    lie inside [lower_hu, upper_hu] or the backend returns 400.

    Growth is 6-connected and confined to a sphere of max_radius_mm around the
    seed so it cannot leak into the whole body (0 or null removes the cap).
    closing_mm optionally closes the result with a ball of that radius;
    keep_largest keeps only the biggest connected component.

    Useful bands: airway lumen -1024..-400, fat -190..-30, soft tissue /
    tumour 20..80, enhancing vessel 150..500, cortical bone 300..3000.

    Returns LabelStats: label_id (feed it to label_stats, label_distance,
    export_label_stl), n_voxels, volume_ml, bbox_ijk, centroid_lps, mean/std HU,
    longest_axis_mm (max Feret caliper) and diameters_mm (three PCA extents,
    largest first).
    """
    body: dict[str, Any] = {
        "series_uid": series_uid,
        "lower_hu": float(lower_hu),
        "upper_hu": float(upper_hu),
        "max_radius_mm": max_radius_mm,
        "closing_mm": closing_mm,
        "keep_largest": keep_largest,
    }
    body.update(_seed_body(seed_ijk, seed_lps))
    stats = _post("/api/analysis/region-grow", body, timeout=ANALYSIS_TIMEOUT)
    return _label_stats_out(stats)


@mcp.tool()
@_tool
def threshold(series_uid: str, lower_hu: float, upper_hu: float,
              inside_body: bool = True, keep_largest: bool = False,
              min_component_ml: float = 0.05) -> dict[str, Any]:
    """Segment every voxel of a series whose HU falls in a band.

    inside_body (default true) intersects the result with the body mask, so an
    airway threshold keeps the lumen and drops the room air around the patient.
    keep_largest keeps only the biggest component; components smaller than
    min_component_ml millilitres are dropped (0 disables).

    Bands as for region_grow (bone 300..3000, airway -1024..-400, fat -190..-30).
    Returns LabelStats -- see region_grow for the fields and units.
    """
    body = {
        "series_uid": series_uid,
        "lower_hu": float(lower_hu),
        "upper_hu": float(upper_hu),
        "inside_body": inside_body,
        "keep_largest": keep_largest,
        "min_component_ml": min_component_ml,
    }
    stats = _post("/api/analysis/threshold", body, timeout=ANALYSIS_TIMEOUT)
    return _label_stats_out(stats)


@mcp.tool()
@_tool
def label_stats(label_id: str) -> dict[str, Any]:
    """Re-read the statistics of a label made earlier in this session.

    Labels live in memory on the backend (LRU of 20) and do not survive a
    backend restart: a 404 here means the label is gone and the segmentation
    should simply be re-run.
    """
    return _label_stats_out(_get(
        "/api/analysis/label/{i}/stats".format(i=label_id)))


@mcp.tool()
@_tool
def label_distance(label_a: str, label_b: str) -> dict[str, Any]:
    """Shortest 3D distance in millimetres between two labels of the same series.

    Returns min_distance_mm plus the two closest surface points in LPS
    millimetres. The distance is NEGATIVE when the labels overlap, which is how
    you show a tumour abutting or invading a vessel; 0-1 mm is contact within
    one voxel. Both labels must come from the same series (else 400).
    """
    out = dict(_post("/api/analysis/distance",
                     {"label_a": label_a, "label_b": label_b},
                     timeout=ANALYSIS_TIMEOUT))
    return {
        "min_distance_mm": _r(out.get("min_distance_mm"), 2),
        "point_a_lps": _r(out.get("point_a_lps"), 1),
        "point_b_lps": _r(out.get("point_b_lps"), 1),
        "note": "negative means the labels overlap; units are LPS millimetres",
    }


@mcp.tool()
@_tool
def delete_label(label_id: str) -> dict[str, Any]:
    """Drop a label from the backend's in-memory store.

    Returns {deleted: label_id, labels: how many remain} (the store holds at
    most 20, so this is only worth doing to make room deliberately).
    """
    return _request("DELETE", "/api/analysis/label/{i}".format(i=label_id),
                    timeout=FAST_TIMEOUT).json()


@mcp.tool()
@_tool
def export_label_stl(label_id: str, out_path: str,
                     smooth_iters: int = 10) -> dict[str, Any]:
    """Write a label's surface to a binary STL file for 3D printing or planning.

    The mesh is in patient LPS millimetres. smooth_iters is Laplacian smoothing
    passes (0 = raw marching cubes, 10 is a good default; high values shrink
    thin structures).

    For safety the file MUST land inside the Margin exports folder
    (%LOCALAPPDATA%\\HNRad\\exports); a bare filename such as "airway.stl" is
    the easiest way to do that, and any path outside it is refused. Returns the
    absolute path, the file size and the triangle count.
    """
    target = _safe_export_path(out_path)
    resp = _request("GET", "/api/analysis/label/{i}/mesh".format(i=label_id),
                    params={"smooth_iters": int(smooth_iters)},
                    timeout=ANALYSIS_TIMEOUT)
    blob = resp.content
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(blob)
    return {
        "path": str(target),
        "bytes": len(blob),
        "n_triangles": _stl_triangles(blob),
        "label_id": label_id,
        "smooth_iters": int(smooth_iters),
        "frame": "patient LPS millimetres",
    }


# ---- airway --------------------------------------------------------------


def _glottis_is_above(series_uid: str, glottis_slice: int,
                      min_csa_lps: Sequence[float] | None) -> bool | None:
    """True if the glottis sits superior to the narrowest point, else False.

    Compares the LPS z of the glottis slice with the z of the minimum. Returns
    None when the geometry cannot be fetched, so the narrative can fall back to
    direction-free wording.
    """
    if not min_csa_lps or len(min_csa_lps) < 3:
        return None
    try:
        row = _get("/api/series/{u}".format(u=series_uid))
        instances = row.get("instances") or []
        if not (0 <= int(glottis_slice) < len(instances)):
            return None
        z_glottis = float(instances[int(glottis_slice)]["ipp"][2])
    except (MarginError, KeyError, IndexError, TypeError, ValueError):
        return None
    return z_glottis > float(min_csa_lps[2])


def _airway_narrative(res: dict[str, Any], glottis_above: bool | None,
                      arclen_at_min: float | None) -> str:
    """One paste-ready sentence a surgeon can drop into a note."""
    parts: list[str] = []
    min_csa = res.get("min_csa_mm2")
    eq = _eq_diameter(min_csa)
    if isinstance(min_csa, (int, float)):
        head = "Minimum cross-sectional area {a:.1f} mm²".format(a=min_csa)
        if eq is not None:
            head += " (equivalent diameter {d:.1f} mm)".format(d=eq)
        dist = res.get("distance_from_glottis_mm")
        if isinstance(dist, (int, float)):
            if glottis_above is True:
                where = " at {d:.0f} mm below the glottis".format(d=abs(dist))
            elif glottis_above is False:
                where = " at {d:.0f} mm above the glottis".format(d=abs(dist))
            else:
                where = " {d:.0f} mm from the glottis".format(d=abs(dist))
            head += where
        elif isinstance(arclen_at_min, (int, float)):
            head += (" at {d:.0f} mm along the airway from the caudal end"
                     .format(d=arclen_at_min))
        parts.append(head)

    pct = res.get("stenosis_pct")
    if isinstance(pct, (int, float)):
        seg = "{p:.0f}% area reduction".format(p=pct)
        length = res.get("stenosis_length_mm")
        if isinstance(length, (int, float)) and length > 0:
            seg += " over {l:.0f} mm".format(l=length)
        parts.append(seg)

    grade = res.get("myer_cotton_grade")
    if grade:
        parts.append("Myer–Cotton grade {g}".format(g=grade))

    return "; ".join(parts) if parts else "No airway measurements available"


def _summarise_airway(res: dict[str, Any], glottis_above: bool | None
                      ) -> dict[str, Any]:
    """Collapse the per-sample arrays into a 12-point table plus a narrative."""
    arclen = [float(v) for v in res.get("arclength_mm") or []]
    csa = [float(v) for v in res.get("csa_mm2") or []]
    eqd = [float(v) for v in res.get("eq_diameter_mm") or []]
    dmin = [float(v) for v in res.get("min_diameter_mm") or []]
    dmax = [float(v) for v in res.get("max_diameter_mm") or []]
    n = max(len(arclen), len(csa))

    idxs = _downsample_indices(min(len(arclen), len(csa)) or n)
    profile = []
    for i in idxs:
        row: dict[str, Any] = {"i": i}
        if i < len(arclen):
            row["arclength_mm"] = _r(arclen[i], 1)
        if i < len(csa):
            row["csa_mm2"] = _r(csa[i], 1)
        if i < len(eqd):
            row["eq_diameter_mm"] = _r(eqd[i], 1)
        profile.append(row)

    min_idx = res.get("min_csa_index")
    arclen_at_min = (arclen[min_idx]
                     if isinstance(min_idx, int) and 0 <= min_idx < len(arclen)
                     else None)

    out: dict[str, Any] = {
        "label_id": res.get("label_id"),
        "n_samples": n,
        "csa_ref_mm2": _r(res.get("csa_ref_mm2"), 1),
        "reference": res.get("reference"),
        "ref_range_k": res.get("ref_range_k"),
        "ref_method": res.get("ref_method"),
        "capped_at_glottis": res.get("capped_at_glottis"),
        "min_csa_mm2": _r(res.get("min_csa_mm2"), 1),
        "min_eq_diameter_mm": _eq_diameter(res.get("min_csa_mm2")),
        "min_csa_index": min_idx,
        "min_csa_lps": _r(res.get("min_csa_lps"), 1),
        "min_csa_arclength_mm": _r(arclen_at_min, 1),
        "stenosis_pct": _r(res.get("stenosis_pct"), 1),
        "stenosis_length_mm": _r(res.get("stenosis_length_mm"), 1),
        "distance_from_glottis_mm": _r(res.get("distance_from_glottis_mm"), 1),
        "myer_cotton_grade": res.get("myer_cotton_grade"),
        "arclength_mm": _span(arclen),
        "csa_mm2": _span(csa),
        "eq_diameter_mm": _span(eqd),
        "min_diameter_mm": _span(dmin),
        "max_diameter_mm": _span(dmax),
        "profile": profile,
        "profile_note": (
            "{k} of {n} samples, evenly spaced, inferior (i = 0) to superior; "
            "CSA in mm², arclength in mm from the most caudal sample"
        ).format(k=len(profile), n=n),
        "took_ms": _r(res.get("took_ms"), 0),
    }
    out["narrative"] = _airway_narrative(res, glottis_above, arclen_at_min)
    out["grading"] = ("Myer–Cotton: I <= 50%, II 51-70%, III 71-99%, "
                      "IV no lumen")
    return out


@mcp.tool()
@_tool
def airway_profile(series_uid: str,
                   seed_ijk: list[int] | None = None,
                   seed_lps: list[float] | None = None,
                   glottis_slice: int | None = None,
                   reference: str = "auto",
                   ref_range_k: list[int] | None = None,
                   cap_at_glottis: bool = False,
                   lower_hu: float = -1024.0,
                   upper_hu: float = -400.0) -> dict[str, Any]:
    """Profile the airway: centreline, cross-sectional area, stenosis, grade.

    Seed the tracheal lumen with exactly one of seed_ijk = [column, row, slice]
    or seed_lps = [x, y, z] LPS millimetres -- a point clearly inside the air
    column, well below any narrowing. glottis_slice is the k index of the true
    vocal folds and is what makes "N mm below the glottis" possible.

    reference='auto' takes the 75th percentile of CSA over the healthy samples
    below the minimum; reference='manual' takes the median over ref_range_k =
    [k0, k1] instead. Stenosis % = 100 * (1 - min CSA / reference CSA).
    cap_at_glottis=true (needs glottis_slice) drops every centreline sample
    superior to the vocal folds, so the grade describes the laryngotracheal
    airway rather than the pharynx and nasal cavity the centroid walk climbs
    into on a real neck CT.

    The raw per-sample arrays are NOT returned: you get n_samples, the min/max
    of each, a 12-point CSA-vs-arclength table (index 0 = most caudal), the
    minimum with its LPS point, stenosis percent and length, distance from the
    glottis, the Myer-Cotton grade, and a `narrative` sentence written for a
    surgeon to paste into a note. label_id is the segmented lumen -- pass it to
    export_label_stl for a printable airway model. Takes a few seconds on a
    full neck CT.
    """
    body: dict[str, Any] = {
        "series_uid": series_uid,
        "lower_hu": float(lower_hu),
        "upper_hu": float(upper_hu),
        "reference": reference,
    }
    if glottis_slice is not None:
        body["glottis_slice"] = int(glottis_slice)
    if ref_range_k is not None:
        body["ref_range_k"] = [int(v) for v in ref_range_k]
    if cap_at_glottis:
        body["cap_at_glottis"] = True
    body.update(_seed_body(seed_ijk, seed_lps))

    res = _post("/api/analysis/airway", body, timeout=SLOW_TIMEOUT)
    glottis_above = None
    if glottis_slice is not None:
        glottis_above = _glottis_is_above(series_uid, int(glottis_slice),
                                          res.get("min_csa_lps"))
    return _summarise_airway(res, glottis_above)


# ---- measurement ---------------------------------------------------------


@mcp.tool()
@_tool
def roi_stats(series_uid: str, sop_uid: str,
              polygon: list[list[float]]) -> dict[str, Any]:
    """HU statistics inside a polygon drawn on one slice.

    polygon is at least 3 points in PIXEL coordinates [[col, row], ...] on the
    image identified by sop_uid (get the SOP UIDs from
    get_series(include_instances=true)). Returns mean/std/min/max HU, the area
    in mm^2 and the voxel count -- the usual way to characterise a node or a
    suspected necrotic centre.
    """
    out = dict(_post("/api/analysis/roi-stats",
                     {"series_uid": series_uid, "sop_uid": sop_uid,
                      "polygon": [[float(p[0]), float(p[1])] for p in polygon]},
                     timeout=ANALYSIS_TIMEOUT))
    return {
        "mean_hu": _r(out.get("mean_hu"), 1),
        "std_hu": _r(out.get("std_hu"), 1),
        "min_hu": _r(out.get("min_hu"), 1),
        "max_hu": _r(out.get("max_hu"), 1),
        "area_mm2": _r(out.get("area_mm2"), 1),
        "n_voxels": out.get("n_voxels"),
    }


# ---- AI segmentation (routes may not exist yet) --------------------------

_AI_MISSING = ("AI routes not available in this backend version "
               "(/api/ai/* returned 404). They are being added separately; "
               "use threshold / region_grow / airway_profile meanwhile.")


def _ai_guard(exc: MarginError) -> dict[str, Any]:
    """404 on an /api/ai path with FastAPI's default detail = routes missing."""
    if exc.status == 404 and str(exc.detail or "").strip().lower() == "not found":
        return {"error": _AI_MISSING}
    return {"error": str(exc)}


@mcp.tool()
@_tool
def ai_models() -> dict[str, Any]:
    """List the AI segmentation models the backend can run locally.

    Typically 'totalseg' (TotalSegmentator, whole-body organ/bone/vessel
    structures) and 'hnlnl' (head & neck lymph node levels, Robbins). Returns an
    error string if this backend build has no AI routes yet.
    """
    try:
        return {"models": _get("/api/ai/models", timeout=ANALYSIS_TIMEOUT)}
    except MarginError as exc:
        return _ai_guard(exc)


@mcp.tool()
@_tool
def ai_segment(series_uid: str, model: str,
               tasks: list[str] | None = None,
               roi_subset: list[str] | None = None,
               fast: bool = False) -> dict[str, Any]:
    """Start an AI segmentation job on a series (runs locally on CPU, minutes).

    model is 'totalseg' or 'hnlnl' (see ai_models). tasks selects sub-tasks of
    the model, roi_subset limits it to named structures (much faster -- e.g.
    ["trachea", "thyroid_gland"]), fast=true uses the low-resolution pass.

    Returns {job_id, status} immediately. Poll ai_job(job_id) until status is
    'done' or 'error'; do not block the conversation on it.
    """
    body: dict[str, Any] = {"series_uid": series_uid, "model": model,
                            "fast": fast}
    if tasks:
        body["tasks"] = list(tasks)
    if roi_subset:
        body["roi_subset"] = list(roi_subset)
    try:
        return _post("/api/ai/segment", body, timeout=ANALYSIS_TIMEOUT)
    except MarginError as exc:
        return _ai_guard(exc)


@mcp.tool()
@_tool
def ai_job(job_id: str) -> dict[str, Any]:
    """Check an AI segmentation job started with ai_segment.

    Returns {status, progress, structures, error}. Each finished structure has a
    name, a label_id usable with label_stats / label_distance /
    export_label_stl, and its volume_ml. Only the first 50 structures are
    listed.
    """
    try:
        out = dict(_get("/api/ai/jobs/{j}".format(j=job_id),
                        timeout=ANALYSIS_TIMEOUT))
    except MarginError as exc:
        return _ai_guard(exc)
    structures = out.get("structures") or []
    if isinstance(structures, list) and len(structures) > MAX_ARRAY:
        out["structures"] = structures[:MAX_ARRAY]
        out["structures_truncated"] = len(structures)
    return out


# ---- resources -----------------------------------------------------------


def contract_path() -> Path:
    """Where CONTRACT.md lives (override with HNRAD_CONTRACT)."""
    env = os.environ.get("HNRAD_CONTRACT")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[2] / "CONTRACT.md"


@mcp.resource("margin://studies", name="studies", mime_type="application/json",
              description="Every study in the local DICOM library, as JSON.")
def resource_studies() -> str:
    """All studies currently indexed by the local Margin backend."""
    try:
        rows = _get("/api/studies")
    except MarginError as exc:
        return json.dumps({"error": str(exc)}, indent=2)
    return json.dumps(rows, indent=2)


@mcp.resource("margin://contract", name="contract", mime_type="text/markdown",
              description="CONTRACT.md: the Margin/HNRad REST API, coordinate "
                          "conventions and analysis algorithms.")
def resource_contract() -> str:
    """The full API contract, including ijk/LPS conventions and the algorithms."""
    path = contract_path()
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        return ("CONTRACT.md could not be read from {p} ({e}). Set the "
                "HNRAD_CONTRACT environment variable to its location."
                .format(p=path, e=exc))


# --------------------------------------------------------------------------


def main() -> None:
    """Entry point for ``python -m hnrad.mcp_server`` (stdio transport)."""
    logging.basicConfig(
        stream=sys.stderr,
        level=os.environ.get("MARGIN_MCP_LOG", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log.info("Margin MCP server starting; backend = %s", base_url())
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
