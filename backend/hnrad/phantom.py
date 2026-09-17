"""Synthetic contrast-enhanced neck CT phantom generator for HNRad.

Writes a deterministic, anatomically plausible axial neck CT as an uncompressed
Explicit VR Little Endian DICOM series that Cornerstone3D / OHIF loads as a 3D
volume.

    python -m hnrad.phantom --out <dir> [--slices 180] [--seed 7]

Geometry / conventions
----------------------
Patient is supine, head first (HFS).  ImageOrientationPatient is 1\\0\\0\\0\\1\\0,
so in the LPS patient frame:

    +x  = patient LEFT   -> increasing column index -> displayed image RIGHT
    +y  = patient POSTERIOR -> increasing row index -> displayed image BOTTOM
    +z  = patient SUPERIOR  -> increasing slice index (slice 0 is most inferior)

Pixel values are HU directly (int16, RescaleIntercept 0 / RescaleSlope 1).

Everything about the geometry is a pure function of a normalised longitudinal
coordinate ``zz`` which runs 0 .. 179 ("reference slice") no matter how many
slices are requested, so a 12-slice smoke test still contains every structure.
"""

from __future__ import annotations

import argparse
import datetime
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
from scipy import ndimage

import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

# --------------------------------------------------------------------------- #
# constants
# --------------------------------------------------------------------------- #

ROWS = 512
COLS = 512
PS = 0.45                     # in-plane pixel spacing, mm -> 230.4 mm FOV
SLICE_THICKNESS = 1.0
SPACING_BETWEEN = 1.0
DEFAULT_SLICES = 180
REF_SLICES = 180              # anatomy is authored against this slice count
ZREF_MAX = float(REF_SLICES - 1)

UID_ROOT = "1.2.826.0.1.3680043.10.9481."
# Bumping this namespace forces new SOP/Series/Study UIDs whenever the rendered
# pixel data changes; the in-plane spacing is part of it on purpose.
UID_NAMESPACE = f"hnrad-phantom-v2-{ROWS}x{COLS}-ps{PS:g}"
IMPL_CLASS_UID = UID_ROOT + "0.1"
SYNTHETIC_NOTE = "SYNTHETIC PHANTOM - COMPUTER GENERATED - NOT A REAL PATIENT"
PRIVATE_GROUP = 0x000B
PRIVATE_CREATOR = "HNRAD PHANTOM"

AIR = -1000.0

# in-plane mm grids (row/col centre at the array centre)
_XS = (np.arange(COLS, dtype=np.float32) - (COLS - 1) / 2.0) * PS
_YS = (np.arange(ROWS, dtype=np.float32) - (ROWS - 1) / 2.0) * PS
X_MM, Y_MM = np.meshgrid(_XS, _YS)          # (rows, cols)

# tumour placement (patient RIGHT palatine tonsil -> negative x)
TUMOR_CX, TUMOR_CY, TUMOR_CZ = -11.6, -19.4, 115.0
TUMOR_LOBES = [
    # dx,   dy,   dz,   ax,   ay,   az
    (0.0, 0.0, 0.0, 13.8, 10.8, 14.8),
    (4.8, -3.2, -4.0, 8.2, 7.0, 8.0),
    (-4.2, 3.4, 4.5, 8.8, 7.4, 8.2),
    (1.8, 4.2, -5.5, 7.2, 6.2, 7.0),
]

# carotid / IJV centre-lines (absolute |x|, y) as a function of zz
_VESSEL_Z = [0.0, 30.0, 60.0, 80.0, 100.0, 120.0, 150.0, 179.0]
_CAR_X = [26.0, 25.0, 24.0, 23.5, 21.5, 20.0, 19.0, 18.5]
_CAR_Y = [-9.0, -10.0, -11.0, -11.0, -9.5, -8.0, -5.0, -2.0]
_IJ_X = [32.0, 32.0, 32.0, 32.5, 32.0, 31.0, 29.0, 27.0]
_IJ_Y = [-5.0, -6.0, -7.0, -7.0, -5.0, -4.0, -2.0, 0.0]

CAROTID_R = 3.5               # ICA radius (7 mm diameter)


# --------------------------------------------------------------------------- #
# small geometry helpers (all work on a tight bounding window for speed)
# --------------------------------------------------------------------------- #

def _lerp(zz: float, zs, vs) -> float:
    return float(np.interp(zz, zs, vs))


def _bump(zz: float, z0: float, z1: float, soft: float = 4.0) -> float:
    """Smooth 0..1..0 window over [z0, z1] with `soft` mm ramps."""
    if zz <= z0 - soft or zz >= z1 + soft:
        return 0.0
    up = min(1.0, max(0.0, (zz - (z0 - soft)) / soft))
    dn = min(1.0, max(0.0, ((z1 + soft) - zz) / soft))
    v = min(up, dn)
    return v * v * (3.0 - 2.0 * v)


def _xsec(zz: float, cz: float, az: float):
    """In-plane shrink factor of an ellipsoid at longitudinal position zz."""
    t = (zz - cz) / az
    if abs(t) >= 1.0:
        return 0.0
    return math.sqrt(1.0 - t * t)


def _window(cx, cy, ax, ay, rot=0.0, pad=1.5):
    """Index window (row slice, col slice) covering an ellipse, or None."""
    ct, st = math.cos(rot), math.sin(rot)
    hx = math.hypot(ax * ct, ay * st) + pad
    hy = math.hypot(ax * st, ay * ct) + pad
    j0 = int(math.floor((cx - hx) / PS + (COLS - 1) / 2.0))
    j1 = int(math.ceil((cx + hx) / PS + (COLS - 1) / 2.0)) + 1
    i0 = int(math.floor((cy - hy) / PS + (ROWS - 1) / 2.0))
    i1 = int(math.ceil((cy + hy) / PS + (ROWS - 1) / 2.0)) + 1
    j0, j1 = max(0, j0), min(COLS, j1)
    i0, i1 = max(0, i0), min(ROWS, i1)
    if j0 >= j1 or i0 >= i1:
        return None
    return (slice(i0, i1), slice(j0, j1))


def _r2(sl, cx, cy, ax, ay, rot=0.0):
    """Normalised squared ellipse radius on the given window (<=1 is inside)."""
    dx = X_MM[sl] - cx
    dy = Y_MM[sl] - cy
    if rot:
        ct, st = math.cos(rot), math.sin(rot)
        dx, dy = dx * ct + dy * st, -dx * st + dy * ct
    return (dx / ax) ** 2 + (dy / ay) ** 2


def _fill(img, cx, cy, ax, ay, val, rot=0.0):
    """Paint a filled ellipse."""
    if ax <= 0.05 or ay <= 0.05:
        return
    sl = _window(cx, cy, ax, ay, rot)
    if sl is None:
        return
    img[sl][_r2(sl, cx, cy, ax, ay, rot) <= 1.0] = val


def _ring(img, cx, cy, ax, ay, th, val, rot=0.0, ycut=None, ycut_above=True):
    """Paint an elliptical annulus `th` mm thick, optionally open posteriorly."""
    if ax - th <= 0.05 or ay - th <= 0.05:
        return
    sl = _window(cx, cy, ax, ay, rot)
    if sl is None:
        return
    m = (_r2(sl, cx, cy, ax, ay, rot) <= 1.0) & (
        _r2(sl, cx, cy, ax - th, ay - th, rot) > 1.0
    )
    if ycut is not None:
        m &= (Y_MM[sl] < ycut) if ycut_above else (Y_MM[sl] > ycut)
    img[sl][m] = val


def _mask_ellipse(cx, cy, ax, ay, rot=0.0):
    """Full-frame boolean mask (used sparingly, e.g. for the tumour)."""
    out = np.zeros((ROWS, COLS), dtype=bool)
    if ax <= 0.05 or ay <= 0.05:
        return out
    sl = _window(cx, cy, ax, ay, rot)
    if sl is None:
        return out
    out[sl] = _r2(sl, cx, cy, ax, ay, rot) <= 1.0
    return out


# --------------------------------------------------------------------------- #
# anatomy parameters as functions of zz
# --------------------------------------------------------------------------- #

def body_params(zz):
    """Outer skin ellipse: shoulders inferiorly, face/skull base superiorly.

    Sized so the patient spans ~76 % of the 230.4 mm FOV at its widest (the
    supraclavicular slices) without ever clipping the frame.  Only the soft
    tissue mantle is scaled here - every internal structure keeps its own
    millimetre dimensions.
    """
    zs = [0, 15, 30, 55, 90, 105, 125, 150, 179]
    a = _lerp(zz, zs, [88, 84, 78, 71, 69, 70, 72, 76, 80])
    b = _lerp(zz, zs, [64, 62, 58, 55, 54, 56, 60, 65, 70])
    cy = _lerp(zz, zs, [3.0, 1.0, -1.0, -2.0, -4.0, -7.0, -12.0, -18.0, -23.0])
    return a, b, cy


def airway_params(zz):
    cy = _lerp(zz, [0, 40, 60, 80, 95, 120, 150, 179],
               [-27.0, -27.0, -26.0, -25.0, -24.0, -23.0, -20.0, -16.0])
    zs = [0, 30, 45, 54, 56, 58, 62, 64, 66, 75, 85, 95, 110, 130, 150, 165, 179]
    ax = [9.5, 9.5, 8.6, 8.0, 5.0, 4.0, 4.0, 5.5, 8.0, 10.0, 11.0,
          12.0, 13.0, 13.0, 11.0, 9.0, 8.0]
    ay = [9.0, 9.0, 8.6, 8.0, 5.0, 4.0, 4.0, 5.5, 7.0, 8.0, 7.0,
          6.0, 7.0, 7.0, 6.5, 7.0, 7.5]
    return cy, _lerp(zz, zs, ax), _lerp(zz, zs, ay)


def spine_params(zz):
    vb_cy = _lerp(zz, [0, 40, 90, 140, 179], [7.0, 5.0, 3.0, 1.0, -1.0])
    vb_r = _lerp(zz, [0, 60, 120, 179], [14.5, 13.0, 12.2, 12.0])
    canal_cy = vb_cy + vb_r + 8.5
    return vb_cy, vb_r, canal_cy


def carotid_center(zz, side):
    """side = -1 for patient right (negative x), +1 for patient left."""
    return side * _lerp(zz, _VESSEL_Z, _CAR_X), _lerp(zz, _VESSEL_Z, _CAR_Y)


def ijv_center(zz, side):
    return side * _lerp(zz, _VESSEL_Z, _IJ_X), _lerp(zz, _VESSEL_Z, _IJ_Y)


def mandible_params(zz):
    cy = _lerp(zz, [108, 130, 155, 179], [-30.0, -31.0, -33.0, -34.0])
    ax = _lerp(zz, [108, 125, 145, 165, 179], [37.0, 41.0, 43.0, 42.0, 40.0])
    ay = _lerp(zz, [108, 125, 145, 165, 179], [29.0, 32.0, 34.0, 34.0, 33.0])
    return cy, ax, ay


# --------------------------------------------------------------------------- #
# slice construction
# --------------------------------------------------------------------------- #

def _paint_tumor(img, zz, collect=False):
    """Right palatine tonsil tumour: union of 4 overlapping ellipsoids."""
    mask = np.zeros((ROWS, COLS), dtype=bool) if collect else None
    any_painted = False
    for dx, dy, dz, ax, ay, az in TUMOR_LOBES:
        s = _xsec(zz, TUMOR_CZ + dz, az)
        if s <= 0.0:
            continue
        cx, cy = TUMOR_CX + dx, TUMOR_CY + dy
        sl = _window(cx, cy, ax * s, ay * s)
        if sl is None:
            continue
        m = _r2(sl, cx, cy, ax * s, ay * s) <= 1.0
        # mildly heterogeneous enhancement around +75 HU
        het = (6.0 * np.sin(0.55 * X_MM[sl] + 0.09 * zz)
               * np.cos(0.47 * Y_MM[sl] - 0.07 * zz)) + 3.0 * np.cos(0.31 * Y_MM[sl])
        vals = 75.0 + het
        img[sl][m] = vals[m]
        any_painted = True
        if collect:
            mask[sl] |= m
    return mask if any_painted or not collect else mask


def build_slice(zz: float, rng: np.random.Generator, collect_tumor=False):
    """Return (HU image float32, tumour mask or None) for reference position zz."""
    img = np.full((ROWS, COLS), AIR, dtype=np.float32)

    body_a, body_b, body_cy = body_params(zz)
    aw_cy, aw_ax, aw_ay = airway_params(zz)
    vb_cy, vb_r, canal_cy = spine_params(zz)

    # ---- soft tissue envelope ------------------------------------------- #
    _fill(img, 0.0, body_cy, body_a, body_b, -100.0)                 # subcut fat
    _fill(img, 0.0, body_cy - 4.5, body_a - 7.5, body_b - 7.5, 42.0)  # deep tissue
    _ring(img, 0.0, body_cy, body_a, body_b, 1.6, 40.0)               # skin rim

    # ---- shoulders / upper mediastinum ---------------------------------- #
    lung = _bump(zz, 0, 9, 5.0)
    if lung > 0:
        for side in (-1, 1):
            _fill(img, side * 50.0, 6.0, 17.0 * lung, 19.0 * lung, -870.0)
    clav = _bump(zz, 0, 15, 4.0)
    if clav > 0:
        for side in (-1, 1):
            _fill(img, side * 57.0, -29.0, 9.5 * clav, 5.5 * clav, 950.0,
                  rot=side * 0.35)
            _fill(img, side * 57.0, -29.0, 6.0 * clav, 2.8 * clav, 260.0,
                  rot=side * 0.35)
    stern = _bump(zz, 0, 8, 4.0)
    if stern > 0:
        _fill(img, 0.0, body_cy - body_b + 11.0, 15.0 * stern, 5.0 * stern, 720.0)

    # ---- muscle compartments -------------------------------------------- #
    # posterior paraspinal / trapezius sheet
    _fill(img, 0.0, vb_cy + 24.0, min(44.0, body_a - 10.0), 17.0, 52.0)
    for side in (-1, 1):
        _fill(img, side * 18.0, vb_cy + 21.0, 13.0, 11.0, 55.0)        # paraspinal
        _fill(img, side * 29.0, vb_cy + 5.0, 9.5, 8.5, 50.0)           # scalene
    scm = _bump(zz, 0, 148, 12.0)
    if scm > 0:
        for side in (-1, 1):
            _fill(img, side * 37.0, -10.0, 14.0 * scm, 5.8, 52.0, rot=side * -1.01)
    strap = _bump(zz, 0, 92, 8.0)
    if strap > 0:
        for side in (-1, 1):
            _fill(img, side * 7.0, aw_cy - 11.0, 6.0, 3.6 * strap, 52.0)

    # ---- glands ---------------------------------------------------------- #
    par = _bump(zz, 140, 179, 8.0)
    if par > 0:
        for side in (-1, 1):
            _fill(img, side * 44.0, 2.0, 11.0 * par, 14.0 * par, 15.0)
    smg = _bump(zz, 93, 113, 5.0)
    if smg > 0:
        for side in (-1, 1):
            _fill(img, side * 27.0, -24.0, 9.5 * smg, 8.5 * smg, 70.0)
    thy = _bump(zz, 19, 46, 5.0)
    if thy > 0:
        for side in (-1, 1):
            _fill(img, side * 15.5, aw_cy + 3.0, 8.0 * thy, 10.5 * thy, 120.0,
                  rot=side * 0.5)
        _fill(img, 0.0, aw_cy - 9.5, 13.0, 2.4 * thy, 118.0)           # isthmus

    # ---- cervical spine --------------------------------------------------- #
    is_disc = ((zz - 6.0) % 18.0) < 4.5
    if is_disc:
        _fill(img, 0.0, vb_cy, vb_r, vb_r * 0.92, 90.0)
    else:
        _fill(img, 0.0, vb_cy, vb_r, vb_r * 0.92, 700.0)
        _fill(img, 0.0, vb_cy, vb_r - 1.8, vb_r * 0.92 - 1.8, 250.0)
    # transverse processes + foramina transversaria with vertebral arteries
    for side in (-1, 1):
        _fill(img, side * (vb_r + 4.5), vb_cy + 2.0, 8.0, 5.0, 620.0)
        _fill(img, side * (vb_r + 4.0), vb_cy + 2.0, 2.0, 2.0, 235.0)
    # posterior arch + canal + cord
    _ring(img, 0.0, canal_cy, 10.8, 10.2, 3.6, 660.0)
    _fill(img, 0.0, canal_cy + 10.5, 4.0, 7.0, 610.0)                  # spinous
    _fill(img, 0.0, canal_cy, 7.2, 6.6, 4.0)                           # CSF
    _fill(img, 0.0, canal_cy, 5.0, 4.6, 35.0)                          # cord

    # ---- tumour (before vessels / airway so they cut into it) ------------- #
    tumor_mask = _paint_tumor(img, zz, collect=collect_tumor)
    snap = img.copy() if collect_tumor else None

    # ---- lymph nodes ------------------------------------------------------ #
    # right level II necrotic node, posterolateral to the right IJV
    s = _xsec(zz, 105.0, 10.0)
    if s > 0:
        _fill(img, -38.0, 3.0, 11.0 * s, 8.0 * s, 95.0)                # rim
        si = _xsec(zz, 105.0, 7.5)
        if si > 0:
            _fill(img, -38.0, 3.0, 8.5 * si, 5.5 * si, 22.0)           # necrosis
    for ncx, ncy, ncz in ((34.0, -2.0, 110.0), (-33.0, 2.0, 70.0), (31.0, -4.0, 58.0)):
        s = _xsec(zz, ncz, 5.0)
        if s > 0:
            _fill(img, ncx, ncy, 5.0 * s, 5.0 * s, 60.0)

    # ---- laryngeal skeleton ----------------------------------------------- #
    cric = _bump(zz, 44, 55, 3.0)
    if cric > 0:
        _ring(img, 0.0, aw_cy, 13.5 * cric, 12.5 * cric, 3.0, 280.0)
        _fill(img, 0.0, aw_cy + 10.5, 9.0 * cric, 4.5 * cric, 285.0)
    thyc = _bump(zz, 56, 85, 4.0)
    if thyc > 0:
        calc = 300.0 + 220.0 * max(0.0, math.sin(0.23 * zz))
        _ring(img, 0.0, aw_cy + 1.0, 19.0 * thyc, 17.0 * thyc, 3.4, calc,
              ycut=aw_cy + 8.0)
    hyo = _bump(zz, 87, 93, 2.5)
    if hyo > 0:
        _ring(img, 0.0, aw_cy - 3.0, 20.0 * hyo, 16.0 * hyo, 3.2, 600.0,
              ycut=aw_cy - 1.0)

    # ---- mandible / teeth / hard palate ----------------------------------- #
    if zz >= 106.0:
        m_cy, m_ax, m_ay = mandible_params(zz)
        g = _bump(zz, 108, 179, 4.0)
        m_ax *= g
        m_ay *= g
        if m_ax > 12.0:
            th = 8.0
            ycut = m_cy + m_ay * 0.35
            _ring(img, 0.0, m_cy, m_ax, m_ay, th, 1200.0, ycut=ycut)
            _ring(img, 0.0, m_cy, m_ax - 2.4, m_ay - 2.4, th - 4.8, 300.0, ycut=ycut)
            # rami rising posteriorly -> condyles
            ram = _bump(zz, 118, 179, 6.0)
            if ram > 0:
                rx = _lerp(zz, [118, 150, 179], [m_ax - 5.0, m_ax - 7.0, m_ax - 10.0])
                ry = ycut + _lerp(zz, [118, 150, 179], [4.0, 9.0, 14.0])
                rw = _lerp(zz, [118, 165, 179], [5.2, 5.8, 7.0]) * ram
                rh = _lerp(zz, [118, 165, 179], [11.0, 10.0, 7.5]) * ram
                for side in (-1, 1):
                    _fill(img, side * rx, ry, rw, rh, 1200.0)
                    _fill(img, side * rx, ry, max(0.5, rw - 2.6),
                          max(0.5, rh - 2.6), 300.0)
            # alveolar ridge teeth on the top ~15 slices
            if zz >= 164.0:
                ta, tb = m_ax - 5.0, m_ay - 5.0
                for t in np.linspace(-1.15, 1.15, 11):
                    _fill(img, float(ta * math.sin(t)),
                          float(m_cy - tb * math.cos(t)), 2.7, 2.7, 1800.0)
            # hard palate: thin plate on the top 5 slices
            if zz >= 174.0:
                sl = _window(0.0, m_cy + 9.0, 24.0, 17.0)
                if sl is not None:
                    m = (_r2(sl, 0.0, m_cy + 9.0, 24.0, 17.0) <= 1.0) & \
                        (Y_MM[sl] < m_cy + 17.0)
                    img[sl][m] = 900.0

    # ---- vessels (drawn after the tumour: encasement carves into it) ------ #
    for side in (-1, 1):
        cx, cy = carotid_center(zz, side)
        r = CAROTID_R + 0.5 * max(0.0, (80.0 - zz) / 80.0) + 1.0 * _bump(zz, 77, 84, 3.0)
        _fill(img, cx, cy, r, r, 280.0)
        if zz > 80.0:                                    # ECA, anteromedial
            sep = min(1.0, (zz - 80.0) / 18.0) * 7.5
            _fill(img, cx - side * 0.55 * sep, cy - 0.85 * sep, 2.2, 2.2, 280.0)
        jx, jy = ijv_center(zz, side)
        jr = (6.0 if side < 0 else 5.0) + 0.8 * _bump(zz, 150, 179, 10.0)
        _fill(img, jx, jy, jr, jr * 0.92, 200.0)

    # ---- airway last: the lumen always stays air -------------------------- #
    indent = _bump(zz, 100, 132, 6.0)                    # tumour indents the wall
    acx = 2.6 * indent
    ax_med = aw_ax
    ax_right = aw_ax * (1.0 - 0.34 * indent)
    sl = _window(acx, aw_cy, max(ax_med, ax_right), aw_ay)
    if sl is not None:
        dx = X_MM[sl] - acx
        dy = Y_MM[sl] - aw_cy
        axmap = np.where(dx < 0.0, ax_right, ax_med).astype(np.float32)
        img[sl][((dx / axmap) ** 2 + (dy / aw_ay) ** 2) <= 1.0] = AIR
    # pharyngeal mucosa is not perfectly smooth
    if 95.0 <= zz <= 150.0:
        _fill(img, acx, aw_cy - aw_ay * 0.55, aw_ax * 0.35, aw_ay * 0.3, AIR)

    # only voxels that survived later structures (vessels, airway) are tumour
    if collect_tumor:
        tumor_mask &= (img == snap)

    # ---- safety net: nothing may protrude through the skin ---------------- #
    inside = _mask_ellipse(0.0, body_cy, body_a, body_b)
    img[~inside] = AIR
    _ring(img, 0.0, body_cy, body_a, body_b, 1.6, 40.0)

    # ---- realism: blur then noise ----------------------------------------- #
    img = ndimage.gaussian_filter(img, sigma=0.6, mode="nearest")
    noise = rng.normal(0.0, 1.0, size=img.shape).astype(np.float32)
    noise *= np.where(inside, 12.0, 5.0).astype(np.float32)
    img += noise
    np.clip(img, -1024.0, 3500.0, out=img)
    return img, tumor_mask


# --------------------------------------------------------------------------- #
# carotid contact-angle measurement
# --------------------------------------------------------------------------- #

def carotid_contact_angle(tumor_mask, zz, tol_mm=1.0, n=1440):
    """Degrees of the right ICA circumference within `tol_mm` of tumour voxels."""
    if tumor_mask is None or not tumor_mask.any():
        return 0.0
    cx, cy = carotid_center(zz, -1)          # patient right
    dist = ndimage.distance_transform_edt(~tumor_mask, sampling=(PS, PS))
    th = np.linspace(0.0, 2.0 * np.pi, n, endpoint=False)
    px = cx + CAROTID_R * np.cos(th)
    py = cy + CAROTID_R * np.sin(th)
    jj = np.clip(np.rint(px / PS + (COLS - 1) / 2.0).astype(int), 0, COLS - 1)
    ii = np.clip(np.rint(py / PS + (ROWS - 1) / 2.0).astype(int), 0, ROWS - 1)
    return float((dist[ii, jj] <= tol_mm).mean() * 360.0)


# --------------------------------------------------------------------------- #
# DICOM output
# --------------------------------------------------------------------------- #

def _uid(seed, *parts):
    return generate_uid(prefix=UID_ROOT,
                        entropy_srcs=[UID_NAMESPACE, str(seed)]
                        + [str(p) for p in parts])


def _make_dataset(pix, k, n_slices, uids, now):
    z = float(k) * SPACING_BETWEEN - (n_slices - 1) * SPACING_BETWEEN / 2.0
    sop = uids["sop"][k]

    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = IMPL_CLASS_UID
    meta.ImplementationVersionName = "HNRAD_PHANTOM_1"

    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\x00" * 128)
    ds.SpecificCharacterSet = "ISO_IR 100"
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = sop
    ds.ImageType = ["DERIVED", "SECONDARY", "AXIAL"]

    # patient / study / series
    ds.PatientName = "PHANTOM^NECK"
    ds.PatientID = "PHANTOM001"
    ds.PatientBirthDate = "19700101"
    ds.PatientSex = "O"
    ds.PatientPosition = "HFS"
    ds.StudyInstanceUID = uids["study"]
    ds.SeriesInstanceUID = uids["series"]
    ds.FrameOfReferenceUID = uids["frame"]
    ds.StudyID = "1"
    ds.AccessionNumber = "PHANTOM001"
    ds.StudyDate = now["date"]
    ds.StudyTime = now["time"]
    ds.SeriesDate = now["date"]
    ds.SeriesTime = now["time"]
    ds.ContentDate = now["date"]
    ds.ContentTime = now["time"]
    ds.AcquisitionDate = now["date"]
    ds.AcquisitionTime = now["time"]
    ds.StudyDescription = "CT NECK W CONTRAST (SYNTHETIC)"
    ds.SeriesDescription = "AX SOFT TISSUE 1.0mm (SYNTHETIC)"
    ds.Modality = "CT"
    ds.SeriesNumber = 2
    ds.InstanceNumber = k + 1
    ds.AcquisitionNumber = 1
    ds.BodyPartExamined = "NECK"
    ds.Manufacturer = "HNRad Phantom"
    ds.ManufacturerModelName = "SyntheticNeck"
    ds.InstitutionName = "HNRad Synthetic Data"
    ds.ReferringPhysicianName = ""
    ds.ProtocolName = "NECK W CONTRAST"
    ds.ContrastBolusAgent = "SYNTHETIC IODINATED CONTRAST"

    # acquisition
    ds.KVP = 120
    ds.XRayTubeCurrent = 250
    ds.ExposureTime = 500
    ds.Exposure = 125
    ds.ConvolutionKernel = "B30f"
    ds.PatientOrientation = ["L", "P"]

    # geometry
    ds.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    ds.ImagePositionPatient = [float(_XS[0]), float(_YS[0]), z]
    ds.SliceLocation = z
    ds.SliceThickness = SLICE_THICKNESS
    ds.SpacingBetweenSlices = SPACING_BETWEEN
    ds.PixelSpacing = [PS, PS]

    # pixels
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows = ROWS
    ds.Columns = COLS
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 1
    ds.RescaleIntercept = 0
    ds.RescaleSlope = 1
    ds.RescaleType = "HU"
    ds.WindowCenter = 40
    ds.WindowWidth = 350
    ds.PixelData = pix.tobytes()

    # synthetic-data provenance
    ds.ImageComments = SYNTHETIC_NOTE
    ds.DerivationDescription = SYNTHETIC_NOTE
    ds.PatientIdentityRemoved = "YES"
    ds.DeidentificationMethod = "SYNTHETIC DATA - NO REAL PATIENT INVOLVED"
    block = ds.private_block(PRIVATE_GROUP, PRIVATE_CREATOR, create=True)
    block.add_new(0x01, "LO", SYNTHETIC_NOTE)
    block.add_new(0x02, "LO", "hnrad.phantom")
    return ds


# --------------------------------------------------------------------------- #
# generation
# --------------------------------------------------------------------------- #

def generate(out_dir, n_slices=DEFAULT_SLICES, seed=7, progress=True):
    """Build the phantom series. Returns a dict with the run summary."""
    t0 = time.time()
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("IMG_*.dcm"):                # keep re-runs idempotent
        stale.unlink()

    uids = {
        "study": _uid(seed, "study"),
        "series": _uid(seed, "series"),
        "frame": _uid(seed, "frame"),
        "sop": [_uid(seed, "sop", k) for k in range(n_slices)],
    }
    today = datetime.datetime.now()
    now = {"date": today.strftime("%Y%m%d"), "time": today.strftime("%H%M%S")}

    # slice whose zz is nearest the tumour centre -> contact-angle measurement
    zz_of = (lambda k: (k / (n_slices - 1)) * ZREF_MAX) if n_slices > 1 else (lambda k: 90.0)
    k_tumor = int(round(min(range(n_slices), key=lambda k: abs(zz_of(k) - TUMOR_CZ))))

    angle = 0.0
    files = []
    for k in range(n_slices):
        zz = zz_of(k)
        rng = np.random.default_rng((int(seed) * 100003 + k) & 0xFFFFFFFF)
        img, tmask = build_slice(zz, rng, collect_tumor=(k == k_tumor))
        if k == k_tumor:
            angle = carotid_contact_angle(tmask, zz)
        pix = np.rint(img).astype(np.int16)
        ds = _make_dataset(pix, k, n_slices, uids, now)
        path = out / f"IMG_{k + 1:04d}.dcm"
        ds.save_as(str(path), enforce_file_format=True)
        files.append(path)
        if progress and n_slices >= 20 and (k + 1) % 30 == 0:
            print(f"  ... {k + 1}/{n_slices} slices", flush=True)

    return {
        "out_dir": str(out.resolve()),
        "n_files": len(files),
        "seconds": time.time() - t0,
        "contact_angle_deg": angle,
        "tumor_slice_index": k_tumor,
        "study_uid": uids["study"],
        "series_uid": uids["series"],
        "frame_uid": uids["frame"],
    }


# --------------------------------------------------------------------------- #
# validation
# --------------------------------------------------------------------------- #

def validate(out_dir, n_slices):
    """Re-read the series and assert geometry / dtype / SimpleITK loadability."""
    out = Path(out_dir)
    files = sorted(out.glob("IMG_*.dcm"))
    assert len(files) == n_slices, f"expected {n_slices} files, found {len(files)}"

    picks = [0, n_slices // 2, n_slices - 1]
    series_uid = frame_uid = study_uid = None
    zs = []
    for k in picks:
        ds = pydicom.dcmread(str(files[k]))
        assert ds.Rows == ROWS and ds.Columns == COLS
        assert ds.Modality == "CT"
        assert str(ds.SOPClassUID) == CTImageStorage
        assert str(ds.file_meta.TransferSyntaxUID) == ExplicitVRLittleEndian
        assert ds.BitsAllocated == 16 and ds.BitsStored == 16 and ds.HighBit == 15
        assert ds.PixelRepresentation == 1
        assert float(ds.RescaleIntercept) == 0.0 and float(ds.RescaleSlope) == 1.0
        assert [float(v) for v in ds.PixelSpacing] == [PS, PS]
        assert float(ds.SliceThickness) == SLICE_THICKNESS
        assert float(ds.SpacingBetweenSlices) == SPACING_BETWEEN
        assert [float(v) for v in ds.ImageOrientationPatient] == [1, 0, 0, 0, 1, 0]
        assert ds.InstanceNumber == k + 1
        assert ds.PatientName == "PHANTOM^NECK" and ds.PatientID == "PHANTOM001"
        assert ds.SeriesNumber == 2 and ds.BodyPartExamined == "NECK"
        assert int(ds.WindowCenter) == 40 and int(ds.WindowWidth) == 350
        assert "SYNTHETIC" in str(ds.ImageComments)
        arr = ds.pixel_array
        assert arr.dtype == np.int16, f"dtype {arr.dtype}"
        assert arr.shape == (ROWS, COLS)
        assert arr.min() <= -900, f"no air in slice {k} (min {arr.min()})"
        ipp = [float(v) for v in ds.ImagePositionPatient]
        assert abs(ipp[0] - float(_XS[0])) < 1e-4 and abs(ipp[1] - float(_YS[0])) < 1e-4
        zs.append(ipp[2])
        series_uid = series_uid or str(ds.SeriesInstanceUID)
        frame_uid = frame_uid or str(ds.FrameOfReferenceUID)
        study_uid = study_uid or str(ds.StudyInstanceUID)
        assert str(ds.SeriesInstanceUID) == series_uid
        assert str(ds.FrameOfReferenceUID) == frame_uid
        assert str(ds.StudyInstanceUID) == study_uid
    assert zs[0] < zs[1] < zs[2], f"z must increase superiorly: {zs}"
    assert abs((zs[2] - zs[0]) - (n_slices - 1) * SPACING_BETWEEN) < 1e-4

    import SimpleITK as sitk
    names = sitk.ImageSeriesReader.GetGDCMSeriesFileNames(str(out), series_uid)
    assert len(names) == n_slices, f"SimpleITK found {len(names)} files"
    reader = sitk.ImageSeriesReader()
    reader.SetFileNames(names)
    vol = reader.Execute()
    assert vol.GetSize() == (COLS, ROWS, n_slices), f"size {vol.GetSize()}"
    sp = vol.GetSpacing()
    assert abs(sp[0] - PS) < 1e-4 and abs(sp[1] - PS) < 1e-4 and abs(sp[2] - 1.0) < 1e-4, \
        f"spacing {sp}"
    a = sitk.GetArrayFromImage(vol)
    assert a.dtype == np.int16
    assert a.min() <= -900 and a.max() >= 900, f"HU range {a.min()}..{a.max()}"
    return {"size": vol.GetSize(), "spacing": sp, "origin": vol.GetOrigin(),
            "hu_range": (int(a.min()), int(a.max())), "series_uid": series_uid}


# --------------------------------------------------------------------------- #
# preview PNGs
# --------------------------------------------------------------------------- #

def write_previews(out_dir, png_dir, n_slices, center=40.0, width=350.0):
    """Save axial (mid tumour), mid-sagittal and mid-coronal PNGs at W350/L40."""
    from PIL import Image

    out = Path(out_dir)
    png_dir = Path(png_dir)
    png_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(out.glob("IMG_*.dcm"))
    vol = np.stack([pydicom.dcmread(str(f)).pixel_array for f in files])  # (z,y,x)

    def to_png(a2d, path, flip_v=False, zscale=1.0):
        lo, hi = center - width / 2.0, center + width / 2.0
        g = np.clip((a2d.astype(np.float32) - lo) / (hi - lo), 0, 1) * 255.0
        g = g.astype(np.uint8)
        if flip_v:
            g = g[::-1]
        im = Image.fromarray(g)
        if zscale != 1.0:                      # make the MPR pixels isotropic
            im = im.resize((g.shape[1], max(1, int(round(g.shape[0] * zscale)))),
                           Image.BILINEAR)
        im.save(path)
        return path

    zz_of = (lambda k: (k / (n_slices - 1)) * ZREF_MAX) if n_slices > 1 else (lambda k: 90.0)
    k_t = int(round(min(range(n_slices), key=lambda k: abs(zz_of(k) - TUMOR_CZ))))

    zsc = SPACING_BETWEEN / PS
    paths = {}
    # axial through the tumour centre: image right = patient LEFT, top = anterior
    paths["axial"] = to_png(vol[k_t], png_dir / "phantom_preview_axial.png")
    # mid-sagittal: rows = z (reversed -> superior up), cols = y (anterior left)
    paths["sagittal"] = to_png(vol[:, :, COLS // 2],
                               png_dir / "phantom_preview_sagittal.png",
                               flip_v=True, zscale=zsc)
    # coronal through the carotid / tumour plane (y = -12 mm)
    row = int(round(-12.0 / PS + (ROWS - 1) / 2.0))
    paths["coronal"] = to_png(vol[:, row, :],
                              png_dir / "phantom_preview_coronal.png",
                              flip_v=True, zscale=zsc)
    return {k: str(v) for k, v in paths.items()}


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="python -m hnrad.phantom",
        description="Write a synthetic contrast-enhanced neck CT DICOM series.")
    ap.add_argument("--out", required=True, help="output directory for the series")
    ap.add_argument("--slices", type=int, default=DEFAULT_SLICES)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--no-validate", action="store_true")
    ap.add_argument("--previews", metavar="DIR", default=None,
                    help="also write phantom_preview_{axial,sagittal,coronal}.png here")
    args = ap.parse_args(argv)

    if args.slices < 2:
        ap.error("--slices must be >= 2")

    info = generate(args.out, n_slices=args.slices, seed=args.seed)
    if not args.no_validate:
        v = validate(info["out_dir"], args.slices)
        info["validation"] = v
        print(f"validation OK: size={v['size']} spacing="
              f"({v['spacing'][0]:.3f}, {v['spacing'][1]:.3f}, {v['spacing'][2]:.3f}) "
              f"HU {v['hu_range'][0]}..{v['hu_range'][1]}")
    if args.previews:
        info["previews"] = write_previews(info["out_dir"], args.previews, args.slices)
        for k, p in info["previews"].items():
            print(f"preview {k}: {p}")

    print(f"output folder : {info['out_dir']}")
    print(f"files written : {info['n_files']}")
    print(f"carotid contact angle (right ICA, slice {info['tumor_slice_index']}): "
          f"{info['contact_angle_deg']:.1f} deg")
    print(f"elapsed       : {info['seconds']:.1f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
