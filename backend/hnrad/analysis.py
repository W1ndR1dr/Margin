"""Volume loading, thumbnails, marching-cubes STL export and ROI statistics.

Everything here works in Hounsfield units (``stored * RescaleSlope +
RescaleIntercept``) and in patient LPS millimetres, so the geometry that leaves
this module can be dropped straight into a printer or a planning package.
"""

from __future__ import annotations

import io
import logging
import struct
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Sequence

import numpy as np
import pydicom

from . import config
from .indexer import orientation_normal, slice_position

log = logging.getLogger("hnrad.analysis")

__all__ = [
    "SeriesVolume",
    "AnalysisError",
    "load_series_volume",
    "load_instance_hu",
    "isosurface_stl",
    "roi_stats",
    "render_thumbnail",
    "clear_caches",
]


class AnalysisError(ValueError):
    """Bad input for an analysis request (maps to HTTP 400)."""


# --------------------------------------------------------------------------
# series volume + LRU cache
# --------------------------------------------------------------------------

@dataclass
class SeriesVolume:
    """A whole series as one HU volume plus the geometry to place it."""

    series_uid: str
    hu: np.ndarray                      # (nz, ny, nx) float32, Hounsfield units
    spacing: tuple[float, float, float]  # (dz, dy, dx) mm
    origin: np.ndarray                  # IPP of the first slice, LPS mm (3,)
    row_dir: np.ndarray                 # iop[0:3]: +column index direction (3,)
    col_dir: np.ndarray                 # iop[3:6]: +row index direction (3,)
    slice_dir: np.ndarray               # +slice index direction (3,)
    sop_uids: list[str] = field(default_factory=list)
    positions: list[float] = field(default_factory=list)

    @property
    def shape(self) -> tuple[int, int, int]:
        return tuple(int(v) for v in self.hu.shape)  # type: ignore[return-value]


_volume_cache: "OrderedDict[str, SeriesVolume]" = OrderedDict()
_volume_lock = threading.Lock()

_thumb_cache: dict[str, bytes] = {}
_thumb_lock = threading.Lock()


def clear_caches() -> None:
    """Drop the volume and thumbnail caches (used by the tests)."""
    with _volume_lock:
        _volume_cache.clear()
    with _thumb_lock:
        _thumb_cache.clear()


def _cache_get(series_uid: str) -> Optional[SeriesVolume]:
    with _volume_lock:
        vol = _volume_cache.get(series_uid)
        if vol is not None:
            _volume_cache.move_to_end(series_uid)
        return vol


def _cache_put(series_uid: str, vol: SeriesVolume) -> None:
    with _volume_lock:
        _volume_cache[series_uid] = vol
        _volume_cache.move_to_end(series_uid)
        while len(_volume_cache) > config.VOLUME_CACHE_SIZE:
            _volume_cache.popitem(last=False)


def _row_ipp(row: Any) -> Optional[list[float]]:
    vals = [row["ipp_x"], row["ipp_y"], row["ipp_z"]]
    if any(v is None for v in vals):
        return None
    return [float(v) for v in vals]


def _row_iop(row: Any) -> Optional[list[float]]:
    vals = [row["iop_%d" % i] for i in range(6)]
    if any(v is None for v in vals):
        return None
    return [float(v) for v in vals]


def sorted_instances(rows: Sequence[Any]) -> list[tuple[Any, Optional[float]]]:
    """Order instance rows by slice position (falling back to InstanceNumber).

    Returns ``[(row, slice_pos), ...]`` ascending.
    """
    normal = None
    for r in rows:
        iop = _row_iop(r)
        if iop is not None:
            normal = orientation_normal(iop)
            if normal is not None:
                break

    decorated: list[tuple[Any, Optional[float]]] = []
    for r in rows:
        pos = slice_position(_row_ipp(r), normal, fallback=r["instance_number"])
        decorated.append((r, pos))

    def key(item: tuple[Any, Optional[float]]) -> tuple[int, float, str]:
        row, pos = item
        if pos is None:
            return (1, 0.0, str(row["sop_uid"]))
        return (0, float(pos), str(row["sop_uid"]))

    decorated.sort(key=key)
    return decorated


def _read_hu(path: str) -> tuple[np.ndarray, float, float]:
    """Read a DICOM file and return (HU array float32, row_mm, col_mm)."""
    ds = pydicom.dcmread(path, force=True)
    try:
        arr = ds.pixel_array
    except Exception as exc:  # pragma: no cover - depends on codec availability
        raise AnalysisError("cannot decode pixel data: {e}".format(e=exc)) from exc
    arr = np.asarray(arr)
    if arr.ndim == 3 and arr.shape[0] == 1:
        arr = arr[0]
    hu = arr.astype(np.float32, copy=False)
    slope = getattr(ds, "RescaleSlope", None)
    intercept = getattr(ds, "RescaleIntercept", None)
    try:
        slope_f = float(slope) if slope is not None else 1.0
    except (TypeError, ValueError):
        slope_f = 1.0
    try:
        intercept_f = float(intercept) if intercept is not None else 0.0
    except (TypeError, ValueError):
        intercept_f = 0.0
    if slope_f != 1.0 or intercept_f != 0.0:
        hu = hu * np.float32(slope_f) + np.float32(intercept_f)
    else:
        hu = hu.astype(np.float32, copy=False)

    ps = getattr(ds, "PixelSpacing", None)
    try:
        row_mm, col_mm = (float(ps[0]), float(ps[1])) if ps is not None else (1.0, 1.0)
    except (TypeError, ValueError, IndexError):
        row_mm, col_mm = 1.0, 1.0
    return hu, row_mm, col_mm


def load_instance_hu(row: Any) -> tuple[np.ndarray, float, float]:
    """HU array for one instance row, plus (row_mm, col_mm) pixel spacing."""
    path = row["file_path"]
    if not Path(path).exists():
        raise AnalysisError("file missing on disk: {p}".format(p=path))
    hu, row_mm, col_mm = _read_hu(path)
    # Prefer the indexed spacing when the file itself has none.
    if row["pixel_spacing_row"] is not None:
        row_mm = float(row["pixel_spacing_row"])
    if row["pixel_spacing_col"] is not None:
        col_mm = float(row["pixel_spacing_col"])
    return hu, row_mm, col_mm


def load_series_volume(
    series_uid: str, rows: Sequence[Any], use_cache: bool = True
) -> SeriesVolume:
    """Load (or fetch from the LRU cache) a whole series as an HU volume."""
    if use_cache:
        cached = _cache_get(series_uid)
        if cached is not None:
            return cached
    if not rows:
        raise AnalysisError("series has no instances")

    ordered = sorted_instances(rows)
    first_row = ordered[0][0]

    iop = None
    for r, _pos in ordered:
        iop = _row_iop(r)
        if iop is not None:
            break
    if iop is None:
        iop = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    row_dir = np.asarray(iop[0:3], dtype=np.float64)
    col_dir = np.asarray(iop[3:6], dtype=np.float64)
    normal = orientation_normal(iop)
    normal_vec = np.asarray(normal if normal is not None else (0.0, 0.0, 1.0),
                            dtype=np.float64)

    slices: list[np.ndarray] = []
    sop_uids: list[str] = []
    positions: list[float] = []
    row_mm = col_mm = 1.0
    ref_shape: Optional[tuple[int, int]] = None

    for r, pos in ordered:
        hu, rmm, cmm = load_instance_hu(r)
        if hu.ndim != 2:
            # Multi-frame instance: expand frames along the slice axis.
            for frame in hu.reshape((-1,) + hu.shape[-2:]):
                if ref_shape is None:
                    ref_shape = frame.shape
                if frame.shape != ref_shape:
                    continue
                slices.append(np.ascontiguousarray(frame, dtype=np.float32))
                sop_uids.append(str(r["sop_uid"]))
                positions.append(float(pos) if pos is not None else float(len(slices)))
        else:
            if ref_shape is None:
                ref_shape = hu.shape
            if hu.shape != ref_shape:
                log.warning("series %s: skipping odd-sized slice %s",
                            series_uid, r["sop_uid"])
                continue
            slices.append(np.ascontiguousarray(hu, dtype=np.float32))
            sop_uids.append(str(r["sop_uid"]))
            positions.append(float(pos) if pos is not None else float(len(slices)))
        row_mm, col_mm = rmm, cmm

    if not slices:
        raise AnalysisError("series has no readable pixel data")

    volume = np.stack(slices, axis=0).astype(np.float32, copy=False)

    # dz from the actual slice positions; fall back to the header spacing.
    dz = None
    if len(positions) > 1:
        diffs = np.abs(np.diff(np.asarray(positions, dtype=np.float64)))
        diffs = diffs[diffs > 1e-6]
        if diffs.size:
            dz = float(np.median(diffs))
    if dz is None or dz <= 0:
        for key in ("spacing_between_slices", "slice_thickness"):
            val = first_row[key]
            if val is not None and float(val) > 0:
                dz = float(val)
                break
    if dz is None or dz <= 0:
        dz = 1.0

    origin_list = _row_ipp(first_row)
    origin = np.asarray(origin_list if origin_list else (0.0, 0.0, 0.0),
                        dtype=np.float64)

    last_ipp = _row_ipp(ordered[-1][0])
    slice_dir = normal_vec
    if origin_list is not None and last_ipp is not None and len(ordered) > 1:
        delta = np.asarray(last_ipp, dtype=np.float64) - origin
        mag = float(np.linalg.norm(delta))
        if mag > 1e-6:
            slice_dir = delta / mag

    vol = SeriesVolume(
        series_uid=series_uid,
        hu=volume,
        spacing=(float(dz), float(row_mm), float(col_mm)),
        origin=origin,
        row_dir=row_dir,
        col_dir=col_dir,
        slice_dir=slice_dir,
        sop_uids=sop_uids,
        positions=positions,
    )
    if use_cache:
        _cache_put(series_uid, vol)
    return vol


# --------------------------------------------------------------------------
# isosurface -> binary STL
# --------------------------------------------------------------------------

def _laplacian_smooth(
    verts: np.ndarray, faces: np.ndarray, iters: int
) -> np.ndarray:
    """Uniform (umbrella) Laplacian smoothing: replace each vertex by the mean
    of its 1-ring neighbours.  Cheap, and enough to take the staircase off a
    marching-cubes shell."""
    if iters <= 0 or verts.size == 0 or faces.size == 0:
        return verts
    n = verts.shape[0]
    edges = np.vstack([
        faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]],
        faces[:, [1, 0]], faces[:, [2, 1]], faces[:, [0, 2]],
    ]).astype(np.int64)
    src = edges[:, 0]
    dst = edges[:, 1]
    degree = np.bincount(src, minlength=n).astype(np.float32)
    degree[degree == 0] = 1.0

    out = verts.astype(np.float32, copy=True)
    for _ in range(int(iters)):
        acc = np.zeros_like(out)
        for axis in range(3):
            acc[:, axis] = np.bincount(src, weights=out[dst, axis], minlength=n)
        out = (acc / degree[:, None]).astype(np.float32)
    return out


def _binary_stl(verts: np.ndarray, faces: np.ndarray, header: str) -> bytes:
    """Serialise a triangle soup as a binary STL (80-byte header, 50B records)."""
    tris = verts[faces]                       # (n, 3, 3) float32
    v0, v1, v2 = tris[:, 0], tris[:, 1], tris[:, 2]
    normals = np.cross(v1 - v0, v2 - v0)
    lengths = np.linalg.norm(normals, axis=1)
    lengths[lengths == 0] = 1.0
    normals = (normals / lengths[:, None]).astype(np.float32)

    rec = np.zeros(
        faces.shape[0],
        dtype=np.dtype([
            ("normal", "<f4", (3,)),
            ("verts", "<f4", (3, 3)),
            ("attr", "<u2"),
        ]),
    )
    assert rec.dtype.itemsize == 50, rec.dtype.itemsize
    rec["normal"] = normals
    rec["verts"] = tris.astype(np.float32, copy=False)

    head = header.encode("ascii", "replace")[:80].ljust(80, b"\0")
    return head + struct.pack("<I", faces.shape[0]) + rec.tobytes()


def isosurface_stl(
    vol: SeriesVolume,
    lower_hu: float,
    upper_hu: Optional[float] = None,
    step: int = 1,
    smooth_iters: int = 0,
) -> bytes:
    """Marching-cubes surface of ``lower_hu <= HU <= upper_hu`` as binary STL.

    Vertices come back in patient LPS millimetres.
    """
    from skimage import measure  # imported lazily: skimage is slow to load

    step = int(step) if step else 1
    if step not in (1, 2):
        raise AnalysisError("step must be 1 or 2")
    if upper_hu is not None and float(upper_hu) <= float(lower_hu):
        raise AnalysisError("upper_hu must be greater than lower_hu")

    data = vol.hu
    dz, dy, dx = vol.spacing
    if step > 1:
        data = data[::step, ::step, ::step]
        dz, dy, dx = dz * step, dy * step, dx * step
    if min(data.shape) < 2:
        raise AnalysisError("volume too small for marching cubes")

    lower = float(lower_hu)
    if upper_hu is None:
        field_arr = data
        level = lower
        if not (float(field_arr.min()) < level < float(field_arr.max())):
            raise AnalysisError(
                "threshold {l} is outside the volume range [{a:.1f}, {b:.1f}]".format(
                    l=level, a=float(field_arr.min()), b=float(field_arr.max()))
            )
    else:
        mask = (data >= lower) & (data <= float(upper_hu))
        if not mask.any() or mask.all():
            raise AnalysisError("threshold band selects no surface")
        field_arr = mask.astype(np.float32)
        level = 0.5

    verts, faces, _normals, _values = measure.marching_cubes(
        field_arr, level=level, spacing=(dz, dy, dx)
    )
    if faces.shape[0] == 0:
        raise AnalysisError("no triangles at this threshold")

    verts = verts.astype(np.float32, copy=False)
    faces = faces.astype(np.int64, copy=False)
    if smooth_iters:
        verts = _laplacian_smooth(verts, faces, int(smooth_iters))

    # Index-space millimetres -> patient LPS millimetres.
    #   P = IPP0 + rowDir * (col_mm) + colDir * (row_mm) + sliceDir * (z_mm)
    # verts columns are (z_mm, row_mm, col_mm) because spacing was (dz, dy, dx).
    basis = np.vstack([vol.slice_dir, vol.col_dir, vol.row_dir]).astype(np.float32)
    lps = verts @ basis + vol.origin.astype(np.float32)

    header = "HNRad isosurface {s} {l:g}HU".format(s=vol.series_uid[-24:], l=lower)
    return _binary_stl(lps.astype(np.float32, copy=False), faces, header)


# --------------------------------------------------------------------------
# ROI statistics
# --------------------------------------------------------------------------

def roi_stats(
    hu: np.ndarray,
    polygon: Sequence[Sequence[float]],
    row_mm: float,
    col_mm: float,
) -> dict[str, float]:
    """Statistics inside a pixel-space polygon ``[[col, row], ...]``."""
    from skimage.draw import polygon as sk_polygon

    if hu.ndim != 2:
        raise AnalysisError("ROI statistics need a single-frame image")
    pts = np.asarray(polygon, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[0] < 3 or pts.shape[1] != 2:
        raise AnalysisError("polygon must be >= 3 [col, row] pairs")

    cols = pts[:, 0]
    rows = pts[:, 1]
    rr, cc = sk_polygon(rows, cols, shape=hu.shape)
    if rr.size == 0:
        raise AnalysisError("polygon selects no pixels")

    vals = hu[rr, cc].astype(np.float64, copy=False)
    n = int(vals.size)
    return {
        "mean_hu": float(np.mean(vals)),
        "std_hu": float(np.std(vals)),
        "min_hu": float(np.min(vals)),
        "max_hu": float(np.max(vals)),
        "area_mm2": float(n * float(row_mm) * float(col_mm)),
        "n_voxels": n,
    }


# --------------------------------------------------------------------------
# thumbnails
# --------------------------------------------------------------------------

def _window(hu: np.ndarray, width: float, center: float) -> np.ndarray:
    lo = center - width / 2.0
    scaled = (hu.astype(np.float32, copy=False) - np.float32(lo)) / np.float32(width)
    return (np.clip(scaled, 0.0, 1.0) * 255.0).astype(np.uint8)


def render_thumbnail(
    series_uid: str,
    row: Any,
    size: int = config.THUMBNAIL_SIZE,
    width: float = config.WINDOW_WIDTH,
    center: float = config.WINDOW_CENTER,
) -> bytes:
    """PNG bytes for one instance, windowed, letterboxed onto a black square."""
    with _thumb_lock:
        hit = _thumb_cache.get(series_uid)
    if hit is not None:
        return hit

    from PIL import Image

    hu, _row_mm, _col_mm = load_instance_hu(row)
    if hu.ndim == 3:
        hu = hu[hu.shape[0] // 2]
    gray = _window(hu, width, center)

    img = Image.fromarray(gray, mode="L")
    h, w = gray.shape
    scale = min(size / float(w), size / float(h))
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    img = img.resize((new_w, new_h), Image.BILINEAR)

    canvas = Image.new("L", (size, size), 0)
    canvas.paste(img, ((size - new_w) // 2, (size - new_h) // 2))

    buf = io.BytesIO()
    canvas.save(buf, format="PNG", optimize=True)
    data = buf.getvalue()

    with _thumb_lock:
        _thumb_cache[series_uid] = data
    return data
