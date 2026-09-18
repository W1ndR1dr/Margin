"""Airway analyser: lumen segmentation, centreline and a CSA profile.

Implements TOOLS-SPEC section 4.  The pipeline is deliberately the "simpler,
adequate for the trachea/larynx" variant the spec allows:

1. Region grow the lumen from a seed, clipped to the body mask.
2. Track the lumen centroid slice by slice away from the seed, following the
   connected component nearest the previous centroid so a splitting or merging
   lumen (pyriform sinuses, the carina) does not derail the walk.  The walk
   ends when the lumen runs out, when the centroid would jump further than
   MAX_JUMP_MM, or when every candidate component has ballooned relative to the
   sections accepted so far -- which is what a lung apex merging into the
   trachea below the thoracic inlet looks like.  Smooth the track with a
   Gaussian along z.
3. At every sample cut a 60 x 60 mm plane perpendicular to the local tangent,
   resample the label at 0.3 mm, keep the component containing the centreline
   point and measure its area and PCA diameters.
4. Reference CSA, stenosis percentage, stenosis length, distance from the
   glottis and the Myer-Cotton grade.

Everything is computed in the local (index-aligned) millimetre frame used by
:mod:`hnrad.segmentation`; only the reported points are mapped to patient LPS.
"""

from __future__ import annotations

import logging
import math
import time
from typing import Any, Optional, Sequence

import numpy as np

from .analysis import AnalysisError, SeriesVolume
from . import segmentation as seg

log = logging.getLogger("hnrad.airway")

__all__ = ["analyze_airway", "PATCH_MM", "PATCH_SPACING_MM"]

# Perpendicular section: 60 x 60 mm sampled at 0.3 mm.
PATCH_MM = 60.0
PATCH_SPACING_MM = 0.3

# Gaussian smoothing of the centreline, in millimetres of arc.
CENTERLINE_SIGMA_MM = 2.0

# A slice component has to be at least this big to be believable as lumen.
MIN_SLICE_AREA_MM2 = 1.0

# How far the lumen centroid may jump between neighbouring slices.
MAX_JUMP_MM = 20.0

# A slice component that is more than MAX_AREA_RATIO times the running median
# of the sections accepted so far -- and bigger than MERGE_AREA_MM2 in absolute
# terms, so a small lumen cannot trip it on noise -- has merged with something
# that is not the airway (a lung apex below the thoracic inlet, typically).
MAX_AREA_RATIO = 4.0
MERGE_AREA_MM2 = 300.0

# CSA below this fraction of the reference counts as stenotic.
STENOSIS_FRACTION = 0.7


# --------------------------------------------------------------------------
# centreline
# --------------------------------------------------------------------------

def _slice_components(plane: np.ndarray):
    from scipy import ndimage

    lab, n = ndimage.label(plane > 0)
    return lab, int(n)


def _track_centerline(
    mask: np.ndarray, seed: tuple[int, int, int], dy: float, dx: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Walk the lumen centroid up and down from the seed slice.

    Returns ``(k, j_centroid, i_centroid)`` arrays in increasing ``k`` order.
    """
    from scipy import ndimage

    # Track inside the bounding box of the lumen: labelling 60 x 60 pixels per
    # slice instead of 512 x 512 is what keeps this well under a second.
    box = seg._bbox3(mask)
    mask = mask[box]
    nz = mask.shape[0]
    i0 = int(seed[0]) - box[2].start
    j0 = int(seed[1]) - box[1].start
    k0 = int(seed[2]) - box[0].start
    if not (0 <= i0 < mask.shape[2] and 0 <= j0 < mask.shape[1]
            and 0 <= k0 < nz):
        raise AnalysisError("the seed is not inside the segmented lumen")
    min_pixels = max(1, int(round(MIN_SLICE_AREA_MM2 / (dy * dx))))

    px_mm2 = float(dy) * float(dx)
    lab, n = _slice_components(mask[k0])
    if n == 0 or lab[j0, i0] == 0:
        raise AnalysisError("the seed slice has no lumen at the seed position")
    seed_comp = lab == lab[j0, i0]
    seed_area = float(seed_comp.sum()) * px_mm2
    start = ndimage.center_of_mass(seed_comp)
    track: dict[int, tuple[float, float]] = {k0: (float(start[0]), float(start[1]))}

    for direction in (+1, -1):
        prev = track[k0]
        # Sections accepted so far in this direction, mm^2, so a component that
        # suddenly dwarfs the airway can be recognised as a merge.
        areas = [seed_area]
        k = k0 + direction
        while 0 <= k < nz:
            lab, n = _slice_components(mask[k])
            if n == 0:
                break
            sizes = np.bincount(lab.ravel())
            sizes[0] = 0
            biggest = max(MERGE_AREA_MM2,
                          MAX_AREA_RATIO * float(np.median(areas)))
            keep = [c for c in range(1, n + 1)
                    if sizes[c] >= min_pixels and sizes[c] * px_mm2 <= biggest]
            if not keep:
                break
            centres = ndimage.center_of_mass(lab > 0, lab, keep)
            # Prefer the component the previous centroid actually lands in.
            pj, pi = int(round(prev[0])), int(round(prev[1]))
            pick = None
            if 0 <= pj < lab.shape[0] and 0 <= pi < lab.shape[1]:
                here = int(lab[pj, pi])
                if here in keep:
                    pick = keep.index(here)
            if pick is None:
                d = [((c[0] - prev[0]) * dy) ** 2 + ((c[1] - prev[1]) * dx) ** 2
                     for c in centres]
                pick = int(np.argmin(d))
            chosen = centres[pick]
            # The lumen never moves far between neighbouring slices, whichever
            # way the component was picked.
            step = math.hypot((chosen[0] - prev[0]) * dy,
                              (chosen[1] - prev[1]) * dx)
            if step > MAX_JUMP_MM:
                break
            track[k] = (float(chosen[0]), float(chosen[1]))
            areas.append(float(sizes[keep[pick]]) * px_mm2)
            prev = track[k]
            k += direction

    ks = np.asarray(sorted(track), dtype=np.int64)
    if ks.size < 3:
        raise AnalysisError("the airway lumen spans fewer than 3 slices")
    js = np.asarray([track[int(k)][0] for k in ks], dtype=np.float64)
    is_ = np.asarray([track[int(k)][1] for k in ks], dtype=np.float64)
    # Back to whole-volume indices.
    return (ks + box[0].start, js + box[1].start, is_ + box[2].start)


def _smooth_tangents(points: np.ndarray, sigma_samples: float) -> np.ndarray:
    from scipy import ndimage

    tang = np.gradient(points, axis=0)
    if sigma_samples > 0.3 and points.shape[0] > 3:
        tang = ndimage.gaussian_filter1d(tang, sigma_samples, axis=0, mode="nearest")
    norms = np.linalg.norm(tang, axis=1)
    norms[norms < 1e-9] = 1.0
    return tang / norms[:, None]


def _perp_basis(tangent: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Two unit vectors spanning the plane normal to ``tangent``."""
    helper = np.zeros(3)
    helper[int(np.argmin(np.abs(tangent)))] = 1.0
    e1 = np.cross(tangent, helper)
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(tangent, e1)
    e2 /= np.linalg.norm(e2)
    return e1, e2


# --------------------------------------------------------------------------
# cross sections
# --------------------------------------------------------------------------

def _section(resampler, mask_img, centre: np.ndarray, tangent: np.ndarray,
             n: int, half: float) -> tuple[float, float, float]:
    """(area_mm2, min_diameter_mm, max_diameter_mm) of one perpendicular cut."""
    import SimpleITK as sitk
    from scipy import ndimage

    e1, e2 = _perp_basis(tangent)
    origin = centre - half * e1 - half * e2
    resampler.SetOutputDirection((
        float(e1[0]), float(e2[0]), float(tangent[0]),
        float(e1[1]), float(e2[1]), float(tangent[1]),
        float(e1[2]), float(e2[2]), float(tangent[2]),
    ))
    resampler.SetOutputOrigin((float(origin[0]), float(origin[1]), float(origin[2])))
    patch = sitk.GetArrayFromImage(resampler.Execute(mask_img))[0]

    binary = patch >= 0.5
    if not binary.any():
        return 0.0, 0.0, 0.0
    lab, ncomp = ndimage.label(binary)
    mid = n // 2
    tag = int(lab[mid, mid])
    if tag == 0:
        # The centreline drifted off the lumen by a fraction of a millimetre:
        # take the component closest to the centre of the patch.
        idx = np.argwhere(binary)
        nearest = int(np.argmin(((idx - mid) ** 2).sum(axis=1)))
        tag = int(lab[idx[nearest][0], idx[nearest][1]])
    comp = np.argwhere(lab == tag)
    area = float(comp.shape[0]) * PATCH_SPACING_MM * PATCH_SPACING_MM

    pts = comp.astype(np.float64) * PATCH_SPACING_MM
    if pts.shape[0] < 2:
        return area, PATCH_SPACING_MM, PATCH_SPACING_MM
    centred = pts - pts.mean(axis=0)
    cov = np.atleast_2d(np.cov(centred, rowvar=False))
    try:
        _vals, vecs = np.linalg.eigh(cov)
    except np.linalg.LinAlgError:                       # pragma: no cover
        vecs = np.eye(2)
    proj = centred @ vecs
    spans = (proj.max(axis=0) - proj.min(axis=0)) + PATCH_SPACING_MM
    return area, float(spans.min()), float(spans.max())


# --------------------------------------------------------------------------
# stenosis metrics
# --------------------------------------------------------------------------

def _myer_cotton(pct: float) -> str:
    if pct >= 100.0:
        return "IV"
    if pct > 70.0:
        return "III"
    if pct > 50.0:
        return "II"
    return "I"


def _reference_csa(
    csa: np.ndarray, min_idx: int, mode: str,
    sample_k: np.ndarray, ref_range_k: Optional[Sequence[int]],
) -> tuple[float, str]:
    """Reference cross-sectional area, and how it was obtained."""
    valid = csa > 0
    if mode == "manual":
        if not ref_range_k or len(ref_range_k) != 2:
            raise AnalysisError("reference='manual' needs ref_range_k [k0, k1]")
        k0, k1 = sorted(int(v) for v in ref_range_k)
        sel = valid & (sample_k >= k0) & (sample_k <= k1)
        if not sel.any():
            raise AnalysisError(
                "ref_range_k [{a}, {b}] contains no centreline samples".format(
                    a=k0, b=k1)
            )
        return float(np.median(csa[sel])), "manual k {a}..{b}".format(a=k0, b=k1)

    # auto: the 75th percentile of the non-stenotic trachea below the stenosis.
    below = valid.copy()
    below[min_idx:] = False
    pool = below if below.sum() >= 3 else valid.copy()
    if pool.sum() < 3:
        pool = valid
    rough = float(np.percentile(csa[pool], 75))
    healthy = pool & (csa >= STENOSIS_FRACTION * rough)
    if healthy.sum() >= 3:
        return float(np.percentile(csa[healthy], 75)), "auto (below the stenosis)"
    return rough, "auto (whole airway)"


def _stenosis_length(csa: np.ndarray, arclen: np.ndarray, min_idx: int,
                     cutoff: float) -> float:
    n = csa.size
    if csa[min_idx] >= cutoff:
        return 0.0
    lo = min_idx
    while lo - 1 >= 0 and csa[lo - 1] < cutoff:
        lo -= 1
    hi = min_idx
    while hi + 1 < n and csa[hi + 1] < cutoff:
        hi += 1
    if hi > lo:
        return float(arclen[hi] - arclen[lo])
    # A single sample: report the local sampling step.
    if n > 1:
        neighbours = [abs(arclen[min(hi + 1, n - 1)] - arclen[min_idx]),
                      abs(arclen[min_idx] - arclen[max(lo - 1, 0)])]
        step = max(v for v in neighbours if v > 0) if any(
            v > 0 for v in neighbours) else 0.0
        return float(step)
    return 0.0


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

def analyze_airway(
    vol: SeriesVolume,
    seed_ijk: Optional[Sequence[float]] = None,
    seed_lps: Optional[Sequence[float]] = None,
    lower_hu: float = -1024.0,
    upper_hu: float = -400.0,
    glottis_slice: Optional[int] = None,
    reference: str = "auto",
    ref_range_k: Optional[Sequence[int]] = None,
    cap_at_glottis: bool = False,
    closing_mm: float = 1.0,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Segment the airway and profile it.  Returns ``(mask, result)``.

    With ``cap_at_glottis`` and a ``glottis_slice`` the profile stops at the
    vocal folds: every centreline sample superior to that slice is dropped
    before the sections are cut, so the minimum, the reference and the grade
    describe the laryngotracheal airway rather than the pharynx and nose the
    centroid walk would otherwise climb into.  The lumen label itself is left
    whole.
    """
    import SimpleITK as sitk

    t0 = time.perf_counter()
    mode = str(reference or "auto").lower()
    if mode not in ("auto", "manual"):
        raise AnalysisError("reference must be 'auto' or 'manual'")

    seed = seg.seed_to_ijk(vol, seed_ijk, seed_lps)
    dz, dy, dx = vol.spacing

    body = seg.body_mask(vol)
    t_body = time.perf_counter()

    mask = seg.region_grow(
        vol, seed, lower_hu, upper_hu,
        max_radius_mm=None, closing_mm=closing_mm, keep_largest=True,
        restrict=body,
    )
    t_grow = time.perf_counter()

    ks, js, is_ = _track_centerline(mask, seed, float(dy), float(dx))

    # +k is superior when the slice direction points to +z (LPS).
    k_up = 1 if float(np.dot(vol.slice_dir, np.asarray([0.0, 0.0, 1.0]))) >= 0 else -1
    capped = False
    if cap_at_glottis and glottis_slice is not None:
        gk = int(glottis_slice)
        keep = (ks - gk) * k_up <= 0
        if keep.sum() < ks.size:
            capped = True
            if keep.sum() < 3:
                raise AnalysisError(
                    "fewer than 3 centreline samples remain at or below the "
                    "glottis (slice {g}); is the vocal-fold mark above the "
                    "seed?".format(g=gk)
                )
            ks, js, is_ = ks[keep], js[keep], is_[keep]

    pts = np.column_stack([is_ * float(dx), js * float(dy),
                           ks.astype(np.float64) * float(dz)])

    # Gaussian smoothing along z, then tangents by finite differences.
    from scipy import ndimage

    sigma = CENTERLINE_SIGMA_MM / max(float(dz), 1e-6)
    if pts.shape[0] > 3 and sigma > 0.3:
        pts[:, 0] = ndimage.gaussian_filter1d(pts[:, 0], sigma, mode="nearest")
        pts[:, 1] = ndimage.gaussian_filter1d(pts[:, 1], sigma, mode="nearest")

    # Order the profile inferior -> superior in the patient.
    if k_up < 0:
        pts = pts[::-1]
        ks = ks[::-1]
    tangents = _smooth_tangents(pts, sigma)
    t_center = time.perf_counter()

    # Perpendicular sections.
    n = int(round(PATCH_MM / PATCH_SPACING_MM)) + 1       # odd: exact centre px
    half = (n // 2) * PATCH_SPACING_MM
    mask_img = seg.sitk_image(mask.astype(np.float32, copy=False), vol)
    resampler = sitk.ResampleImageFilter()
    resampler.SetInterpolator(sitk.sitkLinear)
    resampler.SetDefaultPixelValue(0.0)
    resampler.SetOutputPixelType(sitk.sitkFloat32)
    resampler.SetSize((n, n, 1))
    resampler.SetOutputSpacing((PATCH_SPACING_MM, PATCH_SPACING_MM, 1.0))

    csa = np.zeros(pts.shape[0], dtype=np.float64)
    dmin = np.zeros_like(csa)
    dmax = np.zeros_like(csa)
    for s in range(pts.shape[0]):
        csa[s], dmin[s], dmax[s] = _section(
            resampler, mask_img, pts[s], tangents[s], n, half)
    t_sections = time.perf_counter()

    arclen = np.zeros(pts.shape[0], dtype=np.float64)
    if pts.shape[0] > 1:
        arclen[1:] = np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))

    positive = csa > 0
    if not positive.any():
        raise AnalysisError("no measurable cross sections along the centreline")
    min_idx = int(np.argmin(np.where(positive, csa, np.inf)))

    csa_ref, ref_how = _reference_csa(csa, min_idx, mode, ks, ref_range_k)
    ref_used: Optional[list[int]] = None
    if mode == "manual" and ref_range_k:
        ref_used = sorted(int(v) for v in ref_range_k)
    min_csa = float(csa[min_idx])
    if csa_ref > 0:
        pct = 100.0 * (1.0 - min_csa / csa_ref)
        stenosis_pct: Optional[float] = float(min(100.0, max(0.0, pct)))
        grade: Optional[str] = _myer_cotton(stenosis_pct)
        length = _stenosis_length(csa, arclen, min_idx,
                                  STENOSIS_FRACTION * csa_ref)
    else:                                               # pragma: no cover
        stenosis_pct = None
        grade = None
        length = 0.0

    from_glottis: Optional[float] = None
    if glottis_slice is not None:
        gk = int(glottis_slice)
        g_idx = int(np.argmin(np.abs(ks - gk)))
        from_glottis = float(abs(arclen[min_idx] - arclen[g_idx]))

    eq_diam = 2.0 * np.sqrt(np.maximum(csa, 0.0) / math.pi)
    lps = seg.local_to_lps(vol, pts)

    took_ms = (time.perf_counter() - t0) * 1000.0
    log.info(
        "airway series=%s seed=%s -> %d samples, ref=%.1f mm2 (%s), min=%.1f mm2"
        " @k=%d, %.1f%% grade %s | body %.2fs grow %.2fs centreline %.2fs"
        " sections %.2fs total %.2fs",
        vol.series_uid, seed, pts.shape[0], csa_ref, ref_how, min_csa,
        int(ks[min_idx]), stenosis_pct if stenosis_pct is not None else float("nan"),
        grade, t_body - t0, t_grow - t_body, t_center - t_grow,
        t_sections - t_center, took_ms / 1000.0,
    )

    result = {
        "centerline_lps": [[float(v) for v in p] for p in lps],
        "arclength_mm": [float(v) for v in arclen],
        "csa_mm2": [float(v) for v in csa],
        "eq_diameter_mm": [float(v) for v in eq_diam],
        "min_diameter_mm": [float(v) for v in dmin],
        "max_diameter_mm": [float(v) for v in dmax],
        "sample_k": [int(v) for v in ks],
        "csa_ref_mm2": float(csa_ref),
        "reference": mode,
        "ref_range_k": ref_used,
        "ref_method": ref_how,
        "capped_at_glottis": bool(capped),
        "min_csa_mm2": min_csa,
        "min_csa_index": min_idx,
        "min_csa_lps": [float(v) for v in lps[min_idx]],
        "stenosis_pct": stenosis_pct,
        "stenosis_length_mm": float(length),
        "distance_from_glottis_mm": from_glottis,
        "myer_cotton_grade": grade,
        "took_ms": float(took_ms),
    }
    return mask, result
