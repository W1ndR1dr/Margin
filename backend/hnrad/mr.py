"""Modality-aware series metadata: MR sequence classification and windowing.

Two jobs live here, both of which the CT-only v0.1 backend did not need.

1. **Sequence classification.**  A DICOM MR series carries no single tag that
   says "this is a fat-saturated post-contrast T1".  :func:`classify_sequence`
   derives that from the acquisition parameters (``ScanningSequence``,
   ``EchoTime``, ``RepetitionTime``, ``InversionTime``) *and* the
   ``SeriesDescription``, with the description winning whenever it is explicit,
   because a radiographer's protocol name is more reliable than a TE threshold.
   The full rule set is documented on the function and mirrored one-for-one by
   ``backend/tests/test_mr.py``.

2. **Windowing.**  CT pixel values are Hounsfield units, so a fixed
   width/level (W350/L40 for the neck) is meaningful on every CT ever made.
   MR values are arbitrary scanner units -- a fixed window is meaningless and
   renders most T1 series as a black square.  :func:`window_for_array`
   therefore falls back to a robust 1st-99th percentile window over the
   non-zero voxels.

Neither function ever raises on odd input; an unknown series comes back as
``OTHER`` with a ``None`` plane rather than an exception, because indexing a
library must not stop at one strange file.
"""

from __future__ import annotations

import logging
import math
import re
from typing import Any, Optional, Sequence

import numpy as np

log = logging.getLogger("hnrad.mr")

__all__ = [
    "SEQUENCE_KINDS",
    "PLANES",
    "HU_MODALITIES",
    "THICK_SLICE_MM",
    "CT_WINDOW_WIDTH",
    "CT_WINDOW_CENTER",
    "is_hu_modality",
    "classify_sequence",
    "acquired_plane",
    "is_thick",
    "series_metadata",
    "window_for_array",
    "ct_window",
    "strided_sample",
]

SEQUENCE_KINDS = (
    "T1", "T1C", "T1C_FS", "T2", "T2_FS", "STIR", "FLAIR",
    "DWI", "ADC", "SWI", "MRA", "PD", "LOCALIZER", "OTHER",
)

PLANES = ("AX", "COR", "SAG", "OBL")

# Modalities whose stored values are Hounsfield units, i.e. whose window may be
# a fixed width/level.  Everything else (MR, PT, NM, US, XA, ...) gets a
# percentile window computed from the pixels themselves.
HU_MODALITIES = frozenset({"CT"})

# Through-plane spacing above which a series is "thick" -- too coarse for a
# diagnostic reformat, which is what the flag is for.
THICK_SLICE_MM = 2.5

CT_WINDOW_WIDTH = 350.0
CT_WINDOW_CENTER = 40.0

# The dominant direction cosine a slice normal needs before the series counts
# as a named plane rather than oblique.  0.9 == within 25.8 degrees of an axis.
PLANE_COS_MIN = 0.9


def is_hu_modality(modality: Optional[str]) -> bool:
    """True when a series' stored values are Hounsfield units.

    ``None`` counts as HU: an unlabelled series in this library is a CT, and
    the v0.1 behaviour (fixed W350/L40) is the safer default for one.
    """
    if modality is None:
        return True
    return str(modality).strip().upper() in HU_MODALITIES


# --------------------------------------------------------------------------
# small parsing helpers -- every one tolerates junk
# --------------------------------------------------------------------------

def _text(value: Any) -> str:
    """Lower-cased, whitespace-collapsed text for keyword matching."""
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        value = " ".join(str(v) for v in value)
    return re.sub(r"\s+", " ", str(value)).strip().lower()


def _num(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
        if value is None:
            return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(out) or math.isinf(out):
        return None
    return out


def _has(text: str, *patterns: str) -> bool:
    """True when any regular expression in *patterns* matches *text*."""
    return any(re.search(p, text) for p in patterns)


def _tokens(value: str) -> list[str]:
    """Split a multi-valued DICOM string (``SE\\IR``) into lower-case tokens."""
    return [t for t in re.split(r"[\\\s/,]+", value) if t]


# --------------------------------------------------------------------------
# sequence classification -- the keyword groups, in one readable place
# --------------------------------------------------------------------------

_RE_LOCALIZER = (r"\blocali[sz]er\b", r"\bscout\b", r"\bsurvey\b",
                 r"\b3.?plane\b", r"\bplane.?loc\b", r"\bloc\b")
_RE_ADC = (r"\badc\b", r"\beadc\b", r"apparent.?diffusion")
_RE_DWI = (r"\bdwi\b", r"\bdti\b", r"diffusion", r"\bresolve\b", r"\btrace\b",
           r"\bb\s?\d{3,4}\b", r"\bep2d.?diff")
_RE_SWI = (r"\bswi\b", r"\bswan\b", r"susceptibilit", r"veno.?bold")
_RE_MRA = (r"\bmra\b", r"\bmrv\b", r"\btof\b", r"time.?of.?flight", r"\bangio")
_RE_FLAIR = (r"\bflair\b", r"\bt2.?fl\b", r"dark.?fluid")
_RE_STIR = (r"\bstir\b", r"short.?tau")
_RE_PD = (r"\bpd\b", r"\bpdw\b", r"proton.?densit")
_RE_T1 = (r"\bt1\b", r"\bt1w\b", r"\bmprage\b", r"\bbravo\b", r"\bspgr\b",
          r"\bflash\b", r"\bvibe\b", r"\bthrive\b", r"\blava\b", r"\bfspgr\b",
          r"\btfe\b")
_RE_T2 = (r"\bt2\b", r"\bt2w\b", r"\bhaste\b", r"\bciss\b", r"\bfiesta\b",
          r"\bdrive\b", r"\bspace\b", r"\bcube\b")
# Fat saturation / suppression.
_RE_FS = (r"\bfs\b", r"fat.?sat", r"fat.?supp", r"\bspair\b", r"\bspir\b",
          r"\bdixon\b", r"\bfatsat\b", r"\bfsat\b", r"\bchess\b",
          r"\bideal\b", r"\bmdixon\b")
# Post-contrast.
_RE_POST = (r"\bpost\b", r"post.?contrast", r"postcon", r"\+\s?c\b", r"\bc\s?\+",
            r"\bgad", r"\bgd\b", r"\bce\b", r"contrast.?enhanc", r"\bkm\b",
            r"\bw/?c\b")
_RE_PRE = (r"\bpre\b", r"pre.?contrast", r"non.?contrast", r"\bnativ")


def _fat_saturated(desc: str, scan_options: str, image_type: str) -> bool:
    return (_has(desc, *_RE_FS)
            or _has(scan_options, r"\bfs\b", r"\bsat\b", r"fat")
            or _has(image_type, r"\bfs\b", r"fat.?sat"))


def _post_contrast(desc: str, contrast_agent: Optional[str]) -> bool:
    if contrast_agent is not None and _text(contrast_agent) not in (
        "", "none", "no", "0", "n"
    ):
        return True
    if _has(desc, *_RE_PRE) and not _has(desc, r"\bpost\b"):
        return False
    return _has(desc, *_RE_POST)


def classify_sequence(meta: dict[str, Any]) -> str:
    """Return one of :data:`SEQUENCE_KINDS` for an MR series.

    *meta* is a dict with any of the keys ``description``, ``image_type``,
    ``scan_options``, ``scanning_sequence``, ``sequence_variant``,
    ``echo_time``, ``repetition_time``, ``inversion_time``, ``flip_angle`` and
    ``contrast_agent``.  Missing keys are unknown rather than an error.

    The rule set, in order; the first rule that fires wins.

    1.  ``ImageType`` contains LOCALIZER, or the description says localizer /
        scout / survey / 3-plane / loc            -> ``LOCALIZER``
    2.  description says ADC / eADC / apparent diffusion -> ``ADC``
        (before DWI, because "DWI ADC map" is both)
    3.  description says DWI / DTI / diffusion / trace / resolve / b<number>,
        or ``ScanningSequence`` contains ``EP`` and the description does not
        name a non-diffusion echo-planar use     -> ``DWI``
    4.  description says SWI / SWAN / susceptibility / venoBOLD -> ``SWI``
    5.  description says MRA / MRV / TOF / time-of-flight / angio -> ``MRA``
    6.  description says FLAIR / dark-fluid, or ``IR`` with ``TI > 1400 ms``
        and ``TE >= 60 ms``                      -> ``FLAIR``
    7.  description says STIR / short-tau, or ``IR`` with
        ``80 <= TI <= 400 ms``                   -> ``STIR``
    8.  base weighting, from the description when it names T1 / T2 / PD,
        otherwise from TE and TR:

        * ``TE < 30`` and ``TR < 900``    -> T1
        * ``TE < 30`` and ``TR >= 1500``  -> PD
        * ``TE >= 60``                    -> T2
        * a short-TR spoiled gradient echo with a large flip angle -> T1

    9.  a T1 whose ``ContrastBolusAgent`` is set, or whose description says
        post / +C / Gd / gad / CE, becomes ``T1C``; with fat saturation,
        ``T1C_FS``
    10. a T2 with fat saturation becomes ``T2_FS``
    11. nothing matched                          -> ``OTHER``

    Fat saturation is read from the description (fs, fatsat, fat sat, SPAIR,
    SPIR, Dixon, CHESS, IDEAL), from ``ScanOptions`` and from ``ImageType``.
    ``pre`` / ``non-contrast`` in the description vetoes contrast detection
    from the description, but never a populated ``ContrastBolusAgent``.
    """
    desc = _text(meta.get("description"))
    image_type = _text(meta.get("image_type"))
    scan_options = _text(meta.get("scan_options"))
    scanning_sequence = _tokens(_text(meta.get("scanning_sequence")))
    sequence_variant = _text(meta.get("sequence_variant"))

    te = _num(meta.get("echo_time"))
    tr = _num(meta.get("repetition_time"))
    ti = _num(meta.get("inversion_time"))
    flip = _num(meta.get("flip_angle"))
    agent = meta.get("contrast_agent")

    # 1 -- localizer
    if _has(image_type, r"locali[sz]er") or _has(desc, *_RE_LOCALIZER):
        return "LOCALIZER"

    # 2 -- ADC before DWI
    if _has(desc, *_RE_ADC):
        return "ADC"

    # 3 -- diffusion
    if _has(desc, *_RE_DWI):
        return "DWI"
    if "ep" in scanning_sequence and not _has(
        desc, *_RE_MRA, *_RE_SWI, r"perfusion", r"\bbold\b", r"\bfmri\b",
        r"\bdsc\b", r"\bdce\b",
    ):
        return "DWI"

    # 4 -- susceptibility
    if _has(desc, *_RE_SWI):
        return "SWI"

    # 5 -- angiography
    if _has(desc, *_RE_MRA):
        return "MRA"

    ir = "ir" in scanning_sequence

    # 6 -- FLAIR
    if _has(desc, *_RE_FLAIR):
        return "FLAIR"
    if ir and ti is not None and ti > 1400.0 and (te is None or te >= 60.0):
        return "FLAIR"

    # 7 -- STIR
    if _has(desc, *_RE_STIR):
        return "STIR"
    if ir and ti is not None and 80.0 <= ti <= 400.0:
        return "STIR"

    fs = _fat_saturated(desc, scan_options, image_type)
    post = _post_contrast(desc, agent)

    # 8 -- base weighting
    base: Optional[str] = None
    if _has(desc, *_RE_PD):
        base = "PD"
    elif _has(desc, *_RE_T1):
        base = "T1"
    elif _has(desc, *_RE_T2):
        base = "T2"
    else:
        if te is not None and tr is not None:
            if te < 30.0 and tr < 900.0:
                base = "T1"
            elif te < 30.0 and tr >= 1500.0:
                base = "PD"
            elif te >= 60.0:
                base = "T2"
        elif te is not None and te >= 60.0:
            base = "T2"
        # A spoiled gradient echo with a short TR and a large flip angle is T1.
        if base is None and "gr" in scanning_sequence:
            spoiled = _has(sequence_variant, r"\bsp\b", r"\bss\b", r"\bmp\b")
            if tr is not None and tr < 100.0 and (
                (flip is not None and flip >= 10.0) or spoiled
            ):
                base = "T1"

    # 9 / 10 -- modifiers
    if base == "T1":
        if post:
            return "T1C_FS" if fs else "T1C"
        return "T1"
    if base == "T2":
        return "T2_FS" if fs else "T2"
    if base == "PD":
        return "PD"

    # 11
    return "OTHER"


# --------------------------------------------------------------------------
# geometry-derived fields
# --------------------------------------------------------------------------

def acquired_plane(iop: Optional[Sequence[float]]) -> Optional[str]:
    """``AX`` / ``COR`` / ``SAG`` / ``OBL`` from ImageOrientationPatient.

    The slice normal is ``rowDir x colDir`` in LPS, so its dominant component
    names the plane: ``z`` (superior) is axial, ``y`` (posterior) coronal and
    ``x`` (left) sagittal.  A normal whose largest direction cosine is below
    :data:`PLANE_COS_MIN` (0.9, i.e. more than ~26 degrees off every axis) is
    reported as ``OBL``.  ``None`` when the orientation is missing or
    degenerate.
    """
    if iop is None:
        return None
    try:
        vals = [float(v) for v in iop]
    except (TypeError, ValueError):
        return None
    if len(vals) != 6:
        return None
    r = np.asarray(vals[0:3], dtype=np.float64)
    c = np.asarray(vals[3:6], dtype=np.float64)
    n = np.cross(r, c)
    mag = float(np.linalg.norm(n))
    if mag < 1e-9:
        return None
    n = n / mag
    axis = int(np.argmax(np.abs(n)))
    if abs(float(n[axis])) < PLANE_COS_MIN:
        return "OBL"
    return ("SAG", "COR", "AX")[axis]


def is_thick(
    spacing_between_slices: Optional[float],
    slice_thickness: Optional[float] = None,
) -> Optional[bool]:
    """True when the through-plane spacing exceeds :data:`THICK_SLICE_MM`.

    ``SpacingBetweenSlices`` wins when it is present, because it is the real
    sample interval; ``SliceThickness`` is the fallback.  ``None`` when neither
    is known.
    """
    for value in (spacing_between_slices, slice_thickness):
        v = _num(value)
        if v is not None and v > 0.0:
            return bool(v > THICK_SLICE_MM)
    return None


# --------------------------------------------------------------------------
# extraction from a pydicom dataset
# --------------------------------------------------------------------------

def _join(value: Any) -> Optional[str]:
    """Flatten a possibly multi-valued DICOM element to a backslash string."""
    if value is None:
        return None
    if isinstance(value, (list, tuple)) or (
        hasattr(value, "__iter__") and not isinstance(value, (str, bytes))
    ):
        text = "\\".join(str(v) for v in value)
    else:
        text = str(value)
    text = text.strip()
    return text or None


def series_metadata(ds: Any, iop: Optional[Sequence[float]] = None) -> dict[str, Any]:
    """Modality-specific series columns for one header-read DICOM dataset.

    Returns a dict whose keys are exactly the additive ``series`` columns the
    v0.4 migration in :mod:`hnrad.db` adds.  Every value may be ``None``.
    """
    def g(name: str) -> Any:
        return getattr(ds, name, None)

    modality = _text(g("Modality")).upper() or None

    raw = {
        "description": g("SeriesDescription"),
        "image_type": g("ImageType"),
        "scan_options": g("ScanOptions"),
        "scanning_sequence": g("ScanningSequence"),
        "sequence_variant": g("SequenceVariant"),
        "echo_time": g("EchoTime"),
        "repetition_time": g("RepetitionTime"),
        "inversion_time": g("InversionTime"),
        "flip_angle": g("FlipAngle"),
        "contrast_agent": g("ContrastBolusAgent"),
    }

    agent = _join(raw["contrast_agent"])
    has_contrast: Optional[bool] = None
    if modality in ("MR", "CT"):
        has_contrast = _post_contrast(_text(raw["description"]), agent)

    return {
        "scanning_sequence": _join(raw["scanning_sequence"]),
        "sequence_variant": _join(raw["sequence_variant"]),
        "scan_options": _join(raw["scan_options"]),
        "image_type": _join(raw["image_type"]),
        "echo_time": _num(raw["echo_time"]),
        "repetition_time": _num(raw["repetition_time"]),
        "inversion_time": _num(raw["inversion_time"]),
        "flip_angle": _num(raw["flip_angle"]),
        "magnetic_field_strength": _num(g("MagneticFieldStrength")),
        "contrast_agent": agent,
        # sequence_kind is an MR concept; leaving it NULL on CT/PT keeps the
        # column honest rather than filling it with OTHER for every CT.
        "has_contrast": has_contrast,
        "kernel": _join(g("ConvolutionKernel")),
        "sequence_kind": classify_sequence(raw) if modality == "MR" else None,
        "acquired_plane": acquired_plane(iop),
        "is_thick": is_thick(_num(g("SpacingBetweenSlices")),
                             _num(g("SliceThickness"))),
    }


# --------------------------------------------------------------------------
# windowing
# --------------------------------------------------------------------------

def ct_window() -> dict[str, Any]:
    """The fixed soft-tissue neck window, as a window dict."""
    return {
        "lower": CT_WINDOW_CENTER - CT_WINDOW_WIDTH / 2.0,
        "upper": CT_WINDOW_CENTER + CT_WINDOW_WIDTH / 2.0,
        "method": "ct-fixed-w350-l40",
    }


def strided_sample(arr: np.ndarray, max_voxels: int = 2_000_000) -> np.ndarray:
    """A strided view of *arr* holding at most *max_voxels* samples.

    Striding beats random sampling here: it is O(1), it keeps the spatial
    spread of the volume, and percentiles over a regular lattice of a smooth
    image are within a fraction of a percent of the full-volume values.
    """
    a = np.asarray(arr)
    if a.size <= max_voxels or a.size == 0:
        return a
    ratio = a.size / float(max_voxels)
    step = max(1, int(math.ceil(ratio ** (1.0 / max(1, a.ndim)))))
    out = a[tuple(slice(None, None, step) for _ in range(a.ndim))]
    while out.size > max_voxels and step < max(a.shape):
        step += 1
        out = a[tuple(slice(None, None, step) for _ in range(a.ndim))]
    return out


def window_for_array(
    arr: np.ndarray,
    modality: Optional[str] = None,
    lo_pct: float = 1.0,
    hi_pct: float = 99.0,
    max_voxels: int = 2_000_000,
) -> dict[str, Any]:
    """The display window for *arr*, chosen by modality.

    CT (and anything else whose values are Hounsfield units) keeps the fixed
    W350/L40 soft-tissue neck window.  Everything else -- MR, PT, and any
    series without a rescale to HU -- gets the 1st-99th percentile of its
    **non-zero** voxels, which is what makes an MR T1 of the neck readable:
    the air around the patient is exactly zero on most reconstructions and
    would otherwise drag the lower percentile onto the background.

    Falls back to min/max, and finally to a unit window, when the percentile
    range collapses (a uniform or empty image).
    """
    if is_hu_modality(modality):
        return ct_window()

    sample = strided_sample(np.asarray(arr), max_voxels=max_voxels)
    flat = np.asarray(sample, dtype=np.float32).reshape(-1)
    flat = flat[np.isfinite(flat)]
    method = "percentile-{a:g}-{b:g}-nonzero".format(a=lo_pct, b=hi_pct)

    if flat.size:
        nz = flat[flat != 0]
        # Only trust the non-zero restriction when it keeps a real sample.
        if nz.size >= max(16, flat.size // 1000):
            flat = nz
        else:
            method = "percentile-{a:g}-{b:g}".format(a=lo_pct, b=hi_pct)

    if flat.size == 0:
        return {"lower": 0.0, "upper": 1.0, "method": "empty"}

    lower = float(np.percentile(flat, lo_pct))
    upper = float(np.percentile(flat, hi_pct))
    if not (upper > lower):
        lower = float(flat.min())
        upper = float(flat.max())
        method = "min-max"
    if not (upper > lower):
        upper = lower + 1.0
        method = "degenerate"
    return {"lower": lower, "upper": upper, "method": method}


# How many slices GET /api/series/{uid}/window reads off disk.  Enough to span
# a neck study from skull base to clavicles; few enough to answer in well under
# a second on a 200-slice CT without evicting the two-series volume cache.
WINDOW_SLICE_SAMPLES = 16


def volume_window(
    series_uid: str,
    rows: Any,
    modality: Optional[str] = None,
    n_slices: int = WINDOW_SLICE_SAMPLES,
    max_voxels: int = 2_000_000,
) -> dict[str, Any]:
    """The auto window for a whole series, from a strided slice sample.

    *rows* are instance rows as :func:`hnrad.db.get_series_instances` returns
    them.  Up to *n_slices* evenly spaced slices are read off disk (never the
    whole series: a 1024x1024x200 CT is 800 MB of float32 and the point of this
    route is that the frontend can call it the moment a series is opened), then
    pixel-strided down to *max_voxels* before the percentiles are taken.

    CT short-circuits to the fixed W350/L40 window without reading anything.
    """
    if is_hu_modality(modality):
        out = ct_window()
        out["n_slices_sampled"] = 0
        return out

    from .analysis import load_instance_hu, sorted_instances

    ordered = [r for r, _pos in sorted_instances(list(rows))]
    if not ordered:
        out = {"lower": 0.0, "upper": 1.0, "method": "empty"}
        out["n_slices_sampled"] = 0
        return out

    n = len(ordered)
    take = min(int(max(1, n_slices)), n)
    idx = sorted({int(round(i * (n - 1) / max(1, take - 1))) for i in range(take)}) \
        if take > 1 else [n // 2]

    per_slice = max(1, max_voxels // max(1, len(idx)))
    chunks: list[np.ndarray] = []
    for i in idx:
        try:
            arr, _r, _c = load_instance_hu(ordered[i])
        except Exception as exc:                      # unreadable slice: skip
            log.debug("window: skipping slice %d of %s: %s", i, series_uid, exc)
            continue
        if arr.ndim == 3:
            arr = arr[arr.shape[0] // 2]
        chunks.append(strided_sample(arr, max_voxels=per_slice).reshape(-1))

    if not chunks:
        out = {"lower": 0.0, "upper": 1.0, "method": "empty"}
        out["n_slices_sampled"] = 0
        return out

    out = window_for_array(np.concatenate(chunks), modality, max_voxels=max_voxels)
    out["n_slices_sampled"] = len(chunks)
    return out
