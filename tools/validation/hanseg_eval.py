"""Validate Margin's AI segmentation layer against HaN-Seg expert contours.

Runs the four (plus one) AI tasks through the live backend job API for N HaN-Seg
cases, fetches every predicted structure mask through the Analysis label API, and
scores it against the matching HaN-Seg organ-at-risk NRRD.

    backend\\.venv\\Scripts\\python.exe tools\\validation\\hanseg_eval.py --n 5

Nothing here writes into the repo except `results.json` / `summary.json` and the
overlay PNGs under `tools/validation/overlays/` (gitignored). HaN-Seg itself is
CC BY-NC-ND: it is read in place from %LOCALAPPDATA%\\HNRad\\datasets and is never
copied into the working tree.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import SimpleITK as sitk
from scipy import ndimage

API = "http://127.0.0.1:8765"

# Overlay staging goes OUTSIDE the repo on purpose: backend/run.ps1 starts uvicorn
# with --reload watching the project tree, and writing scratch files under
# tools/validation/ can restart the very server this script is driving.
STAGE = Path(os.environ.get("TEMP", ".")) / "hnrad_valid_stage"

DEFAULT_CASES = ["case_01", "case_05", "case_12", "case_20", "case_33"]

ROI_SUBSET = [
    "spinal_cord",
    "esophagus",
    "thyroid_gland",
    "brain",
] + [f"vertebrae_C{i}" for i in range(1, 8)]

# The common carotid is NOT in the brief's roi_subset, but HaN-Seg contours the
# carotid as common + internal in ONE structure. Without this second `total` run
# the carotid pair can only be scored against the internal carotid alone, which
# measures a definition mismatch (volume ratio ~0.1) rather than accuracy.
CAROTID_ROI = ["common_carotid_artery_left", "common_carotid_artery_right"]

# Jobs per case, in submission order: (job_key, model, tasks, roi_subset).
# Two additions to the brief, both documented in REPORT.md:
# `craniofacial_structures` is the only offered task carrying `mandible`, and
# `total_carotid` supplies the common carotid.
# job_key is for reporting only; PAIRS matches on tasks[0] (or the model), so both
# `total` runs contribute to the same ("total", <name>) namespace.
JOBS = [
    ("headneck_bones_vessels", "totalseg", ["headneck_bones_vessels"], None),
    ("head_glands_cavities", "totalseg", ["head_glands_cavities"], None),
    ("craniofacial_structures", "totalseg", ["craniofacial_structures"], None),
    ("total", "totalseg", ["total"], ROI_SUBSET),
    ("total_carotid", "totalseg", ["total"], CAROTID_ROI),
    ("hnlnl", "hnlnl", None, None),
]

# ---------------------------------------------------------------------------
# Mapping table: HaN-Seg organ-at-risk -> TotalSegmentator class(es)
#
# quality:
#   exact       same anatomical object, same conventional boundaries
#   approx      same object, but the two definitions differ in extent or in how
#               the structure is decomposed (documented per row)
#   definition  the two labels are *not* the same object; reported only to show
#               how far apart they are, never as an accuracy figure
#
# z_restrict: also score over the axial range the GT actually spans, because the
# raw number is dominated by a protocol difference in cranio-caudal extent
# rather than by boundary error.
# ---------------------------------------------------------------------------
PAIRS = [
    dict(
        key="carotid_left", gt=["OAR_A_Carotid_L"],
        pred=[("headneck_bones_vessels", "internal_carotid_artery_left"),
              ("total", "common_carotid_artery_left")],
        quality="approx", z_restrict=True,
        note="HaN-Seg contours the carotid as one structure (common + internal). "
             "TotalSegmentator splits it: common carotid lives in `total`, internal "
             "carotid in `headneck_bones_vessels`. Scored against the union of the two.",
    ),
    dict(
        key="carotid_right", gt=["OAR_A_Carotid_R"],
        pred=[("headneck_bones_vessels", "internal_carotid_artery_right"),
              ("total", "common_carotid_artery_right")],
        quality="approx", z_restrict=True,
        note="See carotid_left.",
    ),
    dict(
        key="mandible", gt=["OAR_Bone_Mandible"],
        pred=[("craniofacial_structures", "mandible")],
        quality="exact", z_restrict=False, note="",
    ),
    dict(
        key="parotid_left", gt=["OAR_Parotid_L"],
        pred=[("head_glands_cavities", "parotid_gland_left")],
        quality="exact", z_restrict=False, note="",
    ),
    dict(
        key="parotid_right", gt=["OAR_Parotid_R"],
        pred=[("head_glands_cavities", "parotid_gland_right")],
        quality="exact", z_restrict=False, note="",
    ),
    dict(
        key="submandibular_left", gt=["OAR_Glnd_Submand_L"],
        pred=[("head_glands_cavities", "submandibular_gland_left")],
        quality="exact", z_restrict=False, note="",
    ),
    dict(
        key="submandibular_right", gt=["OAR_Glnd_Submand_R"],
        pred=[("head_glands_cavities", "submandibular_gland_right")],
        quality="exact", z_restrict=False, note="",
    ),
    dict(
        key="thyroid_gland", gt=["OAR_Glnd_Thyroid"],
        pred=[("total", "thyroid_gland")],
        quality="exact", z_restrict=False, note="",
    ),
    dict(
        key="eye_left", gt=["OAR_Eye_AL", "OAR_Eye_PL"],
        pred=[("head_glands_cavities", "eye_left")],
        quality="approx", z_restrict=False,
        note="HaN-Seg splits the globe into anterior (Eye_AL) and posterior (Eye_PL) "
             "segments; TotalSegmentator has one `eye_left`. Scored against the GT union.",
    ),
    dict(
        key="eye_right", gt=["OAR_Eye_AR", "OAR_Eye_PR"],
        pred=[("head_glands_cavities", "eye_right")],
        quality="approx", z_restrict=False, note="See eye_left.",
    ),
    dict(
        key="optic_nerve_left", gt=["OAR_OpticNrv_L"],
        pred=[("head_glands_cavities", "optic_nerve_left")],
        quality="approx", z_restrict=False,
        note="Both label the optic nerve, but the posterior (intracranial / chiasmatic) "
             "cut-off is not standardised between the two conventions.",
    ),
    dict(
        key="optic_nerve_right", gt=["OAR_OpticNrv_R"],
        pred=[("head_glands_cavities", "optic_nerve_right")],
        quality="approx", z_restrict=False, note="See optic_nerve_left.",
    ),
    dict(
        key="spinal_cord", gt=["OAR_SpinalCord"],
        pred=[("total", "spinal_cord")],
        quality="approx", z_restrict=True,
        note="Same object, different cranio-caudal extent: HaN-Seg stops at the RT "
             "planning limits, TotalSegmentator labels the cord over the whole FOV. "
             "The z-restricted column is the boundary-accuracy number.",
    ),
    dict(
        key="esophagus", gt=["OAR_Esophagus_S"],
        pred=[("total", "esophagus")],
        quality="approx", z_restrict=True,
        note="HaN-Seg `Esophagus_S` is the *cervical* oesophagus only (~1.5 mL, ~20 mm). "
             "TotalSegmentator `esophagus` runs the whole oesophagus in the FOV. The raw "
             "volume ratio is a protocol difference, not an error.",
    ),
    dict(
        key="larynx_air_vs_glottis_sg", gt=["OAR_Glottis", "OAR_Larynx_SG"],
        pred=[("headneck_bones_vessels", "larynx_air")],
        quality="definition", z_restrict=True,
        note="NOT the same object. HaN-Seg `Glottis` + `Larynx_SG` are laryngeal soft "
             "tissue; TotalSegmentator `larynx_air` is the air column inside the larynx. "
             "Reported only to document the size of the mismatch.",
    ),
]

# HaN-Seg organs with no counterpart in any task Margin offers.
UNMATCHED_GT = {
    "OAR_Arytenoid": "no arytenoid class in any offered task (headneck_bones_vessels "
                     "has thyroid/cricoid cartilage and hyoid only)",
    "OAR_Brainstem": "`total` has `brain` (whole brain) but no brainstem. The "
                     "TotalSegmentator task that would carry it, `brain_structures`, "
                     "needs a non-commercial licence key and is deliberately not offered.",
    "OAR_BuccalMucosa": "no counterpart",
    "OAR_Cavity_Oral": "no counterpart (teeth / craniofacial tasks give jawbones, "
                       "teeth and palate, not the oral cavity)",
    "OAR_Cochlea_L": "`auditory_canal_left` is the *external* auditory canal, not the cochlea",
    "OAR_Cochlea_R": "see OAR_Cochlea_L",
    "OAR_Cricopharyngeus": "no counterpart",
    "OAR_Glnd_Lacrimal_L": "no lacrimal gland class in head_glands_cavities",
    "OAR_Glnd_Lacrimal_R": "no lacrimal gland class in head_glands_cavities",
    "OAR_Lips": "no counterpart",
    "OAR_OpticChiasm": "no counterpart",
    "OAR_Pituitary": "no counterpart",
}

# Predicted structures with no HaN-Seg ground truth to score against.
UNMATCHED_PRED = {
    "headneck_bones_vessels": ["thyroid_cartilage", "hyoid", "cricoid_cartilage",
                               "zygomatic_arch_left", "zygomatic_arch_right",
                               "styloid_process_left", "styloid_process_right",
                               "internal_jugular_vein_left", "internal_jugular_vein_right"],
    "head_glands_cavities": ["eye_lens_left", "eye_lens_right", "nasopharynx", "oropharynx",
                             "hypopharynx", "nasal_cavity_left", "nasal_cavity_right",
                             "auditory_canal_left", "auditory_canal_right",
                             "soft_palate", "hard_palate"],
    "craniofacial_structures": ["skull", "head", "teeth_lower", "teeth_upper",
                                "sinus_maxillary", "sinus_frontal"],
    "total": ["brain", "vertebrae_C1", "vertebrae_C2", "vertebrae_C3", "vertebrae_C4",
              "vertebrae_C5", "vertebrae_C6", "vertebrae_C7"],
    "hnlnl": ["all 20 cervical nodal levels - HaN-Seg has no nodal-level ground truth"],
}


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _get(path: str, timeout: int = 60):
    with urllib.request.urlopen(API + path, timeout=timeout) as r:
        return json.load(r)


def _post(path: str, body: dict, timeout: int = 60):
    req = urllib.request.Request(
        API + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_mask(label_id: str, timeout: int = 300):
    """GET /api/analysis/label/{id}/mask -> (uint8 (z,y,x) array, geometry dict)."""
    with urllib.request.urlopen(API + f"/api/analysis/label/{label_id}/mask",
                                timeout=timeout) as r:
        hdr = {k.lower(): v for k, v in r.headers.items()}
        raw = r.read()
    nz, ny, nx = (int(v) for v in hdr["x-shape"].split(","))
    dz, dy, dx = (float(v) for v in hdr["x-spacing"].split(","))
    origin = tuple(float(v) for v in hdr["x-origin"].split(","))
    direction = tuple(float(v) for v in hdr["x-direction"].split(","))
    arr = np.frombuffer(gzip.decompress(raw), dtype=np.uint8)
    if arr.size != nz * ny * nx:
        raise RuntimeError(f"mask size {arr.size} != {nz}*{ny}*{nx}")
    return arr.reshape(nz, ny, nx), dict(shape=(nz, ny, nx), spacing=(dz, dy, dx),
                                         origin=origin, direction=direction)


def pack(a: np.ndarray):
    """Bit-pack a boolean volume: 1024x1024x202 goes from 212 MB to 26 MB.

    A case needs ~35 masks resident at once (15 scored structures + 20 nodal
    levels) while a 5.8 GB inference job is running, so they are never held
    unpacked.
    """
    return np.packbits(a)


def unpack(p: np.ndarray, shape) -> np.ndarray:
    n = int(np.prod(shape))
    return np.unpackbits(p)[:n].reshape(shape).astype(bool)


def run_job(series_uid: str, model: str, tasks, roi_subset, poll: float = 10.0,
            log=print):
    """Submit one job and poll it to completion. Returns the finished job dict."""
    body = {"series_uid": series_uid, "model": model, "fast": False}
    if tasks:
        body["tasks"] = tasks
    if roi_subset:
        body["roi_subset"] = roi_subset
    t0 = time.time()
    sub = _post("/api/ai/segment", body)
    job_id = sub["job_id"]
    label = ",".join(tasks) if tasks else model
    last = None
    resubmits = 0
    while True:
        try:
            job = _get(f"/api/ai/jobs/{job_id}")
        except urllib.error.HTTPError as e:
            # The backend on this box drops completed (and sometimes in-flight)
            # jobs from its in-memory store, so the job id can 404 mid-poll. The
            # segmentation itself is cached on disk, so re-submitting the identical
            # request is either an instant cache hit or, at worst, one recompute.
            if e.code != 404:
                raise
            if resubmits >= 12:
                # Give up on this task rather than killing the whole run: the
                # pairs that depend on it are recorded as `pred_missing` and
                # every other structure in the case is still scored.
                log(f"      {label}: ABANDONED after {resubmits} re-submissions "
                    f"({time.time() - t0:.0f}s) - backend keeps dropping the job")
                return {"status": "error", "error": "job id kept vanishing (404)",
                        "wall_s": time.time() - t0, "resubmits": resubmits,
                        "structures": [], "log_tail": [], "_label": label,
                        "peak_rss_note": None, "cached": None}
            resubmits += 1
            log(f"      {label}: job id vanished (404), re-submitting "
                f"[{resubmits}/12, {time.time() - t0:.0f}s]")
            time.sleep(poll)
            sub = _post("/api/ai/segment", body)
            job_id = sub["job_id"]
            last = None
            continue
        if job["status"] in ("done", "error"):
            break
        msg = (job["status"], round(job["progress"], 2))
        if msg != last:
            log(f"      {label}: {job['status']} {job['progress']:.0%} "
                f"{job.get('message', '')[:50]} [{time.time() - t0:.0f}s]")
            last = msg
        time.sleep(poll)
    job["wall_s"] = time.time() - t0
    job["resubmits"] = resubmits
    job["_label"] = label
    # The job schema has no RAM field; the runner sometimes prints one into log_tail.
    job["peak_rss_note"] = next(
        (ln for ln in reversed(job.get("log_tail") or [])
         if "rss" in ln.lower() or "peak" in ln.lower()), None)
    if job["status"] == "error":
        log(f"      {label}: ERROR {job.get('error')}")
    else:
        log(f"      {label}: done in {job['wall_s']:.0f}s "
            f"(cached={job.get('cached')}) {len(job.get('structures') or [])} structures")
    return job


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def _surface(mask: np.ndarray) -> np.ndarray:
    """Boundary voxels: foreground voxels with at least one background 6-neighbour."""
    er = ndimage.binary_erosion(mask, ndimage.generate_binary_structure(3, 1),
                                border_value=0)
    return mask & ~er


def metrics(pred: np.ndarray, gt: np.ndarray, spacing_zyx, origin, direction):
    """Dice, HD95 (mm), MSD (mm), volume ratio, centroid distance (mm).

    Everything is computed on the joint bounding box of pred | gt (padded), so a
    1024x1024x200 grid never needs a full-size float distance transform.
    """
    out = {
        "dice": None, "hd95_mm": None, "msd_mm": None, "volume_ratio": None,
        "centroid_dist_mm": None,
        "gt_voxels": int(gt.sum()), "pred_voxels": int(pred.sum()),
    }
    dz, dy, dx = spacing_zyx
    vox_ml = dz * dy * dx / 1000.0
    out["gt_ml"] = out["gt_voxels"] * vox_ml
    out["pred_ml"] = out["pred_voxels"] * vox_ml

    if out["gt_voxels"] == 0 or out["pred_voxels"] == 0:
        if out["gt_voxels"] == 0 and out["pred_voxels"] == 0:
            out["dice"] = 1.0
        else:
            out["dice"] = 0.0
        return out

    inter = int(np.count_nonzero(pred & gt))
    out["dice"] = 2.0 * inter / (out["pred_voxels"] + out["gt_voxels"])
    out["volume_ratio"] = out["pred_ml"] / out["gt_ml"]

    # Centroid distance in LPS millimetres.
    cp = np.argwhere(pred).mean(0)   # (z, y, x)
    cg = np.argwhere(gt).mean(0)
    R = np.asarray(direction, float).reshape(3, 3).T  # columns = i, j, k axes in LPS
    sp_ijk = np.array([dx, dy, dz])                   # spacing along i, j, k

    def to_lps(c_zyx):
        ijk = np.array([c_zyx[2], c_zyx[1], c_zyx[0]]) * sp_ijk
        return np.asarray(origin, float) + R @ ijk

    out["centroid_dist_mm"] = float(np.linalg.norm(to_lps(cp) - to_lps(cg)))

    # Crop to the joint bbox with a margin, then surface distances on the crop.
    both = pred | gt
    idx = np.argwhere(both)
    lo = np.maximum(idx.min(0) - 4, 0)
    hi = np.minimum(idx.max(0) + 5, np.array(both.shape))
    sl = tuple(slice(int(a), int(b)) for a, b in zip(lo, hi))
    p, g = pred[sl], gt[sl]

    sp = (dz, dy, dx)
    sp_surf, sg_surf = _surface(p), _surface(g)
    # EDT of the complement of a surface gives distance to the nearest surface voxel.
    dt_to_g = ndimage.distance_transform_edt(~sg_surf, sampling=sp)
    dt_to_p = ndimage.distance_transform_edt(~sp_surf, sampling=sp)
    d_pg = dt_to_g[sp_surf]   # pred surface -> gt surface
    d_gp = dt_to_p[sg_surf]   # gt surface -> pred surface
    allsd = np.concatenate([d_pg, d_gp])
    out["msd_mm"] = float(allsd.mean())
    out["hd95_mm"] = float(max(np.percentile(d_pg, 95), np.percentile(d_gp, 95)))
    out["hd_max_mm"] = float(allsd.max())
    return out


# ---------------------------------------------------------------------------
# Overlays
# ---------------------------------------------------------------------------

def save_overlay(png_path: Path, ct_zyx, pred, gt, window, title_bits, max_kb=400):
    """Axial PNG: windowed CT, prediction filled, ground truth as an outline."""
    from PIL import Image, ImageDraw

    idx = np.argwhere(gt | pred)
    if idx.size == 0:
        return None
    # Slice with the most GT (falls back to prediction).
    counts = (gt if gt.any() else pred).sum(axis=(1, 2))
    k = int(np.argmax(counts))

    lo = np.maximum(idx.min(0) - 40, 0)
    hi = np.minimum(idx.max(0) + 41, np.array(gt.shape))
    y0, y1, x0, x1 = int(lo[1]), int(hi[1]), int(lo[2]), int(hi[2])
    # Keep the crop square-ish and not tiny.
    ct = ct_zyx[k, y0:y1, x0:x1].astype(np.float32)
    p = pred[k, y0:y1, x0:x1]
    g = gt[k, y0:y1, x0:x1]

    wl, ww = window
    img = np.clip((ct - (wl - ww / 2)) / ww, 0, 1)
    rgb = np.repeat((img * 255).astype(np.uint8)[:, :, None], 3, axis=2)

    # Prediction: translucent orange fill plus a solid 1-px edge, because a
    # contrast-filled vessel saturates to white and a fill alone is unreadable
    # on it -- the edge is what distinguishes "predicted but thin" from "not
    # predicted at all".
    fill = np.array([255, 140, 0], np.float32)
    a = 0.45
    rgb[p] = (rgb[p] * (1 - a) + fill * a).astype(np.uint8)
    p_out = p & ~ndimage.binary_erosion(p, ndimage.generate_binary_structure(2, 2),
                                        border_value=0)
    rgb[p_out] = np.array([255, 110, 0], np.uint8)

    # Ground truth: solid cyan 1-px outline.
    g_out = g & ~ndimage.binary_erosion(g, ndimage.generate_binary_structure(2, 2),
                                        border_value=0)
    rgb[g_out] = np.array([0, 255, 255], np.uint8)

    im = Image.fromarray(rgb)
    # Upscale small crops so the boundary is readable, cap the long side.
    scale = max(1, min(3, int(np.ceil(320 / max(im.size)))))
    if scale > 1:
        im = im.resize((im.size[0] * scale, im.size[1] * scale), Image.NEAREST)
    if max(im.size) > 900:
        f = 900 / max(im.size)
        im = im.resize((int(im.size[0] * f), int(im.size[1] * f)), Image.LANCZOS)

    d = ImageDraw.Draw(im)
    for i, line in enumerate(title_bits):
        d.text((6, 6 + 13 * i), line, fill=(255, 255, 0))
    d.text((6, im.size[1] - 28), "fill = AI prediction", fill=(255, 170, 60))
    d.text((6, im.size[1] - 15), "outline = HaN-Seg expert", fill=(0, 255, 255))

    png_path.parent.mkdir(parents=True, exist_ok=True)
    im.save(png_path, optimize=True)
    if png_path.stat().st_size > max_kb * 1024:
        im.save(png_path, optimize=True, compress_level=9)
    return dict(path=str(png_path), slice_k=k, kb=round(png_path.stat().st_size / 1024, 1))


# ---------------------------------------------------------------------------
# Nodal-level sanity checks (HNLNL) - no ground truth exists, so this is
# structural plausibility only.
# ---------------------------------------------------------------------------

def nodal_sanity(levels, carotid_x):
    """levels: {name: {'centroid_lps':[x,y,z], 'ml':float, 'zmin':..,'zmax':..}}"""
    out = {"present": sorted(levels), "n_present": len(levels), "checks": {}}

    pairs = [("level_Ib_left", "level_Ib_right"), ("level_II_left", "level_II_right"),
             ("level_III_left", "level_III_right"), ("level_IVa_left", "level_IVa_right"),
             ("level_IVb_left", "level_IVb_right"), ("level_V_left", "level_V_right"),
             ("level_VIIb_left", "level_VIIb_right"),
             ("level_VIII_left", "level_VIII_right")]
    bil, asym = [], []
    for l, r in pairs:
        if l in levels and r in levels:
            xl = levels[l]["centroid_lps"][0]
            xr = levels[r]["centroid_lps"][0]
            vl, vr = levels[l]["ml"], levels[r]["ml"]
            bil.append(dict(pair=l.replace("_left", ""), x_left=xl, x_right=xr,
                            side_ok=bool(xl > 0 > xr),
                            mirror_offset_mm=float(xl + xr),
                            vol_left_ml=vl, vol_right_ml=vr,
                            vol_ratio=float(vl / vr) if vr else None))
        else:
            asym.append(dict(pair=l.replace("_left", ""),
                             left=l in levels, right=r in levels))
    out["checks"]["bilateral"] = bil
    out["checks"]["missing_side"] = asym
    out["checks"]["all_sides_correct"] = all(b["side_ok"] for b in bil) if bil else None
    if carotid_x:
        out["checks"]["carotid_x"] = carotid_x

    # Superior-to-inferior ordering: II above III above IVa above IVb. In LPS, +z
    # is superior, so the centroid z must decrease down the chain.
    order = {}
    for side in ("left", "right"):
        chain = [f"level_II_{side}", f"level_III_{side}",
                 f"level_IVa_{side}", f"level_IVb_{side}"]
        zs = [(n, levels[n]["centroid_lps"][2]) for n in chain if n in levels]
        ok = all(zs[i][1] > zs[i + 1][1] for i in range(len(zs) - 1))
        order[side] = dict(chain=[(n, round(z, 1)) for n, z in zs], monotonic_superior_to_inferior=ok)
    out["checks"]["cranio_caudal_order"] = order

    # Counts per side.
    out["checks"]["count_left"] = sum(1 for n in levels if n.endswith("_left"))
    out["checks"]["count_right"] = sum(1 for n in levels if n.endswith("_right"))
    out["checks"]["midline"] = sorted(
        n for n in levels if not (n.endswith("_left") or n.endswith("_right")))
    # Midline levels should sit near x = 0.
    out["checks"]["midline_offset_mm"] = {
        n: round(levels[n]["centroid_lps"][0], 1) for n in out["checks"]["midline"]}
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--n", type=int, default=5, help="number of cases (default 5)")
    ap.add_argument("--cases", nargs="*", default=None, help="explicit case ids")
    ap.add_argument("--out", default=str(Path(__file__).parent), help="output directory")
    ap.add_argument("--poll", type=float, default=10.0)
    ap.add_argument("--no-overlays", action="store_true")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    STAGE.mkdir(parents=True, exist_ok=True)
    log_path = out_dir / "run.log"
    logf = log_path.open("a", encoding="utf-8")

    def log(*a):
        s = " ".join(str(x) for x in a)
        print(s, flush=True)
        logf.write(s + "\n")
        logf.flush()

    local = os.environ["LOCALAPPDATA"]
    manifest_path = Path(local) / "HNRad" / "studies" / "public" / "HaN-Seg" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())

    cases = args.cases or [c for c in DEFAULT_CASES if c in manifest["cases"]][: args.n]
    log(f"=== hanseg_eval  {time.strftime('%Y-%m-%d %H:%M:%S')}  cases={cases}")

    health = _get("/api/health")
    log(f"backend: {health['status']} v{health['version']}")

    results = {"cases": {}, "pairs": [p["key"] for p in PAIRS],
               "mapping": PAIRS, "unmatched_gt": UNMATCHED_GT,
               "unmatched_pred": UNMATCHED_PRED, "jobs": {}, "nodal": {},
               "laterality": {}}

    t_start = time.time()

    for case in cases:
        log(f"\n--- {case}")
        info = manifest["cases"][case]
        uid = info["ct_series_uid"]
        organ_dir = Path(info["organ_files_dir"])

        # ---- 1. run every job -------------------------------------------------
        by_name = {}          # (task, structure) -> label_id
        job_rows = []
        for job_key, model, tasks, roi in JOBS:
            job = run_job(uid, model, tasks, roi, poll=args.poll, log=log)
            job_rows.append(dict(job_key=job_key, model=model, tasks=tasks,
                                 roi_subset=roi, status=job["status"],
                                 wall_s=round(job["wall_s"], 1),
                                 cached=job.get("cached"),
                                 n_structures=len(job.get("structures") or []),
                                 error=job.get("error"),
                                 rss_note=job.get("peak_rss_note")))
            if job["status"] != "done":
                continue
            tkey = tasks[0] if tasks else model
            for s in job.get("structures") or []:
                by_name[(tkey, s["name"])] = (s, (model, tasks, roi))
        results["jobs"][case] = job_rows

        # ---- 2. reference geometry from the CT NRRD --------------------------
        ct_img = sitk.ReadImage(str(Path(info["source_nrrd"])))
        ct_arr = sitk.GetArrayFromImage(ct_img)            # (z, y, x)
        ct_size = ct_img.GetSize()                          # (nx, ny, nz)
        ct_spacing = ct_img.GetSpacing()                    # (dx, dy, dz)
        spacing_zyx = (ct_spacing[2], ct_spacing[1], ct_spacing[0])
        ct_origin = ct_img.GetOrigin()
        ct_dir = ct_img.GetDirection()

        # ---- 3. fetch predicted masks ----------------------------------------
        masks = {}
        geom_report = None

        def fetch_named(tkey, name, s, spec):
            """Fetch a structure's mask, surviving a backend reload.

            `backend/run.ps1` starts uvicorn with `--reload`. Job state and label
            refs are in-memory, so a reload invalidates every `label_id` and the
            mask endpoint 404s -- despite CONTRACT.md promising AI labels outlive
            LRU eviction. Re-running the job is a disk-cache hit (<1 s) and
            re-registers the labels, so one retry is enough.
            """
            try:
                return fetch_mask(s["label_id"])
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise
                log(f"      label {name} 404 (backend reloaded?) - re-registering")
                model2, tasks2, roi2 = spec
                j2 = run_job(uid, model2, tasks2, roi2, poll=args.poll,
                             log=lambda *a: None)
                for s2 in j2.get("structures") or []:
                    by_name[(tkey, s2["name"])] = (s2, spec)
                    if s2["name"] == name:
                        s = s2
                return fetch_mask(s["label_id"])

        for (tkey, name), (s, spec) in list(by_name.items()):
            needed = any((tkey, name) in [tuple(x) for x in p["pred"]] for p in PAIRS)
            if not needed:
                continue
            try:
                arr, geo = fetch_named(tkey, name, s, spec)
            except Exception as e:                       # noqa: BLE001
                log(f"      ! mask fetch failed {tkey}/{name}: {e}")
                continue
            if geom_report is None:
                geom_report = dict(
                    mask_shape=list(geo["shape"]),
                    ct_shape=[ct_size[2], ct_size[1], ct_size[0]],
                    shape_match=list(geo["shape"]) == [ct_size[2], ct_size[1], ct_size[0]],
                    spacing_match=bool(np.allclose(geo["spacing"], spacing_zyx, atol=1e-4)),
                    origin_match=bool(np.allclose(geo["origin"], ct_origin, atol=1e-3)),
                    direction_match=bool(np.allclose(geo["direction"], ct_dir, atol=1e-6)),
                )
                log(f"      grid check vs CT NRRD: {geom_report}")
            masks[(tkey, name)] = pack(arr.astype(bool))
            del arr

        # ---- 4. ground truth + metrics ---------------------------------------
        case_rows = {}
        gt_cache = {}
        shape = (ct_size[2], ct_size[1], ct_size[0])

        def load_gt(stem):
            """-> (bool volume, grid_matched_ct) or None. Cached bit-packed."""
            if stem in gt_cache:
                c = gt_cache[stem]
                return None if c is None else (unpack(c[0], shape), c[1])
            p = organ_dir / f"{case}_{stem}.seg.nrrd"
            if not p.exists():
                gt_cache[stem] = None
                return None
            im = sitk.ReadImage(str(p))
            same = (im.GetSize() == ct_size
                    and np.allclose(im.GetSpacing(), ct_spacing, atol=1e-6)
                    and np.allclose(im.GetOrigin(), ct_origin, atol=1e-4)
                    and np.allclose(im.GetDirection(), ct_dir, atol=1e-6))
            if not same:
                # Resample onto the CT grid with nearest neighbour.
                log(f"      ! {stem}: grid differs from CT, resampling NN")
                rs = sitk.ResampleImageFilter()
                rs.SetReferenceImage(ct_img)
                rs.SetInterpolator(sitk.sitkNearestNeighbor)
                rs.SetDefaultPixelValue(0)
                im = rs.Execute(im)
            a = sitk.GetArrayFromImage(im) > 0
            gt_cache[stem] = (pack(a), same)
            return a, same

        for pair in PAIRS:
            gts = [load_gt(s) for s in pair["gt"]]
            if any(g is None for g in gts):
                case_rows[pair["key"]] = {"status": "gt_missing"}
                continue
            gt = np.zeros_like(gts[0][0])
            for g, _ in gts:
                gt |= g
            grids_matched = all(m for _, m in gts)

            if all(tuple(x) not in masks for x in pair["pred"]):
                case_rows[pair["key"]] = {
                    "status": "pred_missing",
                    "wanted": [list(x) for x in pair["pred"]]}
                continue
            pred = np.zeros_like(gt)
            found = []
            for spec in pair["pred"]:
                p = masks.get(tuple(spec))
                if p is not None:
                    pred |= unpack(p, shape)
                    found.append(list(spec))

            m = metrics(pred, gt, spacing_zyx, ct_origin, ct_dir)
            m["status"] = "ok"
            m["quality"] = pair["quality"]
            m["pred_components"] = found
            m["gt_grid_matched_ct"] = grids_matched

            if pair["z_restrict"] and gt.any():
                ks = np.argwhere(gt.any(axis=(1, 2))).ravel()
                k0, k1 = int(ks.min()), int(ks.max()) + 1
                mz = metrics(pred[k0:k1], gt[k0:k1], spacing_zyx, ct_origin, ct_dir)
                m["dice_z"] = mz["dice"]
                m["hd95_z_mm"] = mz["hd95_mm"]
                m["msd_z_mm"] = mz["msd_mm"]
                m["volume_ratio_z"] = mz["volume_ratio"]
                m["gt_z_slices"] = k1 - k0

            case_rows[pair["key"]] = m
            log(f"      {pair['key']:<26} dice {m['dice']:.3f}"
                + (f" (z {m.get('dice_z'):.3f})" if m.get("dice_z") is not None else "")
                + f"  hd95 {m['hd95_mm'] if m['hd95_mm'] is None else round(m['hd95_mm'],1)}"
                f"  msd {m['msd_mm'] if m['msd_mm'] is None else round(m['msd_mm'],2)}"
                f"  vr {m['volume_ratio'] if m['volume_ratio'] is None else round(m['volume_ratio'],2)}")

        # ---- 5. laterality audit ---------------------------------------------
        lat = []
        R = np.asarray(ct_dir, float).reshape(3, 3).T
        sp_ijk = np.array([ct_spacing[0], ct_spacing[1], ct_spacing[2]])

        def centroid_x(arr):
            if not arr.any():
                return None
            c = np.argwhere(arr).mean(0)
            ijk = np.array([c[2], c[1], c[0]]) * sp_ijk
            return float((np.asarray(ct_origin, float) + R @ ijk)[0])

        for gt_stem, pred_spec, side in [
            ("OAR_A_Carotid_L", ("headneck_bones_vessels", "internal_carotid_artery_left"), "left"),
            ("OAR_A_Carotid_R", ("headneck_bones_vessels", "internal_carotid_artery_right"), "right"),
            ("OAR_Parotid_L", ("head_glands_cavities", "parotid_gland_left"), "left"),
            ("OAR_Parotid_R", ("head_glands_cavities", "parotid_gland_right"), "right"),
            ("OAR_Glnd_Submand_L", ("head_glands_cavities", "submandibular_gland_left"), "left"),
            ("OAR_Glnd_Submand_R", ("head_glands_cavities", "submandibular_gland_right"), "right"),
            ("OAR_Eye_PL", ("head_glands_cavities", "eye_left"), "left"),
            ("OAR_Eye_PR", ("head_glands_cavities", "eye_right"), "right"),
        ]:
            g = load_gt(gt_stem)
            p = masks.get(pred_spec)
            gx = centroid_x(g[0]) if g else None
            px = centroid_x(unpack(p, shape)) if p is not None else None
            want_pos = side == "left"          # LPS: +x is patient left
            lat.append(dict(
                gt=gt_stem, pred=pred_spec[1], side=side,
                gt_centroid_x=None if gx is None else round(gx, 1),
                pred_centroid_x=None if px is None else round(px, 1),
                gt_side_ok=None if gx is None else (gx > 0) == want_pos,
                pred_side_ok=None if px is None else (px > 0) == want_pos,
                agree=None if (gx is None or px is None) else ((gx > 0) == (px > 0)),
            ))
        results["laterality"][case] = lat
        bad = [r for r in lat if r["agree"] is False or r["gt_side_ok"] is False
               or r["pred_side_ok"] is False]
        log(f"      laterality: {len(lat) - len(bad)}/{len(lat)} consistent"
            + (f"  FLIPS: {[r['gt'] for r in bad]}" if bad else ""))

        # ---- 6. nodal levels --------------------------------------------------
        levels = {}
        hn = next((j for j in job_rows if j["model"] == "hnlnl"), None)
        if hn and hn["status"] == "done":
            for (tkey, name), (s, spec) in list(by_name.items()):
                if tkey != "hnlnl":
                    continue
                try:
                    arr, _ = fetch_named(tkey, name, s, spec)
                except Exception as e:                   # noqa: BLE001
                    log(f"      ! nodal mask {name}: {e}")
                    continue
                a = arr.astype(bool)
                idx = np.argwhere(a)
                if idx.size == 0:
                    continue
                c = idx.mean(0)
                ijk = np.array([c[2], c[1], c[0]]) * sp_ijk
                cen = np.asarray(ct_origin, float) + R @ ijk
                zs = idx[:, 0]
                z0 = ct_img.TransformContinuousIndexToPhysicalPoint((0., 0., float(zs.min())))[2]
                z1 = ct_img.TransformContinuousIndexToPhysicalPoint((0., 0., float(zs.max())))[2]
                levels[name] = dict(centroid_lps=[round(float(v), 1) for v in cen],
                                    ml=round(float(a.sum()) * np.prod(spacing_zyx) / 1000.0, 2),
                                    zmin=round(min(z0, z1), 1), zmax=round(max(z0, z1), 1),
                                    n_voxels=int(a.sum()))
        car_x = {}
        for spec, key in [(("headneck_bones_vessels", "internal_carotid_artery_left"), "ica_left"),
                          (("headneck_bones_vessels", "internal_carotid_artery_right"), "ica_right")]:
            if spec in masks:
                car_x[key] = round(centroid_x(unpack(masks[spec], shape)), 1)
        results["nodal"][case] = nodal_sanity(levels, car_x) if levels else {"status": "none"}
        if levels:
            ch = results["nodal"][case]["checks"]
            log(f"      nodal: {len(levels)}/20 levels, L={ch['count_left']} R={ch['count_right']}, "
                f"sides_ok={ch['all_sides_correct']}")

        results["cases"][case] = dict(
            series_uid=uid, n_slices=info["n_slices"],
            ct_shape=[ct_size[2], ct_size[1], ct_size[0]],
            ct_spacing_zyx=[round(v, 4) for v in spacing_zyx],
            grid_check=geom_report, metrics=case_rows)

        # ---- 7. keep arrays for overlays -------------------------------------
        # Staged as a *cropped* region (bbox + 40 voxel margin), not the whole
        # 212 MB volume: which case is best/worst is only known after all cases run.
        if not args.no_overlays:
            for key, specs, gtstem, win in [
                ("carotid_left", [("headneck_bones_vessels", "internal_carotid_artery_left"),
                                  ("total", "common_carotid_artery_left")],
                 "OAR_A_Carotid_L", (120, 600)),
                ("carotid_right", [("headneck_bones_vessels", "internal_carotid_artery_right"),
                                   ("total", "common_carotid_artery_right")],
                 "OAR_A_Carotid_R", (120, 600)),
                ("mandible", [("craniofacial_structures", "mandible")],
                 "OAR_Bone_Mandible", (400, 1800)),
            ]:
                pr = np.zeros(shape, bool)
                any_p = False
                for sp_ in specs:
                    if sp_ in masks:
                        pr |= unpack(masks[sp_], shape)
                        any_p = True
                g = load_gt(gtstem)
                if not (any_p and g is not None):
                    continue
                gg = g[0]
                idx = np.argwhere(pr | gg)
                if idx.size == 0:
                    continue
                lo = np.maximum(idx.min(0) - np.array([2, 40, 40]), 0)
                hi = np.minimum(idx.max(0) + np.array([3, 41, 41]), np.array(shape))
                sl = tuple(slice(int(a), int(b)) for a, b in zip(lo, hi))
                np.savez_compressed(
                    STAGE / f"_tmp_{case}_{key}.npz",
                    ct=ct_arr[sl].astype(np.int16), pred=pr[sl], gt=gg[sl],
                    win=np.array(win))
                del pr, gg

        del masks, ct_arr
        elapsed = time.time() - t_start
        log(f"    [{case} done, total elapsed {elapsed/60:.1f} min]")

    results["total_wall_min"] = round((time.time() - t_start) / 60, 1)
    (out_dir / "results.json").write_text(json.dumps(results, indent=1, default=str))
    log(f"\nwrote {out_dir / 'results.json'}  total {results['total_wall_min']} min")

    # ---- 8. summary first, then overlays -------------------------------------
    # summarise() writes summary.json, which REPORT.md's tables are built from, so
    # it must not be reachable only after the overlay step: a failure in rendering
    # or in cleaning up the staging files would otherwise silently cost the
    # summary of a multi-hour run.
    summarise(results, out_dir, log)

    if not args.no_overlays:
        try:
            make_overlays(results, cases, out_dir, log)
        except Exception as e:                            # noqa: BLE001
            log(f"! overlays failed: {e!r}")


def make_overlays(results, cases, out_dir, log):
    ov = out_dir / "overlays"
    ov.mkdir(exist_ok=True)
    made = []
    for key, metric_key in [("carotid_left", "carotid_left"),
                            ("carotid_right", "carotid_right"),
                            ("mandible", "mandible")]:
        scored = []
        for c in cases:
            m = results["cases"].get(c, {}).get("metrics", {}).get(metric_key, {})
            if m.get("status") == "ok" and m.get("dice") is not None:
                scored.append((m["dice"], c))
        if not scored:
            continue
        scored.sort()
        picks = {"worst": scored[0], "best": scored[-1]}
        for tag, (dice, c) in picks.items():
            f = STAGE / f"_tmp_{c}_{key}.npz"
            if not f.exists():
                continue
            z = np.load(f)
            pred, gt, ct = z["pred"], z["gt"], z["ct"]
            win = tuple(float(v) for v in z["win"])
            name = f"{key}_{tag}_{c}_dice{dice:.2f}.png"
            r = save_overlay(ov / name, ct, pred, gt, win,
                             [f"{key}  {tag}  {c}", f"Dice {dice:.3f}"])
            if r:
                made.append(dict(structure=key, tag=tag, case=c, dice=round(dice, 3), **r))
                log(f"  overlay {name} ({r['kb']} KB, slice k={r['slice_k']})")
    (out_dir / "overlays.json").write_text(json.dumps(made, indent=1))
    for p in STAGE.glob("_tmp_*"):
        p.unlink()


def summarise(results, out_dir, log):
    """Mean +/- SD per structure across cases."""
    cases = list(results["cases"])
    table = {}
    for key in results["pairs"]:
        vals = {k: [] for k in ("dice", "dice_z", "hd95_mm", "hd95_z_mm",
                                "msd_mm", "msd_z_mm", "volume_ratio",
                                "volume_ratio_z", "centroid_dist_mm")}
        per_case = {}
        for c in cases:
            m = results["cases"][c]["metrics"].get(key, {})
            if m.get("status") != "ok":
                per_case[c] = m.get("status")
                continue
            per_case[c] = {k: (None if m.get(k) is None else round(m[k], 4))
                           for k in vals}
            for k in vals:
                if m.get(k) is not None:
                    vals[k].append(m[k])
        table[key] = {
            "n": len(vals["dice"]),
            "per_case": per_case,
            **{k: (dict(mean=round(float(np.mean(v)), 4),
                        sd=round(float(np.std(v, ddof=1)), 4) if len(v) > 1 else None)
                   if v else None)
               for k, v in vals.items()},
        }
    summary = {"cases": cases, "structures": table,
               "total_wall_min": results.get("total_wall_min")}
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1))
    log("\n=== Dice summary ===")
    for k, v in table.items():
        d = v.get("dice")
        if d:
            log(f"  {k:<28} {d['mean']:.3f} +/- {d['sd'] if d['sd'] is None else round(d['sd'],3)}  (n={v['n']})")
        else:
            log(f"  {k:<28} n/a")


def tables(out_dir: Path):
    """Emit the REPORT.md tables from results.json / summary.json.

        ... hanseg_eval.py --tables

    Kept in this file so every number in REPORT.md is generated, never retyped.
    """
    res = json.loads((out_dir / "results.json").read_text())
    summ = json.loads((out_dir / "summary.json").read_text())
    cases = summ["cases"]
    qual = {p["key"]: p["quality"] for p in res["mapping"]}

    def f(v, n=3):
        return "-" if v is None else f"{v:.{n}f}"

    print("### Summary: mean +/- SD across cases\n")
    print("| structure | pair | n | Dice | HD95 (mm) | MSD (mm) | vol ratio | centroid (mm) |")
    print("|---|---|---|---|---|---|---|---|")
    for k, v in summ["structures"].items():
        if not v.get("dice"):
            print(f"| {k} | {qual.get(k,'')} | 0 | - | - | - | - | - |")
            continue
        def ms(key, n=3):
            d = v.get(key)
            if not d:
                return "-"
            return f"{d['mean']:.{n}f}" + (f" ± {d['sd']:.{n}f}" if d.get("sd") is not None else "")
        print(f"| {k} | {qual.get(k,'')} | {v['n']} | {ms('dice')} | {ms('hd95_mm',1)} | "
              f"{ms('msd_mm',2)} | {ms('volume_ratio',2)} | {ms('centroid_dist_mm',1)} |")

    print("\n### Per-case Dice\n")
    print("| structure | " + " | ".join(cases) + " |")
    print("|---" * (len(cases) + 1) + "|")
    for k, v in summ["structures"].items():
        row = []
        for c in cases:
            pc = v["per_case"].get(c)
            row.append(pc if isinstance(pc, str) else f(pc.get("dice")))
        print(f"| {k} | " + " | ".join(row) + " |")

    print("\n### Extent-corrected (z-restricted to the GT slice range)\n")
    print("| structure | Dice (raw) | Dice (z-restricted) | vol ratio (raw) | vol ratio (z) |")
    print("|---|---|---|---|---|")
    for k, v in summ["structures"].items():
        if not v.get("dice_z"):
            continue
        print(f"| {k} | {v['dice']['mean']:.3f} | {v['dice_z']['mean']:.3f} | "
              f"{v['volume_ratio']['mean']:.2f} | {v['volume_ratio_z']['mean']:.2f} |")

    print("\n### Job wall times (s)\n")
    tasks = [j[0] for j in JOBS]
    print("| case | " + " | ".join(tasks) + " | case total |")
    print("|---" * (len(tasks) + 2) + "|")
    for c in cases:
        row, tot = [], 0.0
        for t in tasks:
            j = next((x for x in res["jobs"].get(c, [])
                      if x.get("job_key", (x["tasks"] or [x["model"]])[0]) == t), None)
            if j is None:
                row.append("-")
            else:
                row.append(f"{j['wall_s']:.0f}" + (" (cache)" if j.get("cached") else ""))
                tot += j["wall_s"]
        print(f"| {c} | " + " | ".join(row) + f" | {tot/60:.1f} min |")

    print("\n### Laterality audit\n")
    print("| case | GT organ | predicted | side | GT centroid x | pred centroid x | agree |")
    print("|---|---|---|---|---|---|---|")
    for c in cases:
        for r in res["laterality"].get(c, []):
            print(f"| {c} | {r['gt']} | {r['pred']} | {r['side']} | {r['gt_centroid_x']} | "
                  f"{r['pred_centroid_x']} | {'yes' if r['agree'] else 'NO' if r['agree'] is False else '-'} |")

    print("\n### Nodal levels (HNLNL)\n")
    for c in cases:
        n = res["nodal"].get(c, {})
        if not n or n.get("status") == "none":
            print(f"- {c}: no nodal output")
            continue
        ch = n["checks"]
        print(f"\n**{c}** - {n['n_present']}/20 levels present "
              f"(left {ch['count_left']}, right {ch['count_right']}, "
              f"midline {', '.join(ch['midline']) or 'none'})")
        print(f"  - all bilateral pairs on the correct side: `{ch['all_sides_correct']}`")
        print(f"  - carotid reference x: {ch.get('carotid_x')}")
        print(f"  - midline level centroid x (mm): {ch['midline_offset_mm']}")
        for side, d in ch["cranio_caudal_order"].items():
            print(f"  - {side} II->III->IVa->IVb z: {d['chain']} monotonic={d['monotonic_superior_to_inferior']}")
        if ch["missing_side"]:
            miss = [m["pair"] for m in ch["missing_side"] if not (m["left"] and m["right"])]
            print(f"  - pairs not bilaterally present: {miss}")
        print("  - mirror symmetry |x_L + x_R| (mm): " +
              ", ".join(f"{b['pair']} {abs(b['mirror_offset_mm']):.1f}" for b in ch["bilateral"]))


if __name__ == "__main__":
    if "--tables" in sys.argv:
        tables(Path(sys.argv[sys.argv.index("--tables") + 1]
                    if len(sys.argv) > sys.argv.index("--tables") + 1
                    and not sys.argv[sys.argv.index("--tables") + 1].startswith("-")
                    else Path(__file__).parent))
        sys.exit(0)
    sys.exit(main())
