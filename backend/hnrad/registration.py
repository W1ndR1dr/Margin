"""Rigid / affine / B-spline registration between two series.

Engine
------
`itk-elastix <https://github.com/InsightSoftwareConsortium/ITKElastix>`_
(Apache-2.0, ``itk_elastix-0.25.4-cp311-abi3-win_amd64.whl``, verified on this
box's CPython 3.13).  Mutual information, multi-resolution, CPU only, no GPU
and no compiler.  If ``itk`` cannot be imported the module falls back to
SimpleITK's :class:`ImageRegistrationMethod` with the Mattes MI metric, which
covers ``rigid`` and ``affine`` but not ``bspline``; :data:`ENGINE` says which
one is live and every registration records the engine it used.

Frames
------
Everything in here works in **patient LPS millimetres**, not in the index-space
"local frame" :mod:`hnrad.segmentation` uses, because the entire point is to
relate two series whose grids are different.  A :class:`~hnrad.analysis.
SeriesVolume` becomes a SimpleITK image with its true origin, spacing and
direction cosines; the direction matrix is orthonormalised (``slice_dir`` is
replaced by ``+/- rowDir x colDir``) because SimpleITK requires an orthonormal
direction and a series' last-minus-first IPP is only approximately one.

``transform_4x4`` maps **fixed LPS -> moving LPS**.  That is elastix's own
convention and the one every resampler wants: to pull the moving image onto
the fixed grid you evaluate, for each fixed voxel centre ``p``, the moving
image at ``T(p)``.  The inverse (moving -> fixed) is used only by
``transform_points`` with ``direction='moving_to_fixed'``.

Initialisation
--------------
The two frames of reference can be hundreds of millimetres apart -- HaN-Seg's
CT and MR volumes are an example, their z origins differ by up to 1.1 m -- so
elastix's own ``AutomaticTransformInitialization`` (geometric centre) is turned
off and replaced by two stages that both reduce to a *translation*:

1. the moving image is pre-shifted so that its **body** centroid meets the
   fixed body centroid (the body, never the metric mask: a CT bone centroid and
   an MR body centroid are not the same anatomical point), and
2. a translation-only elastix run refines that.

Both are folded into the moving image's origin and summed back into the
reported transform, so the composition is a plain vector sum and never depends
on how elastix chains parameter maps internally -- and a caller never sees
either shift.  Without stage 2 a CT/MR pair whose scans cover different anatomy
(a head-only MR against a skull-base-to-clavicle CT) lands tens of millimetres
out and the rigid stage walks away from it.

The fixed metric mask is additionally confined to the part of the fixed image
the pre-aligned moving image can reach, dilated by 30 mm.  Without that, most
metric samples fall outside the moving buffer and elastix aborts.

Persistence
-----------
``%LOCALAPPDATA%\\HNRad\\registrations\\<fixed>_<moving>.json`` (the result) and
``...txt`` (the elastix parameter maps, exactly as elastix would write them),
plus ``<fixed>_<moving>.<mode>.json`` / ``.txt`` so that a rigid and an affine
registration of the same pair coexist rather than overwrite each other.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Sequence

import numpy as np

from . import config
from .analysis import SeriesVolume

log = logging.getLogger("hnrad.registration")

__all__ = [
    "MODES",
    "MASK_KINDS",
    "ENGINE",
    "RegistrationError",
    "Registration",
    "REGISTRATIONS",
    "registrations_root",
    "engine_name",
    "register",
    "get",
    "resample_moving",
    "resample_label",
    "transform_points",
    "patient_image",
    "normalized_mutual_information",
    "dice",
    "clear_caches",
]

MODES = ("rigid", "affine", "bspline")
MASK_KINDS = ("bone", "body")

#: Bone threshold for a CT mask and for the bone-restricted MSD quality term.
BONE_HU = 200.0
#: Body threshold for a CT mask.
BODY_HU = -500.0

#: Default isotropic resampling before registration, in millimetres.  2 mm is
#: the RESEARCH.md recommendation: it keeps a neck pair under a minute on CPU
#: and costs nothing on a rigid fit, whose accuracy is set by the whole-volume
#: bone signal rather than by the voxel size.
DEFAULT_RESAMPLE_MM = 2.0

#: How many resampled moving volumes stay in RAM for the moving-slice preview.
RESAMPLE_CACHE_SIZE = 2


class RegistrationError(ValueError):
    """Bad input or an unusable registration (maps to HTTP 400)."""


# --------------------------------------------------------------------------
# engine detection
# --------------------------------------------------------------------------

_engine: Optional[str] = None
_engine_lock = threading.Lock()


def engine_name() -> str:
    """``'itk-elastix'`` when itk is importable, else ``'simpleitk'``."""
    global _engine
    with _engine_lock:
        if _engine is not None:
            return _engine
    name = "simpleitk"
    try:
        import itk  # noqa: F401

        if hasattr(itk, "elastix_registration_method"):
            name = "itk-elastix"
    except Exception as exc:                          # pragma: no cover
        log.warning("itk-elastix unavailable (%s); falling back to SimpleITK", exc)
    with _engine_lock:
        _engine = name
    return name


#: Resolved lazily -- importing itk costs ~18 s, which must not happen at
#: FastAPI start-up or at test collection.
ENGINE = "lazy"


# --------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------

def registrations_root() -> Path:
    """``%LOCALAPPDATA%\\HNRad\\registrations``, created on demand."""
    root = config.data_root() / "registrations"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _short(uid: str, n: int = 40) -> str:
    """A filesystem-safe, length-capped form of a UID."""
    clean = re.sub(r"[^0-9A-Za-z._-]", "_", str(uid))
    if len(clean) <= n:
        return clean
    return clean[: n - 9] + "_" + hashlib.sha1(
        str(uid).encode("utf-8")).hexdigest()[:8]


def _stem(fixed: str, moving: str) -> str:
    return "{f}_{m}".format(f=_short(fixed), m=_short(moving))


def make_registration_id(
    fixed: str, moving: str, mode: str, mask: Optional[str], resample_mm: float
) -> str:
    """Deterministic id, so the same request is recognised as cached."""
    key = "|".join([str(fixed), str(moving), str(mode), str(mask or "none"),
                    "{v:.4f}".format(v=float(resample_mm))])
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


@dataclass
class Registration:
    registration_id: str
    fixed_series_uid: str
    moving_series_uid: str
    mode: str
    mask: Optional[str]
    resample_mm: float
    engine: str
    transform_4x4: Optional[list[list[float]]]
    quality: dict[str, Any]
    took_ms: float
    created_at: float
    json_path: Optional[str] = None
    param_path: Optional[str] = None
    pre_shift_lps: Optional[list[float]] = None
    #: elastix ParameterObject; runtime only, never serialised.
    param_object: Any = field(default=None, repr=False, compare=False)

    def public(self) -> dict[str, Any]:
        return {
            "registration_id": self.registration_id,
            "fixed_series_uid": self.fixed_series_uid,
            "moving_series_uid": self.moving_series_uid,
            "mode": self.mode,
            "mask": self.mask,
            "resample_mm": self.resample_mm,
            "engine": self.engine,
            "transform_4x4": self.transform_4x4,
            "quality": self.quality,
            "took_ms": round(float(self.took_ms), 1),
            "created_at": self.created_at,
            "parameter_file": self.param_path,
            "result_file": self.json_path,
        }

    def to_json(self) -> dict[str, Any]:
        out = self.public()
        out["pre_shift_lps"] = self.pre_shift_lps
        return out


REGISTRATIONS: "OrderedDict[str, Registration]" = OrderedDict()
_reg_lock = threading.Lock()

_resample_cache: "OrderedDict[str, tuple[np.ndarray, str]]" = OrderedDict()
_resample_lock = threading.Lock()


def clear_caches() -> None:
    """Drop the in-memory registration and resample caches (tests)."""
    with _reg_lock:
        REGISTRATIONS.clear()
    with _resample_lock:
        _resample_cache.clear()


def get(registration_id: str) -> Optional[Registration]:
    """A registration by id: memory first, then the registrations folder."""
    with _reg_lock:
        hit = REGISTRATIONS.get(registration_id)
    if hit is not None:
        return hit
    root = registrations_root()
    for path in sorted(root.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if data.get("registration_id") != registration_id:
            continue
        reg = Registration(
            registration_id=data["registration_id"],
            fixed_series_uid=data["fixed_series_uid"],
            moving_series_uid=data["moving_series_uid"],
            mode=data.get("mode", "rigid"),
            mask=data.get("mask"),
            resample_mm=float(data.get("resample_mm", DEFAULT_RESAMPLE_MM)),
            engine=data.get("engine", "unknown"),
            transform_4x4=data.get("transform_4x4"),
            quality=data.get("quality", {}),
            took_ms=float(data.get("took_ms", 0.0)),
            created_at=float(data.get("created_at", 0.0)),
            json_path=str(path),
            param_path=data.get("parameter_file"),
            pre_shift_lps=data.get("pre_shift_lps"),
        )
        with _reg_lock:
            REGISTRATIONS[reg.registration_id] = reg
        return reg
    return None


def _remember(reg: Registration) -> None:
    with _reg_lock:
        REGISTRATIONS[reg.registration_id] = reg
        REGISTRATIONS.move_to_end(reg.registration_id)
        while len(REGISTRATIONS) > 64:
            REGISTRATIONS.popitem(last=False)


# --------------------------------------------------------------------------
# SimpleITK plumbing, in true patient LPS
# --------------------------------------------------------------------------

def patient_image(vol: SeriesVolume, array: Optional[np.ndarray] = None):
    """A SeriesVolume (or a mask shaped like it) as a SimpleITK image in LPS.

    The direction matrix columns are the LPS directions of the ``+i``, ``+j``
    and ``+k`` index axes.  ``+k`` is taken as ``rowDir x colDir`` with the
    sign of ``slice_dir`` rather than as ``slice_dir`` itself, so the matrix is
    exactly orthonormal -- SimpleITK rejects anything else, and a series' own
    last-minus-first IPP direction is orthonormal only to rounding.
    """
    import SimpleITK as sitk

    data = vol.hu if array is None else array
    img = sitk.GetImageFromArray(np.ascontiguousarray(data))
    dz, dy, dx = vol.spacing
    img.SetSpacing((float(dx), float(dy), float(dz)))
    img.SetOrigin(tuple(float(v) for v in vol.origin))

    row = np.asarray(vol.row_dir, dtype=np.float64)
    col = np.asarray(vol.col_dir, dtype=np.float64)
    row = row / max(float(np.linalg.norm(row)), 1e-12)
    col = col - float(np.dot(col, row)) * row
    col = col / max(float(np.linalg.norm(col)), 1e-12)
    normal = np.cross(row, col)
    if float(np.dot(normal, np.asarray(vol.slice_dir, dtype=np.float64))) < 0:
        normal = -normal
    direction = np.column_stack([row, col, normal])     # columns = i, j, k
    img.SetDirection(tuple(float(v) for v in direction.reshape(-1)))
    return img


def _resample_iso(img, spacing_mm: float, default_value: float, interp=None):
    """Resample *img* onto an isotropic grid of *spacing_mm*, same extent."""
    import SimpleITK as sitk

    if interp is None:
        interp = sitk.sitkLinear
    old_spacing = np.asarray(img.GetSpacing(), dtype=np.float64)
    old_size = np.asarray(img.GetSize(), dtype=np.float64)
    new_spacing = np.full(3, float(spacing_mm), dtype=np.float64)
    new_size = np.maximum(1, np.ceil(old_size * old_spacing / new_spacing)).astype(int)

    rs = sitk.ResampleImageFilter()
    rs.SetOutputSpacing([float(v) for v in new_spacing])
    rs.SetSize([int(v) for v in new_size])
    rs.SetOutputOrigin(img.GetOrigin())
    rs.SetOutputDirection(img.GetDirection())
    rs.SetInterpolator(interp)
    rs.SetDefaultPixelValue(float(default_value))
    rs.SetTransform(sitk.Transform(3, sitk.sitkIdentity))
    return rs.Execute(img)


def _shift_origin(img, shift: np.ndarray):
    """A shallow copy of *img* whose origin has moved by ``-shift``."""
    import SimpleITK as sitk

    out = sitk.Image(img)
    out.SetOrigin(tuple(float(o) - float(s)
                        for o, s in zip(img.GetOrigin(), shift)))
    return out


# --------------------------------------------------------------------------
# masks
# --------------------------------------------------------------------------

def _mask_array(arr: np.ndarray, modality: Optional[str], kind: Optional[str]
                ) -> Optional[np.ndarray]:
    """A uint8 metric mask for *arr*.

    ``bone`` is HU >= 200 on a CT; on an MR, where cortical bone is a signal
    void, "bone" is meaningless, so an MR silently falls back to ``body``.
    ``body`` is HU > -500 on a CT and "above the Otsu threshold" on anything
    else, morphologically cleaned with a slice-wise hole fill so the airway and
    the sinuses count as patient rather than as room air.
    """
    from scipy import ndimage

    if kind is None:
        return None
    if kind not in MASK_KINDS:
        raise RegistrationError(
            "mask must be one of {k} or null".format(k=", ".join(MASK_KINDS)))

    is_ct = str(modality or "CT").upper() == "CT"
    if kind == "bone" and is_ct:
        mask = arr >= np.float32(BONE_HU)
    elif is_ct:
        mask = arr > np.float32(BODY_HU)
    else:
        finite = arr[np.isfinite(arr)]
        if finite.size == 0:
            return None
        # Otsu on a 256-bin histogram of the non-zero voxels.  An image with no
        # positive voxels at all (a moving volume resampled entirely outside its
        # own field of view, say) has no body to find, and must not come back as
        # "everything is body" -- which is what an Otsu threshold below the
        # single occupied bin would give.
        nz = finite[finite > 0]
        if nz.size == 0:
            return None
        sample = nz if nz.size > 64 else finite
        hist, edges = np.histogram(sample, bins=256)
        total = hist.sum()
        if total == 0:
            return None
        w0 = np.cumsum(hist)
        w1 = total - w0
        centres = 0.5 * (edges[:-1] + edges[1:])
        m0 = np.cumsum(hist * centres)
        mt = m0[-1]
        with np.errstate(invalid="ignore", divide="ignore"):
            between = (mt * w0 - m0 * total) ** 2 / (w0.astype(np.float64)
                                                     * w1.astype(np.float64) + 1e-9)
        between[~np.isfinite(between)] = 0.0
        thresh = float(centres[int(np.argmax(between))])
        mask = arr > np.float32(thresh)

    mask = mask.astype(np.uint8, copy=False)
    if not mask.any() or mask.all():
        return None
    if kind == "body" or not is_ct:
        # Largest component, then fill holes slice by slice.
        lab, n = ndimage.label(mask)
        if n > 1:
            sizes = np.bincount(lab.reshape(-1))
            sizes[0] = 0
            mask = (lab == int(np.argmax(sizes))).astype(np.uint8)
        for k in range(mask.shape[0]):
            mask[k] = ndimage.binary_fill_holes(mask[k])
    return mask.astype(np.uint8, copy=False)


def _moving_footprint(fixed_img, moving_img, margin_mm: float = 30.0) -> np.ndarray:
    """Boolean array on the fixed grid: where the moving image reaches.

    Built by resampling a constant-one image shaped like *moving_img* onto the
    fixed grid, then dilating by *margin_mm* so the optimiser still has room to
    move.  Nothing about the two images' orientations is assumed.
    """
    import SimpleITK as sitk
    from scipy import ndimage

    ones = sitk.Image(moving_img.GetSize(), sitk.sitkUInt8)
    ones.CopyInformation(moving_img)
    ones = ones + 1

    rs = sitk.ResampleImageFilter()
    rs.SetReferenceImage(fixed_img)
    rs.SetInterpolator(sitk.sitkNearestNeighbor)
    rs.SetDefaultPixelValue(0)
    rs.SetTransform(sitk.Transform(3, sitk.sitkIdentity))
    foot = sitk.GetArrayFromImage(rs.Execute(ones)) > 0

    spacing = np.asarray(fixed_img.GetSpacing(), dtype=np.float64)[::-1]  # z,y,x
    radius = np.maximum(1, np.round(float(margin_mm) / spacing)).astype(int)
    if foot.any():
        foot = ndimage.binary_dilation(
            foot, structure=np.ones((3, 3, 3), bool),
            iterations=int(max(radius)))
    return foot


def _centroid_lps(img, mask_arr: Optional[np.ndarray], arr: np.ndarray) -> np.ndarray:
    """Centroid of a mask (or of the image's own upper-half intensity) in LPS."""
    if mask_arr is not None and mask_arr.any():
        idx = np.argwhere(mask_arr > 0)
    else:
        finite = arr[np.isfinite(arr)]
        thresh = float(np.percentile(finite, 90.0)) if finite.size else 0.0
        idx = np.argwhere(arr >= thresh)
        if idx.size == 0:
            idx = np.argwhere(np.isfinite(arr))
    if idx.size == 0:
        return np.asarray(img.GetOrigin(), dtype=np.float64)
    # idx columns are (k, j, i); the sitk index order is (i, j, k).
    mean_kji = idx.mean(axis=0)
    index = (float(mean_kji[2]), float(mean_kji[1]), float(mean_kji[0]))
    return np.asarray(
        img.TransformContinuousIndexToPhysicalPoint(index), dtype=np.float64)


# --------------------------------------------------------------------------
# quality metrics
# --------------------------------------------------------------------------

def normalized_mutual_information(
    a: np.ndarray, b: np.ndarray, bins: int = 64,
    valid: Optional[np.ndarray] = None,
) -> float:
    """Studholme normalised MI, ``(H(a) + H(b)) / H(a, b)``.

    1.0 means independent, higher is better aligned.  Computed over *valid*
    voxels only (default: everywhere both inputs are finite), which matters
    when the moving image covers a fraction of the fixed field of view.
    """
    a = np.asarray(a, dtype=np.float32).reshape(-1)
    b = np.asarray(b, dtype=np.float32).reshape(-1)
    ok = np.isfinite(a) & np.isfinite(b)
    if valid is not None:
        ok &= np.asarray(valid, dtype=bool).reshape(-1)
    a, b = a[ok], b[ok]
    if a.size < 64:
        return float("nan")
    hist, _xe, _ye = np.histogram2d(a, b, bins=bins)
    total = hist.sum()
    if total <= 0:
        return float("nan")
    p = hist / total
    px = p.sum(axis=1)
    py = p.sum(axis=0)

    def h(q: np.ndarray) -> float:
        q = q[q > 0]
        return float(-(q * np.log(q)).sum())

    hxy = h(p.reshape(-1))
    if hxy <= 0:
        return float("nan")
    return float((h(px) + h(py)) / hxy)


def dice(a: np.ndarray, b: np.ndarray) -> float:
    """Dice coefficient of two boolean arrays of the same shape."""
    a = np.asarray(a, dtype=bool)
    b = np.asarray(b, dtype=bool)
    denom = int(a.sum()) + int(b.sum())
    if denom == 0:
        return float("nan")
    return float(2.0 * int(np.logical_and(a, b).sum()) / denom)


def _msd(a: np.ndarray, b: np.ndarray, where: np.ndarray) -> float:
    """Mean squared difference over *where*."""
    sel = np.asarray(where, dtype=bool)
    if not sel.any():
        return float("nan")
    d = np.asarray(a, dtype=np.float64)[sel] - np.asarray(b, dtype=np.float64)[sel]
    return float(np.mean(d * d))


# --------------------------------------------------------------------------
# transform extraction
# --------------------------------------------------------------------------

def _affine_from_elastix(parameter_map: Any) -> Optional[tuple[np.ndarray, np.ndarray]]:
    """``(M, b)`` with ``y = M x + b`` from an elastix result parameter map.

    The parameters are handed to ITK's own transform class and the matrix and
    offset are read back out of it, so the Euler-angle convention is ITK's
    rather than a re-derivation of it.  ``None`` for a non-linear transform.
    """
    import itk

    def field(key: str, default: tuple[str, ...] = ()) -> tuple[str, ...]:
        # elastix's parameter map is a SWIG std::map wrapper whose .get() still
        # raises IndexError on a missing key, so ask by subscript and catch.
        try:
            return tuple(parameter_map[key])
        except (IndexError, KeyError):
            return default

    name = str(field("Transform", ("",))[0])
    params = [float(v) for v in field("TransformParameters")]
    centre = [float(v) for v in field("CenterOfRotationPoint",
                                      ("0", "0", "0"))]

    if name in ("EulerTransform", "SimilarityTransform"):
        tx = itk.Euler3DTransform[itk.D].New() if name == "EulerTransform" \
            else itk.Similarity3DTransform[itk.D].New()
    elif name == "AffineTransform":
        tx = itk.AffineTransform[itk.D, 3].New()
    elif name == "TranslationTransform":
        tx = itk.TranslationTransform[itk.D, 3].New()
    else:
        return None

    fixed = tx.GetFixedParameters()
    for i in range(min(fixed.GetSize(), len(centre))):
        fixed.SetElement(i, centre[i])
    tx.SetFixedParameters(fixed)

    p = tx.GetParameters()
    if p.GetSize() != len(params):
        log.warning("elastix %s: %d parameters, ITK wants %d",
                    name, len(params), p.GetSize())
        return None
    for i, v in enumerate(params):
        p.SetElement(i, v)
    tx.SetParameters(p)

    matrix = np.eye(3, dtype=np.float64)
    if hasattr(tx, "GetMatrix"):
        matrix = np.asarray(itk.array_from_matrix(tx.GetMatrix()), dtype=np.float64)
    offset = np.asarray(tx.GetOffset(), dtype=np.float64)
    return matrix, offset


def _as_4x4(matrix: np.ndarray, offset: np.ndarray) -> list[list[float]]:
    out = np.eye(4, dtype=np.float64)
    out[:3, :3] = matrix
    out[:3, 3] = offset
    return [[float(v) for v in row] for row in out]


def _sitk_transform(reg: Registration):
    """A SimpleITK AffineTransform for ``transform_4x4`` (fixed -> moving)."""
    import SimpleITK as sitk

    if reg.transform_4x4 is None:
        raise RegistrationError(
            "registration {i} is {m}: it has no 4x4 transform".format(
                i=reg.registration_id, m=reg.mode))
    m = np.asarray(reg.transform_4x4, dtype=np.float64)
    tx = sitk.AffineTransform(3)
    tx.SetMatrix([float(v) for v in m[:3, :3].reshape(-1)])
    tx.SetTranslation([float(v) for v in m[:3, 3]])
    return tx


# --------------------------------------------------------------------------
# the two engines
# --------------------------------------------------------------------------

def _to_itk(img):
    import SimpleITK as sitk
    import itk

    arr = sitk.GetArrayFromImage(img)
    out = itk.image_from_array(np.ascontiguousarray(arr))
    out.SetSpacing([float(v) for v in img.GetSpacing()])
    out.SetOrigin([float(v) for v in img.GetOrigin()])
    d = np.asarray(img.GetDirection(), dtype=np.float64).reshape(3, 3)
    out.SetDirection(itk.matrix_from_array(d))
    return out


def _parameter_object(mode: str, masked: bool, resolutions: int = 4):
    """One elastix parameter map for *mode*.

    ``masked`` picks the image sampler, and getting that wrong is fatal rather
    than merely slow: the default ``RandomCoordinate`` sampler draws points
    uniformly over the whole fixed image and rejects the ones outside the mask,
    so a bone mask covering ~1.4 % of a neck CT makes it give up with
    "Could not find enough image samples within reasonable time".
    ``RandomSparseMask`` draws from the mask's own voxel list instead.
    """
    import itk

    po = itk.ParameterObject.New()
    # A B-spline is always preceded by a rigid map in the *same* call, so
    # elastix chains them itself and transformix applies the whole chain.  That
    # is the standard two-stage recipe (RESEARCH.md item 11: bone-weighted
    # rigid init, then a constrained B-spline) and it costs nothing here,
    # because a B-spline registration reports no 4x4 for us to compose.
    names = ["rigid", "bspline"] if mode == "bspline" else [mode]
    for name in names:
        _add_map(po, name, masked, resolutions)
    return po


def _add_map(po, name: str, masked: bool, resolutions: int) -> None:
    pm = po.GetDefaultParameterMap(name, resolutions)
    pm["Metric"] = ["AdvancedMattesMutualInformation"]
    pm["NumberOfHistogramBins"] = ["32"]
    # We pre-align by mask centroid, so elastix must not re-initialise.
    pm["AutomaticTransformInitialization"] = ["false"]
    pm["MaximumNumberOfIterations"] = ["512" if name != "bspline" else "256"]
    pm["NumberOfSpatialSamples"] = ["4096"]
    pm["ImageSampler"] = ["RandomSparseMask" if masked else "RandomCoordinate"]
    pm["MaximumNumberOfSamplingAttempts"] = ["16"]
    # A sample drawn inside the fixed mask can still fall outside the *moving*
    # image, and elastix aborts with "Too many samples map outside moving image
    # buffer" once fewer than this fraction survive.  The default 0.25 is right
    # for two scans of the same extent and wrong for a head-only MR against a
    # skull-base-to-clavicle CT, where a quarter of the fixed body is simply not
    # imaged by the moving series.
    pm["RequiredRatioOfValidSamples"] = ["0.05"]
    pm["NewSamplesEveryIteration"] = ["true"]
    pm["ErodeMask"] = ["false"]
    pm["ResultImagePixelType"] = ["float"]
    pm["DefaultPixelValue"] = ["0"]
    po.AddParameterMap(pm)


def _elastix_call(fixed, moving, fixed_mask, moving_mask, mode: str):
    """One elastix run; returns ``((M, b) | None, parameter_object, result)``."""
    import itk

    po = _parameter_object(mode, masked=fixed_mask is not None)
    kwargs: dict[str, Any] = {"parameter_object": po, "log_to_console": False}
    if fixed_mask is not None:
        kwargs["fixed_mask"] = _to_itk_mask(fixed_mask)
    if moving_mask is not None:
        kwargs["moving_mask"] = _to_itk_mask(moving_mask)

    result, result_params = itk.elastix_registration_method(
        _to_itk(fixed), _to_itk(moving), **kwargs)

    last = result_params.GetParameterMap(
        result_params.GetNumberOfParameterMaps() - 1)
    return _affine_from_elastix(last), result_params, result


def _register_elastix(fixed, moving, fixed_mask, moving_mask, mode: str):
    """Translation stage, then the requested stage.

    The translation stage exists because the two series may be in frames of
    reference hundreds of millimetres apart *and* cover different anatomy (a
    head-only MR against a skull-base-to-clavicle CT), so the mask-centroid
    pre-alignment leaves a residual of tens of millimetres that a rigid fit
    with rotation in the mix can walk away from.  Its result is folded into the
    moving image's origin -- the same mechanism as the pre-shift -- so the
    composition stays a plain vector sum and never depends on how elastix
    chains parameter maps internally.  Returns
    ``((M, b), parameter_object, extra_shift)``.
    """
    extra = np.zeros(3, dtype=np.float64)
    linear, _params, _img = _elastix_call(
        fixed, moving, fixed_mask, moving_mask, "translation")
    if linear is not None:
        extra = np.asarray(linear[1], dtype=np.float64)
        moving = _shift_origin(moving, extra)
        if moving_mask is not None:
            moving_mask = _shift_origin(moving_mask, extra)

    linear, result_params, result = _elastix_call(
        fixed, moving, fixed_mask, moving_mask, mode)
    return linear, result_params, extra, result


def _to_itk_mask(mask_img):
    import itk
    import SimpleITK as sitk

    out = itk.image_from_array(
        np.ascontiguousarray(sitk.GetArrayFromImage(mask_img)))
    out.SetSpacing([float(v) for v in mask_img.GetSpacing()])
    out.SetOrigin([float(v) for v in mask_img.GetOrigin()])
    out.SetDirection(itk.matrix_from_array(
        np.asarray(mask_img.GetDirection(), dtype=np.float64).reshape(3, 3)))
    return out


def _register_sitk(fixed, moving, fixed_mask, moving_mask, mode: str):
    """SimpleITK fallback: Mattes MI, multi-resolution, rigid or affine."""
    import SimpleITK as sitk

    if mode == "bspline":
        raise RegistrationError(
            "mode 'bspline' needs itk-elastix, which is not installed")

    f = sitk.Cast(fixed, sitk.sitkFloat32)
    m = sitk.Cast(moving, sitk.sitkFloat32)

    if mode == "rigid":
        initial = sitk.Euler3DTransform()
    else:
        initial = sitk.AffineTransform(3)
    initial.SetCenter(f.TransformContinuousIndexToPhysicalPoint(
        [(s - 1) / 2.0 for s in f.GetSize()]))

    reg = sitk.ImageRegistrationMethod()
    reg.SetMetricAsMattesMutualInformation(numberOfHistogramBins=32)
    reg.SetMetricSamplingStrategy(reg.RANDOM)
    reg.SetMetricSamplingPercentage(0.02, seed=1234)
    if fixed_mask is not None:
        reg.SetMetricFixedMask(sitk.Cast(fixed_mask, sitk.sitkUInt8))
    if moving_mask is not None:
        reg.SetMetricMovingMask(sitk.Cast(moving_mask, sitk.sitkUInt8))
    reg.SetInterpolator(sitk.sitkLinear)
    reg.SetOptimizerAsRegularStepGradientDescent(
        learningRate=2.0, minStep=1e-4, numberOfIterations=300,
        gradientMagnitudeTolerance=1e-6)
    reg.SetOptimizerScalesFromPhysicalShift()
    reg.SetShrinkFactorsPerLevel([4, 2, 1])
    reg.SetSmoothingSigmasPerLevel([2.0, 1.0, 0.0])
    reg.SmoothingSigmasAreSpecifiedInPhysicalUnitsOn()
    reg.SetInitialTransform(initial, inPlace=False)

    out = reg.Execute(f, m)
    affine = sitk.AffineTransform(out)
    matrix = np.asarray(affine.GetMatrix(), dtype=np.float64).reshape(3, 3)
    centre = np.asarray(affine.GetCenter(), dtype=np.float64)
    translation = np.asarray(affine.GetTranslation(), dtype=np.float64)
    offset = translation + centre - matrix @ centre
    return (matrix, offset), None


# --------------------------------------------------------------------------
# the public entry point
# --------------------------------------------------------------------------

def _series_volume(series_uid: str) -> tuple[SeriesVolume, Optional[str]]:
    from . import analysis, db

    db.ensure_db()
    with db.connect() as conn:
        row = db.get_series(conn, series_uid)
        if row is None:
            raise RegistrationError("unknown series_uid {u}".format(u=series_uid))
        rows = db.get_series_instances(conn, series_uid)
    if not rows:
        raise RegistrationError(
            "series {u} has no instances".format(u=series_uid))
    return analysis.load_series_volume(series_uid, rows), row.get("modality")


def register(
    fixed_series_uid: str,
    moving_series_uid: str,
    mode: str = "rigid",
    mask: Optional[str] = None,
    resample_mm: float = DEFAULT_RESAMPLE_MM,
    force: bool = False,
    fixed: Optional[tuple[SeriesVolume, Optional[str]]] = None,
    moving: Optional[tuple[SeriesVolume, Optional[str]]] = None,
) -> tuple[Registration, bool]:
    """Register *moving* onto *fixed*.  Returns ``(registration, cached)``.

    *mode* is ``rigid`` (6 dof), ``affine`` (12) or ``bspline`` (a rigid stage
    followed by a free-form deformation).  *mask* restricts the similarity
    metric: ``bone`` (CT bone, or the body on a non-CT image, which has no
    bone signal), ``body``, or ``None`` for the whole field of view.

    Both volumes are resampled to an isotropic *resample_mm* grid first; the
    resulting transform is in millimetres and is independent of that choice.
    """
    started = time.perf_counter()
    mode = str(mode or "rigid").lower()
    if mode not in MODES:
        raise RegistrationError(
            "mode must be one of {m}".format(m=", ".join(MODES)))
    if mask is not None and mask not in MASK_KINDS:
        raise RegistrationError(
            "mask must be one of {k} or null".format(k=", ".join(MASK_KINDS)))
    resample_mm = float(resample_mm)
    if not (0.25 <= resample_mm <= 10.0):
        raise RegistrationError("resample_mm must be between 0.25 and 10")
    if fixed_series_uid == moving_series_uid:
        raise RegistrationError("fixed and moving must be different series")

    reg_id = make_registration_id(
        fixed_series_uid, moving_series_uid, mode, mask, resample_mm)
    if not force:
        hit = get(reg_id)
        if hit is not None:
            return hit, True

    import SimpleITK as sitk

    engine = engine_name()
    fixed_vol, fixed_modality = fixed if fixed is not None else \
        _series_volume(fixed_series_uid)
    moving_vol, moving_modality = moving if moving is not None else \
        _series_volume(moving_series_uid)

    t_load = time.perf_counter()

    f_full = patient_image(fixed_vol)
    m_full = patient_image(moving_vol)
    f_img = _resample_iso(f_full, resample_mm, float(np.min(fixed_vol.hu)))
    m_img = _resample_iso(m_full, resample_mm, float(np.min(moving_vol.hu)))
    f_arr = sitk.GetArrayFromImage(f_img)
    m_arr = sitk.GetArrayFromImage(m_img)

    f_mask_arr = _mask_array(f_arr, fixed_modality, mask)
    m_mask_arr = _mask_array(m_arr, moving_modality, mask)
    # The pre-alignment centroid always comes from the *body*, never from the
    # metric mask: a CT bone centroid and an MR body centroid are not the same
    # anatomical point, and using them against each other biases the start by
    # tens of millimetres.
    f_centroid = _centroid_lps(
        f_img, _mask_array(f_arr, fixed_modality, "body"), f_arr)
    m_centroid = _centroid_lps(
        m_img, _mask_array(m_arr, moving_modality, "body"), m_arr)
    pre_shift = m_centroid - f_centroid

    m_img_shifted = _shift_origin(m_img, pre_shift)

    # Confine the fixed mask to where the (pre-aligned) moving image can reach.
    # Without this, most metric samples land outside the moving buffer and
    # elastix aborts; with it, every sample is informative and the optimiser is
    # faster as well as more accurate.
    if f_mask_arr is not None:
        foot = _moving_footprint(f_img, m_img_shifted)
        confined = (f_mask_arr > 0) & foot
        if confined.sum() >= 1000:
            f_mask_arr = confined.astype(np.uint8)
        else:
            log.warning("registration %s <- %s: the moving field of view meets"
                        " only %d fixed mask voxels; using the whole mask",
                        fixed_series_uid[-16:], moving_series_uid[-16:],
                        int(confined.sum()))
        del foot, confined

    f_mask_img = (patient_mask_image(f_img, f_mask_arr)
                  if f_mask_arr is not None else None)
    m_mask_img = None
    if m_mask_arr is not None:
        m_mask_img = patient_mask_image(m_img_shifted, m_mask_arr)

    t_prep = time.perf_counter()

    warped = None
    if engine == "itk-elastix":
        linear, param_object, extra_shift, result_img = _register_elastix(
            f_img, m_img_shifted, f_mask_img, m_mask_img, mode)
        if linear is None and result_img is not None:
            # A B-spline reports no 4x4, so the only way to score it is the
            # image elastix already produced on the fixed grid.  Its outside-
            # the-moving-image value is 0; treat that as "not covered".
            import itk

            warped = np.asarray(itk.array_from_image(result_img),
                                dtype=np.float32)
            warped = np.where(warped == 0.0, np.float32("nan"), warped)
    else:
        linear, param_object = _register_sitk(
            f_img, m_img_shifted, f_mask_img, m_mask_img, mode)
        extra_shift = np.zeros(3, dtype=np.float64)

    t_reg = time.perf_counter()
    total_shift = np.asarray(pre_shift, dtype=np.float64) + extra_shift

    transform_4x4: Optional[list[list[float]]] = None
    if linear is not None:
        matrix, offset = linear
        # Undo every origin shift: a point q in the shifted moving image is the
        # point q + total_shift in the real moving image.
        transform_4x4 = _as_4x4(matrix, offset + total_shift)

    quality = _quality_report(
        f_img, m_full, f_arr, fixed_modality, moving_modality,
        transform_4x4, mask, warped_after=warped,
    )
    quality["engine"] = engine
    quality["timings_ms"] = {
        "load": round((t_load - started) * 1000.0, 1),
        "prepare": round((t_prep - t_load) * 1000.0, 1),
        "optimise": round((t_reg - t_prep) * 1000.0, 1),
    }

    took_ms = (time.perf_counter() - started) * 1000.0
    reg = Registration(
        registration_id=reg_id,
        fixed_series_uid=fixed_series_uid,
        moving_series_uid=moving_series_uid,
        mode=mode,
        mask=mask,
        resample_mm=resample_mm,
        engine=engine,
        transform_4x4=transform_4x4,
        quality=quality,
        took_ms=took_ms,
        created_at=time.time(),
        pre_shift_lps=[float(v) for v in total_shift],
        param_object=param_object,
    )
    _persist(reg, param_object)
    _remember(reg)
    log.info(
        "register %s <- %s mode=%s mask=%s @%.1fmm engine=%s -> nmi %.4f -> %.4f"
        " in %.1f s",
        fixed_series_uid[-16:], moving_series_uid[-16:], mode, mask, resample_mm,
        engine, quality.get("nmi_before", float("nan")),
        quality.get("nmi_after", float("nan")), took_ms / 1000.0,
    )
    return reg, False


def patient_mask_image(reference, mask_arr: np.ndarray):
    """A uint8 SimpleITK mask sharing *reference*'s geometry."""
    import SimpleITK as sitk

    img = sitk.GetImageFromArray(np.ascontiguousarray(mask_arr.astype(np.uint8)))
    img.CopyInformation(reference)
    return img


def _quality_report(
    f_img, m_full, f_arr: np.ndarray,
    fixed_modality: Optional[str], moving_modality: Optional[str],
    transform_4x4: Optional[list[list[float]]],
    mask: Optional[str],
    warped_after: Optional[np.ndarray] = None,
) -> dict[str, Any]:
    """Before/after similarity on the registration grid.

    ``nmi`` (normalised mutual information) is the headline number and is the
    right one for a CT-MR pair, where intensities are unrelated.  ``msd`` (mean
    squared difference over bone-thresholded fixed voxels) is only meaningful
    when both series are CT, so it is ``NaN`` otherwise.  ``dice_body`` is the
    overlap of the two body masks, which is the one figure a reader can sanity
    check against the pictures.
    """
    import SimpleITK as sitk

    def warp(tx) -> np.ndarray:
        rs = sitk.ResampleImageFilter()
        rs.SetReferenceImage(f_img)
        rs.SetInterpolator(sitk.sitkLinear)
        rs.SetDefaultPixelValue(float("nan"))
        rs.SetTransform(tx)
        return sitk.GetArrayFromImage(rs.Execute(sitk.Cast(m_full, sitk.sitkFloat32)))

    identity = sitk.Transform(3, sitk.sitkIdentity)
    before = warp(identity)

    after = before
    if transform_4x4 is not None:
        m = np.asarray(transform_4x4, dtype=np.float64)
        tx = sitk.AffineTransform(3)
        tx.SetMatrix([float(v) for v in m[:3, :3].reshape(-1)])
        tx.SetTranslation([float(v) for v in m[:3, 3]])
        after = warp(tx)
    elif warped_after is not None and warped_after.shape == before.shape:
        after = warped_after

    out: dict[str, Any] = {
        "metric": "normalized_mutual_information",
        "nmi_before": normalized_mutual_information(f_arr, before),
        "nmi_after": normalized_mutual_information(f_arr, after),
        "overlap_voxels_before": int(np.isfinite(before).sum()),
        "overlap_voxels_after": int(np.isfinite(after).sum()),
    }
    out["final_metric"] = out["nmi_after"]
    # The go/no-go indicator RESEARCH.md asks for.  NMI is 1.0 for statistically
    # independent images, so `nmi_after` near 1.0 -- or a gain near zero -- means
    # the optimiser found nothing, whatever the transform looks like.  On the
    # HaN-Seg CT/MR pairs a good rigid fit scores 1.17-1.21 and a failed one
    # 1.02.  Never present a warp with a low gain as an alignment.
    if np.isfinite(out["nmi_after"]) and np.isfinite(out["nmi_before"]):
        out["nmi_gain"] = out["nmi_after"] - out["nmi_before"]
    else:
        out["nmi_gain"] = float("nan")

    both_ct = (str(fixed_modality or "CT").upper() == "CT"
               and str(moving_modality or "CT").upper() == "CT")
    if both_ct:
        bone = f_arr >= np.float32(BONE_HU)
        out["msd_bone_before"] = _msd(f_arr, np.nan_to_num(before, nan=-1000.0),
                                      bone & np.isfinite(before))
        out["msd_bone_after"] = _msd(f_arr, np.nan_to_num(after, nan=-1000.0),
                                     bone & np.isfinite(after))
    else:
        out["msd_bone_before"] = float("nan")
        out["msd_bone_after"] = float("nan")

    # Dice of the two body outlines, **restricted to the moving field of view**.
    # Without that restriction the number is meaningless for a partial-coverage
    # pair: a head-only MR against a skull-base-to-clavicle CT can never exceed
    # about 0.6 however perfect the alignment, because most of the fixed body is
    # simply not imaged.  Inside the shared field of view, 1.0 is attainable and
    # the number means what a reader expects it to mean.
    f_body = _mask_array(f_arr, fixed_modality, "body")
    out["dice_body_before"] = float("nan")
    out["dice_body_after"] = float("nan")
    if f_body is not None:
        for name, arr in (("before", before), ("after", after)):
            valid = np.isfinite(arr)
            if not valid.any():
                continue
            body = _mask_array(np.where(valid, np.nan_to_num(arr, nan=0.0), 0.0),
                               moving_modality, "body")
            if body is None:
                continue
            out["dice_body_" + name] = dice((f_body > 0) & valid,
                                            (body > 0) & valid)
        out["dice_body_scope"] = "inside the moving field of view"

    return {k: (None if isinstance(v, float) and math.isnan(v) else v)
            for k, v in out.items()}


def _persist(reg: Registration, param_object: Any) -> None:
    """Write the result json and the elastix parameter maps next to it."""
    root = registrations_root()
    stem = _stem(reg.fixed_series_uid, reg.moving_series_uid)

    param_path: Optional[str] = None
    if param_object is not None:
        try:
            text = str(param_object)
            for name in (stem + ".txt", "{s}.{m}.txt".format(s=stem, m=reg.mode)):
                (root / name).write_text(text, encoding="utf-8")
            param_path = str(root / "{s}.{m}.txt".format(s=stem, m=reg.mode))
        except Exception as exc:                       # pragma: no cover
            log.warning("could not serialise elastix parameters: %s", exc)

    reg.param_path = param_path
    reg.json_path = str(root / "{s}.{m}.json".format(s=stem, m=reg.mode))
    payload = json.dumps(reg.to_json(), indent=1)
    for name in (stem + ".json", "{s}.{m}.json".format(s=stem, m=reg.mode)):
        (root / name).write_text(payload, encoding="utf-8")


# --------------------------------------------------------------------------
# applying a registration
# --------------------------------------------------------------------------

def _transformix_resample(reg: Registration, moving_img, reference, nearest: bool):
    """Resample *moving_img* onto *reference*'s grid through elastix's own maps."""
    import itk
    import SimpleITK as sitk

    if reg.param_object is None:
        raise RegistrationError(
            "the B-spline parameter maps for registration {i} are no longer in"
            " memory; re-run POST /api/registration with force=true".format(
                i=reg.registration_id))

    po = reg.param_object
    size = [str(v) for v in reference.GetSize()]
    spacing = ["{v:.10g}".format(v=v) for v in reference.GetSpacing()]
    origin = ["{v:.10g}".format(v=v) for v in reference.GetOrigin()]
    direction = ["{v:.10g}".format(v=v) for v in reference.GetDirection()]
    for i in range(po.GetNumberOfParameterMaps()):
        pm = po.GetParameterMap(i)
        pm["Size"] = size
        pm["Spacing"] = spacing
        pm["Origin"] = origin
        pm["Direction"] = direction
        pm["FinalBSplineInterpolationOrder"] = ["0"] if nearest else ["1"]
        po.SetParameterMap(i, pm)

    shift = np.asarray(reg.pre_shift_lps or [0.0, 0.0, 0.0], dtype=np.float64)
    shifted = _shift_origin(moving_img, shift)
    arr = sitk.GetArrayFromImage(sitk.Cast(shifted, sitk.sitkFloat32))
    itk_moving = itk.image_from_array(np.ascontiguousarray(arr))
    itk_moving.SetSpacing([float(v) for v in shifted.GetSpacing()])
    itk_moving.SetOrigin([float(v) for v in shifted.GetOrigin()])
    itk_moving.SetDirection(itk.matrix_from_array(
        np.asarray(shifted.GetDirection(), dtype=np.float64).reshape(3, 3)))

    out = itk.transformix_filter(itk_moving, transform_parameter_object=po,
                                 log_to_console=False)
    return np.asarray(itk.array_from_image(out))


def resample_moving(
    reg: Registration,
    array: Optional[np.ndarray] = None,
    nearest: bool = False,
    default_value: float = 0.0,
) -> np.ndarray:
    """The moving series (or *array*, on the moving grid) on the fixed grid.

    Returns a ``(nz, ny, nx)`` array shaped exactly like the fixed series'
    volume, so the result drops straight into the label store.
    """
    import SimpleITK as sitk

    fixed_vol, _fm = _series_volume(reg.fixed_series_uid)
    moving_vol, _mm = _series_volume(reg.moving_series_uid)

    reference = patient_image(fixed_vol)
    moving_img = patient_image(moving_vol, array)

    if reg.transform_4x4 is not None:
        rs = sitk.ResampleImageFilter()
        rs.SetReferenceImage(reference)
        rs.SetInterpolator(sitk.sitkNearestNeighbor if nearest else sitk.sitkLinear)
        rs.SetDefaultPixelValue(float(default_value))
        rs.SetTransform(_sitk_transform(reg))
        out = sitk.GetArrayFromImage(
            rs.Execute(sitk.Cast(moving_img, sitk.sitkFloat32)))
    else:
        out = _transformix_resample(reg, moving_img, reference, nearest)

    if out.shape != fixed_vol.hu.shape:                # pragma: no cover
        raise RegistrationError(
            "resampled shape {a} does not match the fixed series {b}".format(
                a=out.shape, b=fixed_vol.hu.shape))
    return out


def resample_label(reg: Registration, mask: np.ndarray) -> np.ndarray:
    """Warp a ``uint8`` mask from the moving grid onto the fixed grid."""
    warped = resample_moving(reg, np.asarray(mask, dtype=np.float32),
                             nearest=True, default_value=0.0)
    return (warped > 0.5).astype(np.uint8)


def cached_moving(reg: Registration) -> np.ndarray:
    """:func:`resample_moving` with a small LRU, for the slice preview."""
    with _resample_lock:
        hit = _resample_cache.get(reg.registration_id)
        if hit is not None:
            _resample_cache.move_to_end(reg.registration_id)
            return hit[0]
    arr = resample_moving(reg)
    with _resample_lock:
        _resample_cache[reg.registration_id] = (arr, reg.moving_series_uid)
        _resample_cache.move_to_end(reg.registration_id)
        while len(_resample_cache) > RESAMPLE_CACHE_SIZE:
            _resample_cache.popitem(last=False)
    return arr


def transform_points(
    reg: Registration,
    points_lps: Sequence[Sequence[float]],
    direction: str = "fixed_to_moving",
) -> list[list[float]]:
    """Map LPS points through the registration.

    ``fixed_to_moving`` (the default) applies ``transform_4x4`` as it is
    stored; ``moving_to_fixed`` applies its inverse.  Only defined for the
    linear modes -- a B-spline warp has no closed-form point map here.
    """
    if direction not in ("fixed_to_moving", "moving_to_fixed"):
        raise RegistrationError(
            "direction must be fixed_to_moving or moving_to_fixed")
    if reg.transform_4x4 is None:
        raise RegistrationError(
            "point transformation needs a linear registration; {i} is {m}"
            .format(i=reg.registration_id, m=reg.mode))

    pts = np.asarray(points_lps, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] != 3:
        raise RegistrationError("points_lps must be a list of [x, y, z] triples")

    m = np.asarray(reg.transform_4x4, dtype=np.float64)
    if direction == "moving_to_fixed":
        try:
            m = np.linalg.inv(m)
        except np.linalg.LinAlgError as exc:           # pragma: no cover
            raise RegistrationError("transform is singular") from exc
    out = pts @ m[:3, :3].T + m[:3, 3]
    return [[float(v) for v in row] for row in out]
