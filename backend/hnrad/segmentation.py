"""Label segmentation, volumetrics and label export.

Everything in here works on the cached :class:`~hnrad.analysis.SeriesVolume`
HU array and produces ``uint8`` masks shaped ``(nz, ny, nx)`` -- the same axis
order as ``SeriesVolume.hu``.

Index conventions
-----------------
``ijk`` is **(i = column, j = row, k = slice)**, which is the order the
frontend (and SimpleITK) uses.  The numpy arrays are ``(k, j, i)``.

A "local frame" is used for every millimetre computation:

    x_local = i * dx      y_local = j * dy      z_local = k * dz

which maps into patient LPS millimetres with the same expression the
marching-cubes exporter already uses::

    P = origin + x_local * row_dir + y_local * col_dir + z_local * slice_dir

Because ``row_dir``/``col_dir``/``slice_dir`` are orthonormal for any regular
axial/oblique series, distances and areas are identical in both frames, so the
heavy lifting can stay in the (axis aligned) local frame and only the reported
points get mapped to LPS.
"""

from __future__ import annotations

import gzip
import logging
import math
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Optional, Sequence

import numpy as np

from .analysis import AnalysisError, SeriesVolume, _binary_stl, _laplacian_smooth

log = logging.getLogger("hnrad.segmentation")

__all__ = [
    "Label",
    "LABELS",
    "BODY_HU",
    "ijk_to_lps",
    "lps_to_ijk",
    "seed_to_ijk",
    "body_mask",
    "region_grow",
    "threshold_mask",
    "mask_stats",
    "label_mesh_stl",
    "mask_payload",
    "min_distance",
    "clear_caches",
]

# Voxels above this HU are "patient" for the purposes of the body mask.
BODY_HU = -500.0

# How many labels stay resident (LRU).
LABEL_CACHE_SIZE = 20

# How many body masks stay resident (LRU); they are expensive to recompute.
BODY_CACHE_SIZE = 2


# --------------------------------------------------------------------------
# geometry
# --------------------------------------------------------------------------

def _basis(vol: SeriesVolume) -> np.ndarray:
    """Rows = the LPS direction of the +i, +j and +k index axes."""
    return np.vstack([vol.row_dir, vol.col_dir, vol.slice_dir]).astype(np.float64)


def _voxel_mm(vol: SeriesVolume) -> np.ndarray:
    """(dx, dy, dz) -- the millimetre step of one +i, +j, +k voxel."""
    dz, dy, dx = vol.spacing
    return np.asarray([dx, dy, dz], dtype=np.float64)


def voxel_volume_mm3(vol: SeriesVolume) -> float:
    dz, dy, dx = vol.spacing
    return float(dx) * float(dy) * float(dz)


def local_to_lps(vol: SeriesVolume, local: np.ndarray) -> np.ndarray:
    """Local-frame millimetres (x, y, z) -> patient LPS millimetres."""
    pts = np.atleast_2d(np.asarray(local, dtype=np.float64))
    out = pts @ _basis(vol) + vol.origin.astype(np.float64)
    return out[0] if np.ndim(local) == 1 else out


def ijk_to_lps(vol: SeriesVolume, ijk: Sequence[float]) -> list[float]:
    """Fractional voxel index (i, j, k) -> patient LPS millimetres."""
    local = np.asarray(ijk, dtype=np.float64) * _voxel_mm(vol)
    return [float(v) for v in local_to_lps(vol, local)]


def lps_to_ijk(vol: SeriesVolume, lps: Sequence[float]) -> list[float]:
    """Patient LPS millimetres -> fractional voxel index (i, j, k)."""
    mat = (_basis(vol) * _voxel_mm(vol)[:, None]).T     # columns = i, j, k steps
    rhs = np.asarray(lps, dtype=np.float64) - vol.origin.astype(np.float64)
    try:
        sol = np.linalg.lstsq(mat, rhs, rcond=None)[0]
    except np.linalg.LinAlgError as exc:                # pragma: no cover
        raise AnalysisError("series geometry is degenerate") from exc
    return [float(v) for v in sol]


def seed_to_ijk(
    vol: SeriesVolume,
    seed_ijk: Optional[Sequence[float]],
    seed_lps: Optional[Sequence[float]],
) -> tuple[int, int, int]:
    """Resolve either seed form to an integer (i, j, k), bounds checked."""
    if seed_ijk is None and seed_lps is None:
        raise AnalysisError("one of seed_ijk or seed_lps is required")
    if seed_ijk is not None and seed_lps is not None:
        raise AnalysisError("give either seed_ijk or seed_lps, not both")

    raw = list(seed_ijk) if seed_ijk is not None else lps_to_ijk(vol, list(seed_lps))
    if len(raw) != 3:
        raise AnalysisError("seed must have 3 components")
    i, j, k = (int(round(float(v))) for v in raw)

    nz, ny, nx = vol.hu.shape
    if not (0 <= i < nx and 0 <= j < ny and 0 <= k < nz):
        raise AnalysisError(
            "seed (i={i}, j={j}, k={k}) is outside the volume"
            " (nx={nx}, ny={ny}, nz={nz})".format(i=i, j=j, k=k, nx=nx, ny=ny, nz=nz)
        )
    return i, j, k


# --------------------------------------------------------------------------
# SimpleITK plumbing
# --------------------------------------------------------------------------

def sitk_image(arr: np.ndarray, vol: SeriesVolume):
    """Wrap a ``(nz, ny, nx)`` array as a SimpleITK image in the local frame."""
    import SimpleITK as sitk

    img = sitk.GetImageFromArray(np.ascontiguousarray(arr))
    dz, dy, dx = vol.spacing
    img.SetSpacing((float(dx), float(dy), float(dz)))
    img.SetOrigin((0.0, 0.0, 0.0))
    img.SetDirection((1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0))
    return img


def _largest_component(mask: np.ndarray, vol: SeriesVolume) -> np.ndarray:
    """Keep only the biggest 6-connected component of a binary mask."""
    import SimpleITK as sitk

    if not mask.any():
        return mask
    img = sitk_image(mask.astype(np.uint8, copy=False), vol)
    cc = sitk.ConnectedComponent(img, False)             # face connectivity
    cc = sitk.RelabelComponent(cc, 0, True)
    return (sitk.GetArrayFromImage(cc) == 1).astype(np.uint8)


def _drop_small_components(
    mask: np.ndarray, vol: SeriesVolume, min_voxels: int
) -> np.ndarray:
    import SimpleITK as sitk

    if min_voxels <= 1 or not mask.any():
        return mask
    img = sitk_image(mask.astype(np.uint8, copy=False), vol)
    cc = sitk.ConnectedComponent(img, False)             # face connectivity
    cc = sitk.RelabelComponent(cc, int(min_voxels), True)
    return (sitk.GetArrayFromImage(cc) > 0).astype(np.uint8)


def _close(mask: np.ndarray, vol: SeriesVolume, closing_mm: float) -> np.ndarray:
    """Binary morphological closing with a ball of ``closing_mm`` radius."""
    import SimpleITK as sitk

    if closing_mm is None or float(closing_mm) <= 0.0 or not mask.any():
        return mask
    dz, dy, dx = vol.spacing
    radius = [
        max(1, int(round(float(closing_mm) / float(s)))) for s in (dx, dy, dz)
    ]
    img = sitk_image(mask.astype(np.uint8, copy=False), vol)
    closed = sitk.BinaryMorphologicalClosing(img, radius, sitk.sitkBall, 1.0, True)
    return (sitk.GetArrayFromImage(closed) > 0).astype(np.uint8)


# --------------------------------------------------------------------------
# body mask (cached per series)
# --------------------------------------------------------------------------

_body_cache: "OrderedDict[str, np.ndarray]" = OrderedDict()
_body_lock = threading.Lock()


def body_mask(vol: SeriesVolume) -> np.ndarray:
    """The patient: the largest component of ``HU > -500``, holes filled.

    Holes are filled slice by slice, which is what makes the airway (and the
    bowel gas of the world) part of the body rather than part of the outside
    air -- the airway column is open at the top and bottom of the scan, so a
    3D fill would leave it outside.
    """
    with _body_lock:
        hit = _body_cache.get(vol.series_uid)
        if hit is not None:
            _body_cache.move_to_end(vol.series_uid)
            return hit

    from scipy import ndimage

    started = time.perf_counter()
    solid = (vol.hu > np.float32(BODY_HU))
    if not solid.any():
        raise AnalysisError("no voxels above {h:g} HU: cannot build a body mask"
                            .format(h=BODY_HU))
    largest = _largest_component(solid.astype(np.uint8), vol)
    filled = np.empty_like(largest)
    for k in range(largest.shape[0]):
        filled[k] = ndimage.binary_fill_holes(largest[k])
    filled = filled.astype(np.uint8, copy=False)

    log.info("body mask series=%s -> %d voxels in %.3fs",
             vol.series_uid, int(filled.sum()), time.perf_counter() - started)

    with _body_lock:
        _body_cache[vol.series_uid] = filled
        _body_cache.move_to_end(vol.series_uid)
        while len(_body_cache) > BODY_CACHE_SIZE:
            _body_cache.popitem(last=False)
    return filled


# --------------------------------------------------------------------------
# label store
# --------------------------------------------------------------------------

@dataclass
class Label:
    label_id: str
    series_uid: str
    mask: np.ndarray                     # (nz, ny, nx) uint8
    meta: dict[str, Any] = field(default_factory=dict)
    created: float = field(default_factory=time.time)


class LabelStore:
    """An in-memory LRU of segmentation masks keyed by a uuid4 string."""

    def __init__(self, capacity: int = LABEL_CACHE_SIZE) -> None:
        self._items: "OrderedDict[str, Label]" = OrderedDict()
        self._lock = threading.Lock()
        self.capacity = int(capacity)

    def put(self, series_uid: str, mask: np.ndarray,
            meta: Optional[dict[str, Any]] = None,
            label_id: Optional[str] = None) -> Label:
        """Store a mask and return its :class:`Label`.

        ``label_id`` lets a caller re-materialise a label under an id it has
        already handed out: :mod:`hnrad.ai` allocates ids for every AI
        structure when a job finishes but only builds the masks when they are
        first asked for.  Omit it (the default) for a brand new label.
        """
        label = Label(
            label_id=str(label_id) if label_id else str(uuid.uuid4()),
            series_uid=series_uid,
            mask=np.ascontiguousarray(mask, dtype=np.uint8),
            meta=dict(meta or {}),
        )
        with self._lock:
            self._items[label.label_id] = label
            self._items.move_to_end(label.label_id)
            while len(self._items) > self.capacity:
                dropped, _ = self._items.popitem(last=False)
                log.info("label store full: evicted %s", dropped)
        return label

    def get(self, label_id: str) -> Optional[Label]:
        with self._lock:
            label = self._items.get(label_id)
            if label is not None:
                self._items.move_to_end(label_id)
            return label

    def delete(self, label_id: str) -> bool:
        with self._lock:
            return self._items.pop(label_id, None) is not None

    def clear(self) -> None:
        with self._lock:
            self._items.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)


LABELS = LabelStore()


def clear_caches() -> None:
    """Drop the label store and the body-mask cache (used by the tests)."""
    LABELS.clear()
    with _body_lock:
        _body_cache.clear()


# --------------------------------------------------------------------------
# region growing
# --------------------------------------------------------------------------

def _bbox3(
    mask: np.ndarray, pad: int = 0, shape: Optional[tuple[int, ...]] = None
) -> tuple[slice, slice, slice]:
    """Bounding box of a non-empty 3D mask as ``(k, j, i)`` slices."""
    shape = tuple(shape) if shape is not None else mask.shape
    out: list[slice] = []
    for axis in range(3):
        others = tuple(a for a in range(3) if a != axis)
        hits = np.flatnonzero(mask.any(axis=others))
        if hits.size == 0:
            raise AnalysisError("mask is empty")
        out.append(slice(max(0, int(hits[0]) - pad),
                         min(int(shape[axis]), int(hits[-1]) + 1 + pad)))
    return (out[0], out[1], out[2])


def _sphere_window(
    vol: SeriesVolume, seed: tuple[int, int, int], radius_mm: float
) -> tuple[tuple[slice, slice, slice], np.ndarray]:
    """(k, j, i) slices of the bounding box of a sphere, and the sphere mask."""
    nz, ny, nx = vol.hu.shape
    dz, dy, dx = vol.spacing
    i0, j0, k0 = seed

    ri = int(math.ceil(radius_mm / float(dx)))
    rj = int(math.ceil(radius_mm / float(dy)))
    rk = int(math.ceil(radius_mm / float(dz)))

    win = (
        slice(max(0, k0 - rk), min(nz, k0 + rk + 1)),
        slice(max(0, j0 - rj), min(ny, j0 + rj + 1)),
        slice(max(0, i0 - ri), min(nx, i0 + ri + 1)),
    )
    kk = (np.arange(win[0].start, win[0].stop) - k0) * float(dz)
    jj = (np.arange(win[1].start, win[1].stop) - j0) * float(dy)
    ii = (np.arange(win[2].start, win[2].stop) - i0) * float(dx)
    dist2 = (kk[:, None, None] ** 2 + jj[None, :, None] ** 2
             + ii[None, None, :] ** 2)
    return win, dist2 <= float(radius_mm) ** 2


def region_grow(
    vol: SeriesVolume,
    seed: tuple[int, int, int],
    lower_hu: float,
    upper_hu: float,
    max_radius_mm: Optional[float] = 40.0,
    closing_mm: float = 0.0,
    keep_largest: bool = True,
    restrict: Optional[np.ndarray] = None,
) -> np.ndarray:
    """SimpleITK ConnectedThreshold from ``seed``, capped to a sphere.

    ``restrict`` is an optional extra binary mask (the body mask, typically)
    that the grow may not leave.
    """
    import SimpleITK as sitk

    lower = float(lower_hu)
    upper = float(upper_hu)
    if upper <= lower:
        raise AnalysisError("upper_hu must be greater than lower_hu")

    i0, j0, k0 = seed
    seed_hu = float(vol.hu[k0, j0, i0])
    if not (lower <= seed_hu <= upper):
        raise AnalysisError(
            "seed HU {v:.1f} is outside [{a:g}, {b:g}]".format(
                v=seed_hu, a=lower, b=upper)
        )

    nz, ny, nx = vol.hu.shape
    if max_radius_mm is not None and float(max_radius_mm) > 0:
        win, sphere = _sphere_window(vol, seed, float(max_radius_mm))
    else:
        win = (slice(0, nz), slice(0, ny), slice(0, nx))
        sphere = None

    # Candidate voxels: in the HU window, inside the sphere and inside the
    # restriction.  Everything downstream happens inside the bounding box of
    # this set, which is what keeps a 512 x 512 x 180 series interactive.
    cand = (vol.hu[win] >= np.float32(lower)) & (vol.hu[win] <= np.float32(upper))
    if sphere is not None:
        cand &= sphere
    if restrict is not None:
        cand &= restrict[win] > 0
    seed_win = (int(k0 - win[0].start), int(j0 - win[1].start),
                int(i0 - win[2].start))
    if not cand[seed_win]:
        raise AnalysisError("the seed is excluded by max_radius_mm or the body mask")

    pad = 0
    if closing_mm and float(closing_mm) > 0:
        pad = int(math.ceil(float(closing_mm)
                            / min(float(s) for s in vol.spacing))) + 1
    box = _bbox3(cand, pad=pad, shape=cand.shape)
    cand = cand[box]
    sub = vol.hu[win][box]
    seed_box = tuple(seed_win[a] - box[a].start for a in range(3))

    # Anything outside the candidate set is pushed well below the HU window so
    # ConnectedThreshold simply cannot walk through it.
    sentinel = np.float32(lower - 1.0e4)
    work = np.where(cand, sub, sentinel).astype(np.float32, copy=False)

    img = sitk_image(work, vol)
    grown = sitk.ConnectedThreshold(
        img, [(int(seed_box[2]), int(seed_box[1]), int(seed_box[0]))],
        lower, upper, 1,
        sitk.ConnectedThresholdImageFilter.FaceConnectivity,
    )
    sub_mask = sitk.GetArrayFromImage(grown).astype(np.uint8)

    if closing_mm and float(closing_mm) > 0:
        sub_mask = _close(sub_mask, vol, float(closing_mm))
        # Closing may not push the label past the radius cap or out of the body.
        keep = np.ones(sub_mask.shape, dtype=bool)
        if sphere is not None:
            keep &= sphere[box]
        if restrict is not None:
            keep &= restrict[win][box] > 0
        sub_mask = (sub_mask & keep).astype(np.uint8)
    if keep_largest:
        sub_mask = _largest_component(sub_mask, vol)
    if not sub_mask.any():
        raise AnalysisError("region grow produced an empty label")

    mask = np.zeros(vol.hu.shape, dtype=np.uint8)
    mask[win[0].start + box[0].start: win[0].start + box[0].stop,
         win[1].start + box[1].start: win[1].start + box[1].stop,
         win[2].start + box[2].start: win[2].start + box[2].stop] = sub_mask
    return mask


def threshold_mask(
    vol: SeriesVolume,
    lower_hu: float,
    upper_hu: float,
    inside_body: bool = True,
    keep_largest: bool = False,
    min_component_ml: float = 0.05,
) -> np.ndarray:
    """Global HU threshold, optionally clipped to the body and cleaned up."""
    lower = float(lower_hu)
    upper = float(upper_hu)
    if upper <= lower:
        raise AnalysisError("upper_hu must be greater than lower_hu")

    mask = ((vol.hu >= np.float32(lower)) & (vol.hu <= np.float32(upper)))
    mask = mask.astype(np.uint8, copy=False)
    if inside_body:
        mask = (mask & body_mask(vol)).astype(np.uint8)

    if min_component_ml and float(min_component_ml) > 0:
        min_voxels = int(math.ceil(float(min_component_ml) * 1000.0
                                   / voxel_volume_mm3(vol)))
        mask = _drop_small_components(mask, vol, min_voxels)
    if keep_largest:
        mask = _largest_component(mask, vol)
    if not mask.any():
        raise AnalysisError("threshold selects no voxels")
    return mask


# --------------------------------------------------------------------------
# statistics
# --------------------------------------------------------------------------

def _principal_extents(
    pts_mm: np.ndarray, voxel: np.ndarray
) -> tuple[list[float], np.ndarray]:
    """PCA extents of a voxel cloud, descending, in millimetres.

    Each extent is the span of the projected voxel *centres* plus the width of
    one voxel measured along that same direction, so a single voxel has the
    size of a voxel rather than zero.
    """
    centre = pts_mm.mean(axis=0)
    centred = pts_mm - centre
    cov = np.cov(centred, rowvar=False)
    cov = np.atleast_2d(cov)
    try:
        _vals, vecs = np.linalg.eigh(cov)
    except np.linalg.LinAlgError:                       # pragma: no cover
        vecs = np.eye(3)
    proj = centred @ vecs                               # columns = components
    spans = proj.max(axis=0) - proj.min(axis=0)
    pad = np.abs(vecs.T) @ voxel                        # voxel width per axis
    extents = spans + pad
    order = np.argsort(extents)[::-1]
    return [float(extents[o]) for o in order], vecs[:, order]


def _longest_axis(pts_mm: np.ndarray, voxel: np.ndarray, fallback: float) -> float:
    """Maximum caliper (Feret) diameter of the voxel cloud."""
    if pts_mm.shape[0] < 2:
        return float(np.linalg.norm(voxel))
    pts = pts_mm
    if pts.shape[0] > 60000:
        step = int(math.ceil(pts.shape[0] / 60000.0))
        pts = pts[::step]
    try:
        from scipy.spatial import ConvexHull

        hull = ConvexHull(pts)
        verts = pts[hull.vertices]
    except Exception:                                   # degenerate / too few
        verts = pts
    if verts.shape[0] > 3000:
        verts = verts[::int(math.ceil(verts.shape[0] / 3000.0))]
    diff = verts[:, None, :] - verts[None, :, :]
    d2 = np.einsum("ijk,ijk->ij", diff, diff)
    a, b = np.unravel_index(int(np.argmax(d2)), d2.shape)
    vec = verts[a] - verts[b]
    length = float(np.linalg.norm(vec))
    if length <= 0:
        return fallback
    pad = float(np.abs(vec / length) @ voxel)
    return length + pad


def mask_stats(
    vol: SeriesVolume, mask: np.ndarray, took_ms: Optional[float] = None
) -> dict[str, Any]:
    """Volumetrics, HU statistics and PCA diameters for one label."""
    started = time.perf_counter()
    idx = np.argwhere(mask > 0)                         # (n, 3) as (k, j, i)
    if idx.size == 0:
        raise AnalysisError("label is empty")

    dz, dy, dx = vol.spacing
    voxel = np.asarray([dx, dy, dz], dtype=np.float64)
    n = int(idx.shape[0])

    pts_mm = np.column_stack([
        idx[:, 2] * float(dx),
        idx[:, 1] * float(dy),
        idx[:, 0] * float(dz),
    ]).astype(np.float64)

    diameters, _axes = _principal_extents(pts_mm, voxel)
    longest = _longest_axis(pts_mm, voxel, diameters[0])

    vals = vol.hu[mask > 0].astype(np.float64, copy=False)
    centroid_local = pts_mm.mean(axis=0)

    i_min, j_min, k_min = int(idx[:, 2].min()), int(idx[:, 1].min()), int(idx[:, 0].min())
    i_max, j_max, k_max = int(idx[:, 2].max()), int(idx[:, 1].max()), int(idx[:, 0].max())

    out = {
        "n_voxels": n,
        "volume_ml": float(n * voxel_volume_mm3(vol) / 1000.0),
        "bbox_ijk": [i_min, j_min, k_min, i_max, j_max, k_max],
        "centroid_lps": [float(v) for v in local_to_lps(vol, centroid_local)],
        "mean_hu": float(np.mean(vals)),
        "std_hu": float(np.std(vals)),
        "longest_axis_mm": float(longest),
        "diameters_mm": [float(v) for v in diameters],
    }
    elapsed = (time.perf_counter() - started) * 1000.0
    out["took_ms"] = float(took_ms if took_ms is not None else elapsed)
    return out


# --------------------------------------------------------------------------
# export
# --------------------------------------------------------------------------

def label_mesh_stl(
    vol: SeriesVolume,
    mask: np.ndarray,
    smooth_iters: int = 10,
    step: int = 1,
    header: str = "HNRad label",
) -> bytes:
    """Marching-cubes surface of a binary label as a binary STL in LPS mm."""
    from skimage import measure

    step = int(step) if step else 1
    if step not in (1, 2):
        raise AnalysisError("step must be 1 or 2")

    data = mask.astype(np.float32, copy=False)
    dz, dy, dx = vol.spacing
    if step > 1:
        data = data[::step, ::step, ::step]
        dz, dy, dx = dz * step, dy * step, dx * step
    if min(data.shape) < 2:
        raise AnalysisError("label too small for marching cubes")
    # Pad so a label that touches the volume edge still closes.
    data = np.pad(data, 1, mode="constant", constant_values=0.0)
    if not (data.min() < 0.5 < data.max()):
        raise AnalysisError("label selects no surface")

    verts, faces, _n, _v = measure.marching_cubes(data, level=0.5,
                                                  spacing=(dz, dy, dx))
    if faces.shape[0] == 0:
        raise AnalysisError("no triangles for this label")
    verts = verts.astype(np.float32, copy=False)
    verts -= np.asarray([dz, dy, dx], dtype=np.float32)      # undo the pad
    faces = faces.astype(np.int64, copy=False)
    if smooth_iters:
        verts = _laplacian_smooth(verts, faces, int(smooth_iters))

    # verts columns are (z_mm, row_mm, col_mm) because spacing was (dz, dy, dx).
    basis = np.vstack([vol.slice_dir, vol.col_dir, vol.row_dir]).astype(np.float32)
    lps = verts @ basis + vol.origin.astype(np.float32)
    return _binary_stl(lps.astype(np.float32, copy=False), faces, header)


def mask_payload(vol: SeriesVolume, mask: np.ndarray) -> tuple[bytes, dict[str, str]]:
    """gzip of the raw ``(z, y, x)`` uint8 label plus the geometry headers."""
    raw = np.ascontiguousarray(mask, dtype=np.uint8).tobytes()
    blob = gzip.compress(raw, compresslevel=6)
    nz, ny, nx = vol.hu.shape
    dz, dy, dx = vol.spacing
    basis = _basis(vol).reshape(-1)
    headers = {
        "X-Shape": "{z},{y},{x}".format(z=nz, y=ny, x=nx),
        "X-Spacing": "{z:.10g},{y:.10g},{x:.10g}".format(z=dz, y=dy, x=dx),
        "X-Origin": ",".join("{v:.10g}".format(v=float(v)) for v in vol.origin),
        "X-Direction": ",".join("{v:.10g}".format(v=float(v)) for v in basis),
    }
    return blob, headers


# --------------------------------------------------------------------------
# label-to-label distance
# --------------------------------------------------------------------------

def _surface(mask: np.ndarray) -> np.ndarray:
    from scipy import ndimage

    eroded = ndimage.binary_erosion(mask > 0, iterations=1, border_value=0)
    return (mask > 0) & (~eroded)


def min_distance(
    vol: SeriesVolume, mask_a: np.ndarray, mask_b: np.ndarray
) -> dict[str, Any]:
    """Minimum surface-to-surface distance from label A to label B.

    The distance itself comes from a ``SignedMaurerDistanceMap`` of label B
    sampled at label A's surface voxels (negative when the two overlap); the
    reported point on B is the nearest B-surface voxel to that point on A.
    """
    import SimpleITK as sitk

    surf_a = _surface(mask_a)
    surf_b = _surface(mask_b)
    if not surf_a.any() or not surf_b.any():
        raise AnalysisError("both labels must be non-empty")

    dmap = sitk.SignedMaurerDistanceMap(
        sitk_image(mask_b.astype(np.uint8, copy=False), vol),
        False,      # insideIsPositive
        False,      # squaredDistance
        True,       # useImageSpacing
    )
    dist = sitk.GetArrayFromImage(dmap)

    idx_a = np.argwhere(surf_a)                         # (n, 3) as (k, j, i)
    vals = dist[surf_a]
    best = int(np.argmin(vals))
    k, j, i = (int(v) for v in idx_a[best])

    dz, dy, dx = vol.spacing
    pa_local = np.asarray([i * dx, j * dy, k * dz], dtype=np.float64)

    idx_b = np.argwhere(surf_b)
    pb_local = np.column_stack([
        idx_b[:, 2] * float(dx), idx_b[:, 1] * float(dy), idx_b[:, 0] * float(dz),
    ]).astype(np.float64)
    nearest = int(np.argmin(((pb_local - pa_local) ** 2).sum(axis=1)))

    return {
        "min_distance_mm": float(vals[best]),
        "point_a_lps": [float(v) for v in local_to_lps(vol, pa_local)],
        "point_b_lps": [float(v) for v in local_to_lps(vol, pb_local[nearest])],
    }
