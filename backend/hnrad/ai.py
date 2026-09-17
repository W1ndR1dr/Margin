"""AI segmentation: TotalSegmentator and the HNLNL nodal-level model.

**No part of this module imports torch, nnU-Net or TotalSegmentator.**  The
FastAPI process stays a plain 3.13 app; every model runs as a subprocess of a
separate inference interpreter (``%LOCALAPPDATA%\\HNRad\\venv-ai``) driving the
scripts in ``backend/ai/``.  The two talk over a one-JSON-object-per-line
protocol on stdout (see ``backend/ai/README.md``).

Job model
---------
Jobs run **one at a time** on a single background worker thread.  A job

1. loads the cached :class:`~hnrad.analysis.SeriesVolume` (never re-reading
   DICOM if the viewer already touched the series),
2. writes it to NIfTI with the correct LPS -> RAS affine (:func:`export_nifti`),
3. runs the model as a subprocess, streaming progress,
4. copies the resulting multi-label volume into
   ``%LOCALAPPDATA%\\HNRad\\ai-cache\\<series_uid>\\<model>\\`` so the same
   request later is instant, and
5. registers every structure in the existing label store so that
   ``/api/analysis/label/{id}/mask``, ``/mesh``, ``/stats`` and ``/distance``
   work on AI output with no changes at all.

Label registration is **lazy**.  A ``headneck_muscles`` + ``total`` run yields
~40 structures; at 512x512x180 that is ~2 GB of uint8 masks, and the label
store's LRU only holds 20.  So the job hands out a stable ``label_id`` per
structure up front and materialises the mask from the cached NIfTI on first
use (:func:`rehydrate_label`), which takes well under a second.
"""

from __future__ import annotations

import colorsys
import hashlib
import json
import logging
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Sequence

import numpy as np

from . import config
from .analysis import AnalysisError, SeriesVolume

log = logging.getLogger("hnrad.ai")

__all__ = [
    "AiError",
    "MODELS",
    "TOTALSEG_TASKS",
    "HNLNL_LABELS",
    "venv_python",
    "models_root",
    "totalseg_home",
    "hnlnl_root",
    "cache_root",
    "nifti_affine_ras",
    "export_nifti",
    "color_for",
    "model_catalog",
    "JOBS",
    "rehydrate_label",
    "reset",
]

BACKEND_DIR = Path(__file__).resolve().parent.parent          # .../backend
AI_DIR = BACKEND_DIR / "ai"

#: How many log lines a job keeps for ``log_tail``.
LOG_TAIL = 80

#: How many AI structure references stay resolvable (they are tiny: no masks).
LABEL_REF_LIMIT = 4000


def default_threads() -> int:
    """Threads handed to the inference process.

    The reference box is an i5-14500T: 14 physical cores (6 P + 8 E) exposed
    as 20 logical.  Handing torch all 20 oversubscribes the P-cores' SMT
    siblings and measurably hurts, so cap at the physical count and leave two
    for the app and the OS.  ``HNRAD_AI_THREADS`` overrides.
    """
    env = os.environ.get("HNRAD_AI_THREADS")
    if env:
        try:
            return max(1, int(env))
        except ValueError:
            pass
    logical = os.cpu_count() or 4
    return max(1, min(logical - 2, 12))


DEFAULT_THREADS = default_threads()


class AiError(ValueError):
    """Bad AI request (maps to HTTP 400)."""


# --------------------------------------------------------------------------
# locations
# --------------------------------------------------------------------------

def venv_python() -> Path:
    """The inference interpreter.  ``HNRAD_AI_PYTHON`` overrides (tests do)."""
    env = os.environ.get("HNRAD_AI_PYTHON")
    if env:
        return Path(env)
    return config.data_root() / "venv-ai" / "Scripts" / "python.exe"


def models_root() -> Path:
    env = os.environ.get("HNRAD_MODELS_ROOT")
    return Path(env) if env else config.data_root() / "models"


def totalseg_home() -> Path:
    """``TOTALSEG_HOME_DIR`` -- where the pre-staged nnU-Net weights live."""
    env = os.environ.get("TOTALSEG_HOME_DIR")
    return Path(env) if env else models_root() / "totalseg"


def hnlnl_root() -> Path:
    return models_root() / "hnlnl"


def cache_root() -> Path:
    env = os.environ.get("HNRAD_AI_CACHE")
    return Path(env) if env else config.data_root() / "ai-cache"


# --------------------------------------------------------------------------
# model catalogue
# --------------------------------------------------------------------------

def _load_class_map() -> dict[str, Any]:
    path = AI_DIR / "class_map.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        log.warning("cannot read %s: %s", path, exc)
        return {"totalsegmentator_version": None, "tasks": {}}


_CLASS_MAP: Optional[dict[str, Any]] = None


def class_map() -> dict[str, Any]:
    """``backend/ai/class_map.json``, dumped from the installed package."""
    global _CLASS_MAP
    if _CLASS_MAP is None:
        _CLASS_MAP = _load_class_map()
    return _CLASS_MAP


#: The TotalSegmentator tasks Margin offers, in menu order.
TOTALSEG_TASKS = [
    "total",
    "headneck_bones_vessels",
    "head_glands_cavities",
    "headneck_muscles",
    "craniofacial_structures",
    "teeth",
]

#: The neck-relevant slice of the 117-class ``total`` model.  Running `total`
#: blind wants ~20 GB of RAM for the forward pass; naming the ROIs is not
#: optional on this box.
DEFAULT_ROI_SUBSET = [
    "thyroid_gland", "trachea", "esophagus", "skull", "brain", "spinal_cord",
    "common_carotid_artery_left", "common_carotid_artery_right",
    "subclavian_artery_left", "subclavian_artery_right",
    "brachiocephalic_trunk",
    "brachiocephalic_vein_left", "brachiocephalic_vein_right",
    "clavicula_left", "clavicula_right",
    "vertebrae_C1", "vertebrae_C2", "vertebrae_C3", "vertebrae_C4",
    "vertebrae_C5", "vertebrae_C6", "vertebrae_C7",
]

#: HNLNL label value -> level name.
#:
#: The *names and their order* are verbatim from the author's 3D Slicer review
#: module (``Blinded review module for 3DSlicer/HN_Lvl_Blinded_Review.py``,
#: ``self.LevelNameList``); the model itself reports label values 1..20
#: (``plans.pkl: all_classes``).  The 1-based alignment of the two lists is an
#: **inference**, corroborated by the author's own postprocessing script
#: (``Adjust3DCNNcontoursToCTslicePlaneOrientation.py``), whose
#: mutually-exclusive label groups -- [18,5]/[17,4], [5,7]/[4,6], [7,9]/[6,8],
#: [11,9,13]/[10,8,12], [14,1,2,3] -- only resolve into six correctly mirrored
#: left/right pairs plus a coherent VIa-vs-level-I group under this mapping.
#: See backend/ai/README.md.
HNLNL_LABELS: dict[int, str] = {
    1: "level_Ia",
    2: "level_Ib_left",
    3: "level_Ib_right",
    4: "level_II_left",
    5: "level_II_right",
    6: "level_III_left",
    7: "level_III_right",
    8: "level_IVa_left",
    9: "level_IVa_right",
    10: "level_IVb_left",
    11: "level_IVb_right",
    12: "level_V_left",
    13: "level_V_right",
    14: "level_VIa",
    15: "level_VIb",
    16: "level_VIIa",
    17: "level_VIIb_left",
    18: "level_VIIb_right",
    19: "level_VIII_left",
    20: "level_VIII_right",
}

MODELS = ("totalseg", "hnlnl")


def _dataset_dirs_present(ids: Sequence[int]) -> tuple[bool, list[str]]:
    """Are all of these nnU-Net ``DatasetNNN_*`` folders staged?"""
    root = totalseg_home() / "nnunet" / "results"
    missing: list[str] = []
    if not root.is_dir():
        return False, ["Dataset%03d_*" % i for i in ids]
    have = {d.name for d in root.iterdir() if d.is_dir()}
    for i in ids:
        prefix = "Dataset{i:03d}_".format(i=int(i))
        if not any(n.startswith(prefix) for n in have):
            missing.append(prefix + "*")
    return not missing, missing


def hnlnl_checkpoint() -> Path:
    return (hnlnl_root() / "nnunet_v1_results" / "3d_fullres"
            / "Task110_HNLNFixed_MirrorBest" / "nnUNetTrainerV2__nnUNetPlansv2.1")


def model_catalog() -> dict[str, Any]:
    """Availability, licence and class list for every model and task."""
    cm = class_map()
    tasks_meta = cm.get("tasks", {})

    ts_tasks = []
    for name in TOTALSEG_TASKS:
        meta = tasks_meta.get(name, {})
        ids = list(meta.get("dataset_ids") or [])
        crop_ids = list(meta.get("crop_dataset_ids") or [])
        ok, missing = _dataset_dirs_present(ids + crop_ids)
        sub = meta.get("sub_modes") or {}
        fast_ids = list(sub.get("fast") or [])
        fast_ok = _dataset_dirs_present(fast_ids)[0] if fast_ids else False
        ts_tasks.append({
            "task": name,
            "weights_present": bool(ok),
            "missing_weights": missing,
            "n_classes": meta.get("n_classes"),
            "classes": meta.get("classes", {}),
            "dataset_ids": ids,
            "crop_from": meta.get("crop_from"),
            "crop_dataset_ids": crop_ids,
            "fast_allowed": bool(meta.get("fast_allowed", False)),
            "fast_weights_present": bool(fast_ok),
            "license": meta.get("license", "unknown"),
        })

    ckpt = hnlnl_checkpoint()
    hnlnl_ok = (ckpt / "plans.pkl").is_file() and (
        ckpt / "fold_0" / "model_final_checkpoint.model").is_file()

    return {
        "runtime": {
            "venv_python": str(venv_python()),
            "venv_present": venv_python().is_file(),
            "totalseg_home": str(totalseg_home()),
            "cache_root": str(cache_root()),
            "threads": default_threads(),
            "totalsegmentator_version": cm.get("totalsegmentator_version"),
        },
        "models": [
            {
                "model": "totalseg",
                "title": "TotalSegmentator",
                "available": venv_python().is_file() and any(
                    t["weights_present"] for t in ts_tasks),
                "license": "Apache-2.0 (code and weights) for every task Margin offers",
                "default_roi_subset": list(DEFAULT_ROI_SUBSET),
                "tasks": ts_tasks,
            },
            {
                "model": "hnlnl",
                "title": "HNLNL cervical nodal levels (20)",
                "available": venv_python().is_file() and hnlnl_ok,
                "weights_present": hnlnl_ok,
                "weights_dir": str(ckpt),
                "license": "CC0-1.0 (repository); nnU-Net runtime Apache-2.0",
                "source": "https://github.com/putzfn/HNLNL_autosegmentation_trained_models",
                "citation": ("Putz F et al., Deep learning for automatic head and neck "
                             "lymph node level delineation provides expert-level "
                             "accuracy. Front Oncol 2023 (PMID 36874135)."),
                "note": ("nnU-Net **v1** weights (Task110, nnUNetPlansv2.1). Margin runs "
                         "them with a self-contained Generic_UNet re-implementation in "
                         "backend/ai/run_hnlnl.py -- nnunetv2 cannot load this format."),
                "n_classes": len(HNLNL_LABELS),
                "classes": {str(k): v for k, v in sorted(HNLNL_LABELS.items())},
                "tasks": [],
            },
        ],
    }


# --------------------------------------------------------------------------
# colour palette
# --------------------------------------------------------------------------

_LATERAL = re.compile(r"_(left|right|l|r)$")

# (substring, RGB).  First match wins, so put the specific rules first.
_PALETTE: list[tuple[tuple[str, ...], tuple[int, int, int]]] = [
    # --- arteries: red -----------------------------------------------------
    (("carotid", "_artery", "artery_", "aorta", "brachiocephalic_trunk",
      "arterial", "alveolar_canal", "incisive_canal", "lingual_canal"),
     (208, 48, 48)),
    # --- veins: blue -------------------------------------------------------
    (("jugular", "_vein", "vein_", "vena", "sinus_cavernous"), (54, 96, 208)),
    # --- airway / air-filled spaces: cyan ----------------------------------
    (("trachea", "larynx_air", "airway", "bronch", "nasal_cavity",
      "sinus_maxillary", "sinus_frontal", "auditory_canal", "pharynx",
      "nasopharynx", "oropharynx", "hypopharynx", "lung_"), (64, 200, 216)),
    # --- cartilage: light grey --------------------------------------------
    (("cartilage", "cricoid", "arytenoid"), (196, 200, 206)),
    # --- teeth: near-white, slightly warm ---------------------------------
    (("incisor", "canine", "premolar", "molar", "teeth_", "crown", "bridge",
      "implant", "_pulp"), (238, 232, 214)),
    # --- bone: off-white ---------------------------------------------------
    (("vertebrae", "skull", "mandible", "maxilla", "jawbone", "hyoid",
      "clavicula", "scapula", "humerus", "rib_", "sternum", "zygomatic",
      "styloid", "hard_palate", "sacrum", "hip_", "femur", "bone"),
     (224, 219, 205)),
    # --- glands: yellow ----------------------------------------------------
    (("gland", "parotid", "submandibular", "sublingual", "thyroid_gland",
      "lacrimal", "pituitary", "thymus"), (226, 198, 58)),
    # --- muscles: rose -----------------------------------------------------
    (("sternocleidomastoid", "constrictor", "trapezius", "platysma",
      "scalene", "levator", "masseter", "pterygoid", "digastric",
      "sterno_thyroid", "thyrohyoid", "prevertebral", "muscle",
      "autochthon", "iliopsoas", "gluteus", "soft_palate"), (214, 122, 138)),
    # --- neural: pale violet ----------------------------------------------
    (("spinal_cord", "optic_nerve", "brain", "nerve", "eye_lens", "eye_"),
     (176, 150, 224)),
    # --- viscera: muted olive ---------------------------------------------
    (("esophagus", "stomach", "liver", "spleen", "pancreas", "kidney",
      "bowel", "colon", "duodenum", "bladder", "prostate", "heart",
      "gallbladder", "adrenal"), (150, 168, 110)),
    # --- outer envelope ----------------------------------------------------
    (("head", "body", "skin"), (150, 150, 150)),
]


def _jitter(rgb: tuple[int, int, int], key: str, span: int = 22) -> list[int]:
    """Nudge a base colour deterministically so siblings stay distinguishable.

    The key has any ``_left``/``_right`` suffix stripped first, so a bilateral
    pair gets *the same* colour -- they are the same structure.
    """
    digest = hashlib.sha256(key.encode("utf-8")).digest()
    h, l, s = colorsys.rgb_to_hls(*[c / 255.0 for c in rgb])
    l = min(0.92, max(0.14, l + (digest[0] / 255.0 - 0.5) * (span / 100.0)))
    h = (h + (digest[1] / 255.0 - 0.5) * 0.045) % 1.0
    r, g, b = colorsys.hls_to_rgb(h, l, s)
    return [int(round(r * 255)), int(round(g * 255)), int(round(b * 255))]


def color_for(name: str) -> list[int]:
    """A stable RGB for a structure name.

    Arteries red, veins blue, bone off-white, cartilage light grey, airway
    cyan, glands yellow, muscles rose; the 20 nodal levels get evenly spaced
    hues so adjacent levels never look alike.  Everything unrecognised falls
    back to a deterministic muted colour keyed on the name, so the palette
    never changes between runs or between processes.
    """
    key = str(name).lower()
    base = _LATERAL.sub("", key)

    # Nodal levels: a distinct hue per level, left/right sharing the hue.
    level_names = [v for _k, v in sorted(HNLNL_LABELS.items())]
    bases = []
    for v in level_names:
        b = _LATERAL.sub("", v.lower())
        if b not in bases:
            bases.append(b)
    if base in bases:
        idx = bases.index(base)
        hue = (idx / float(len(bases)) + 0.04) % 1.0
        r, g, b = colorsys.hls_to_rgb(hue, 0.58, 0.62)
        return [int(round(r * 255)), int(round(g * 255)), int(round(b * 255))]

    for needles, rgb in _PALETTE:
        if any(n in key for n in needles):
            return _jitter(rgb, base)

    # Unknown: a muted, deterministic colour rather than a random one.
    digest = hashlib.sha256(base.encode("utf-8")).digest()
    r, g, b = colorsys.hls_to_rgb(digest[0] / 255.0, 0.55, 0.38)
    return [int(round(r * 255)), int(round(g * 255)), int(round(b * 255))]


# --------------------------------------------------------------------------
# NIfTI export
# --------------------------------------------------------------------------

#: DICOM is LPS, NIfTI is RAS: negate x and y.
LPS_TO_RAS = np.asarray([-1.0, -1.0, 1.0])


def nifti_affine_ras(vol: SeriesVolume) -> np.ndarray:
    """The 4x4 NIfTI (``srow``) affine: voxel ``(i, j, k)`` -> RAS millimetres.

    ``i`` is the column index, ``j`` the row index and ``k`` the slice index,
    which is the index convention the whole Analysis API uses.  In patient
    LPS this module and ``segmentation.ijk_to_lps`` agree exactly::

        P_lps = origin + i*dx*row_dir + j*dy*col_dir + k*dz*slice_dir

    and NIfTI just wants the same thing with x and y negated.
    """
    dz, dy, dx = (float(s) for s in vol.spacing)
    aff = np.eye(4, dtype=np.float64)
    aff[:3, 0] = LPS_TO_RAS * np.asarray(vol.row_dir, dtype=np.float64) * dx
    aff[:3, 1] = LPS_TO_RAS * np.asarray(vol.col_dir, dtype=np.float64) * dy
    aff[:3, 2] = LPS_TO_RAS * np.asarray(vol.slice_dir, dtype=np.float64) * dz
    aff[:3, 3] = LPS_TO_RAS * np.asarray(vol.origin, dtype=np.float64)
    return aff


def apply_geometry(img, vol: SeriesVolume):
    """Stamp the series' LPS geometry onto a SimpleITK image, in place."""
    dz, dy, dx = (float(s) for s in vol.spacing)
    img.SetSpacing((dx, dy, dz))
    img.SetOrigin(tuple(float(v) for v in vol.origin))
    # SimpleITK's direction is row-major with the *columns* holding each index
    # axis' direction cosine, so column 0 = +i = row_dir.
    r, c, s = (np.asarray(v, dtype=np.float64) for v in
               (vol.row_dir, vol.col_dir, vol.slice_dir))
    img.SetDirection((r[0], c[0], s[0], r[1], c[1], s[1], r[2], c[2], s[2]))
    return img


def export_nifti(vol: SeriesVolume, path: Path) -> Path:
    """Write the cached HU volume as ``.nii.gz`` on the series' own grid.

    Stored as ``int16`` -- the DICOM storage type for CT, and what every
    nnU-Net CT model was trained on -- with explicit rounding rather than the
    C truncation a plain cast would do, so a series with a fractional
    ``RescaleSlope`` is off by at most half a Hounsfield unit.

    SimpleITK holds geometry in LPS and performs the LPS -> RAS flip itself
    when it writes NIfTI, so the file's ``srow`` matches
    :func:`nifti_affine_ras` exactly -- which is what the round-trip test
    asserts against the raw header bytes.
    """
    import SimpleITK as sitk

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.rint(np.clip(vol.hu, -32768.0, 32767.0)).astype(np.int16)
    img = sitk.GetImageFromArray(np.ascontiguousarray(data))
    apply_geometry(img, vol)
    sitk.WriteImage(img, str(path), True)
    return path


def read_multilabel(path: Path, vol: SeriesVolume) -> np.ndarray:
    """Read a segmentation written on this series' grid as ``(nz, ny, nx)``."""
    import SimpleITK as sitk

    img = sitk.ReadImage(str(path))
    arr = sitk.GetArrayFromImage(img)
    if tuple(arr.shape) != tuple(vol.hu.shape):
        raise AiError(
            "cached segmentation is {a} but the series is {b}; the cache is "
            "stale -- delete it and re-run".format(a=arr.shape, b=vol.hu.shape))
    return arr


# --------------------------------------------------------------------------
# volume loading (no FastAPI types in here)
# --------------------------------------------------------------------------

def load_volume(series_uid: str) -> SeriesVolume:
    from . import analysis, db

    db.ensure_db()
    with db.connect() as conn:
        if db.get_series(conn, series_uid) is None:
            raise AiError("unknown series_uid")
        rows = list(db.get_series_instances(conn, series_uid))
    if not rows:
        raise AiError("series has no instances")
    try:
        return analysis.load_series_volume(series_uid, rows)
    except AnalysisError as exc:
        raise AiError(str(exc)) from exc


# --------------------------------------------------------------------------
# lazy label references
# --------------------------------------------------------------------------

@dataclass
class LabelRef:
    """Enough to rebuild one structure's mask from the cached NIfTI."""

    label_id: str
    series_uid: str
    name: str
    label_value: int
    seg_path: Path
    color: list[int]
    model: str
    job_id: str
    n_voxels: int
    volume_ml: float

    def public(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "label_id": self.label_id,
            "label_value": int(self.label_value),
            "n_voxels": int(self.n_voxels),
            "volume_ml": float(self.volume_ml),
            "color": list(self.color),
        }


_refs: "OrderedDict[str, LabelRef]" = OrderedDict()
_refs_lock = threading.Lock()


def _remember(ref: LabelRef) -> None:
    with _refs_lock:
        _refs[ref.label_id] = ref
        _refs.move_to_end(ref.label_id)
        while len(_refs) > LABEL_REF_LIMIT:
            _refs.popitem(last=False)


def label_ref(label_id: str) -> Optional[LabelRef]:
    with _refs_lock:
        ref = _refs.get(label_id)
        if ref is not None:
            _refs.move_to_end(label_id)
        return ref


def rehydrate_label(label_id: str):
    """Materialise an AI structure into the label store, or return ``None``.

    ``app._label_or_404`` calls this when the in-memory LRU has evicted (or
    never held) the label, so an AI ``label_id`` stays valid for as long as
    the cached NIfTI exists rather than for 20 segmentations.
    """
    from . import segmentation

    ref = label_ref(label_id)
    if ref is None:
        return None
    if not Path(ref.seg_path).is_file():
        log.warning("label %s: cache file %s is gone", label_id, ref.seg_path)
        return None

    started = time.perf_counter()
    vol = load_volume(ref.series_uid)
    arr = read_multilabel(Path(ref.seg_path), vol)
    mask = (arr == int(ref.label_value)).astype(np.uint8)
    if not mask.any():
        return None
    label = segmentation.LABELS.put(
        ref.series_uid, mask,
        {"kind": "ai", "model": ref.model, "name": ref.name,
         "color": list(ref.color), "job_id": ref.job_id,
         "label_value": int(ref.label_value)},
        label_id=label_id,
    )
    log.info("rehydrated AI label %s (%s) in %.3fs",
             label_id, ref.name, time.perf_counter() - started)
    return label


# --------------------------------------------------------------------------
# cache
# --------------------------------------------------------------------------

def _variant(model: str, tasks: Sequence[str], roi_subset: Optional[Sequence[str]],
             fast: bool) -> str:
    """A short stable key for one particular request shape."""
    payload = json.dumps(
        {"model": model, "tasks": sorted(tasks),
         "roi": sorted(roi_subset) if roi_subset else None, "fast": bool(fast)},
        sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def cache_dir(series_uid: str, model: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", str(series_uid))[:128]
    return cache_root() / safe / model


# --------------------------------------------------------------------------
# jobs
# --------------------------------------------------------------------------

@dataclass
class Job:
    job_id: str
    series_uid: str
    model: str
    tasks: list[str]
    roi_subset: Optional[list[str]]
    fast: bool
    status: str = "queued"
    progress: float = 0.0
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    structures: Optional[list[dict[str, Any]]] = None
    error: Optional[str] = None
    cached: bool = False
    message: str = "queued"
    log: deque = field(default_factory=lambda: deque(maxlen=LOG_TAIL))
    _proc: Optional[subprocess.Popen] = None
    _cancelled: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def note(self, line: str) -> None:
        text = str(line).rstrip()
        if text:
            self.log.append(text)

    def public(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "job_id": self.job_id,
            "series_uid": self.series_uid,
            "model": self.model,
            "tasks": list(self.tasks),
            "roi_subset": list(self.roi_subset) if self.roi_subset else None,
            "fast": bool(self.fast),
            "status": self.status,
            "progress": round(float(self.progress), 4),
            "message": self.message,
            "cached": bool(self.cached),
            "created_at": float(self.created_at),
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "log_tail": list(self.log),
        }
        if self.structures is not None:
            out["structures"] = self.structures
        if self.error is not None:
            out["error"] = self.error
        return out


def build_command(job: Job, ct_path: Path, out_dir: Path) -> list[str]:
    """The inference-venv command line for a job.  Tests monkeypatch this."""
    py = venv_python()
    if job.model == "totalseg":
        cmd = [str(py), str(AI_DIR / "run_totalseg.py"),
               "--input", str(ct_path), "--out", str(out_dir),
               "--tasks", *job.tasks,
               "--threads", str(default_threads())]
        if job.roi_subset:
            cmd += ["--roi-subset", *job.roi_subset]
        if job.fast:
            cmd.append("--fast")
        return cmd
    if job.model == "hnlnl":
        cmd = [str(py), str(AI_DIR / "run_hnlnl.py"),
               "--input", str(ct_path), "--out", str(out_dir),
               "--weights", str(hnlnl_checkpoint()),
               "--threads", str(default_threads())]
        if job.fast:
            cmd.append("--fast")
        return cmd
    raise AiError("unknown model {m!r}".format(m=job.model))


def subprocess_env() -> dict[str, str]:
    env = dict(os.environ)
    env["TOTALSEG_HOME_DIR"] = str(totalseg_home())
    env["nnUNet_results"] = str(totalseg_home() / "nnunet" / "results")
    env.setdefault("nnUNet_raw", str(models_root() / "nnunet" / "raw"))
    env.setdefault("nnUNet_preprocessed", str(models_root() / "nnunet" / "preprocessed"))
    threads = default_threads()
    env["OMP_NUM_THREADS"] = str(threads)
    env["MKL_NUM_THREADS"] = str(threads)
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["nnUNet_compile"] = "f"
    return env


class JobManager:
    """A FIFO of segmentation jobs, one worker thread, one job at a time."""

    def __init__(self) -> None:
        self._jobs: "OrderedDict[str, Job]" = OrderedDict()
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._lock = threading.Lock()
        self._worker: Optional[threading.Thread] = None
        self.max_jobs = 100
        #: Tests turn this off and drive :meth:`run_job` themselves so a job's
        #: state machine can be stepped through deterministically.
        self.autostart = True

    # -- public API -------------------------------------------------------

    def submit(self, series_uid: str, model: str,
               tasks: Optional[Sequence[str]] = None,
               roi_subset: Optional[Sequence[str]] = None,
               fast: bool = False) -> Job:
        model = str(model)
        if model not in MODELS:
            raise AiError("model must be one of {m}".format(m=", ".join(MODELS)))

        if model == "totalseg":
            chosen = list(tasks) if tasks else ["headneck_bones_vessels"]
            unknown = [t for t in chosen if t not in TOTALSEG_TASKS]
            if unknown:
                raise AiError("unknown task(s): {u} (have: {h})".format(
                    u=", ".join(unknown), h=", ".join(TOTALSEG_TASKS)))
            roi = list(roi_subset) if roi_subset else (
                list(DEFAULT_ROI_SUBSET) if "total" in chosen else None)
        else:
            if tasks:
                raise AiError("the hnlnl model takes no tasks")
            chosen, roi = [], None

        job = Job(
            job_id=str(uuid.uuid4()),
            series_uid=str(series_uid),
            model=model,
            tasks=chosen,
            roi_subset=roi,
            fast=bool(fast),
        )
        with self._lock:
            self._jobs[job.job_id] = job
            self._jobs.move_to_end(job.job_id)
            while len(self._jobs) > self.max_jobs:
                oldest, victim = next(iter(self._jobs.items()))
                if victim.status in ("queued", "running"):
                    break
                self._jobs.pop(oldest)
        self._queue.put(job.job_id)
        self._ensure_worker()
        log.info("AI job %s queued: model=%s tasks=%s fast=%s series=%s",
                 job.job_id, model, chosen, fast, series_uid)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return list(self._jobs.values())[::-1]        # newest first

    def cancel(self, job_id: str) -> Optional[Job]:
        job = self.get(job_id)
        if job is None:
            return None
        with job._lock:
            if job.status in ("done", "error"):
                with self._lock:
                    self._jobs.pop(job_id, None)
                return job
            job._cancelled = True
            proc = job._proc
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except OSError:                                # pragma: no cover
                pass
        job.note("cancelled by client")
        return job

    # -- worker -----------------------------------------------------------

    def _ensure_worker(self) -> None:
        if not self.autostart:
            return
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                return
            self._worker = threading.Thread(
                target=self._run_forever, name="hnrad-ai-worker", daemon=True)
            self._worker.start()

    def _run_forever(self) -> None:                        # pragma: no cover
        while True:
            try:
                job_id = self._queue.get(timeout=300.0)
            except queue.Empty:
                return
            job = self.get(job_id)
            if job is None:
                continue
            try:
                self.run_job(job)
            except Exception as exc:                       # noqa: BLE001
                log.exception("AI job %s crashed", job_id)
                self._fail(job, "{t}: {e}".format(t=type(exc).__name__, e=exc))

    # -- one job ----------------------------------------------------------

    def _fail(self, job: Job, message: str) -> None:
        job.status = "error"
        job.error = str(message)
        job.message = str(message)
        job.finished_at = time.time()
        job.note("ERROR " + str(message))

    def run_job(self, job: Job) -> Job:
        """Execute one job to completion.  Used by the worker and the tests."""
        if job._cancelled:
            self._fail(job, "cancelled before it started")
            return job

        job.status = "running"
        job.started_at = time.time()
        job.progress = 0.01
        job.message = "loading series"

        try:
            vol = load_volume(job.series_uid)
        except AiError as exc:
            self._fail(job, str(exc))
            return job

        variant = _variant(job.model, job.tasks, job.roi_subset, job.fast)
        cdir = cache_dir(job.series_uid, job.model)
        seg_path = cdir / "seg-{v}.nii.gz".format(v=variant)
        res_path = cdir / "result-{v}.json".format(v=variant)

        if seg_path.is_file() and res_path.is_file():
            try:
                result = json.loads(res_path.read_text(encoding="utf-8"))
                job.cached = True
                job.note("cache hit: {p}".format(p=seg_path))
                job.progress = 0.98
                self._register(job, vol, seg_path, result)
                job.status = "done"
                job.progress = 1.0
                job.message = "done (cached)"
                job.finished_at = time.time()
                log.info("AI job %s served from cache in %.2fs",
                         job.job_id, job.finished_at - (job.started_at or 0))
                return job
            except (OSError, ValueError, AiError) as exc:
                job.cached = False
                job.structures = None
                job.note("cache unusable ({e}); recomputing".format(e=exc))

        work = cdir / "work-{v}".format(v=variant)
        if work.exists():
            shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True, exist_ok=True)
        ct_path = work / "ct.nii.gz"

        try:
            job.message = "exporting NIfTI"
            export_nifti(vol, ct_path)
            job.note("exported {s} to {p}".format(s=vol.hu.shape, p=ct_path))
            job.progress = 0.03

            cmd = build_command(job, ct_path, work)
            job.note("$ " + " ".join(cmd))
            result = self._run_subprocess(job, cmd)
            if result is None:
                if job.status != "error":
                    self._fail(job, job.error or "the runner produced no result")
                return job

            produced = Path(result.get("seg") or (work / "seg.nii.gz"))
            if not produced.is_file():
                self._fail(job, "the runner reported success but wrote no segmentation")
                return job

            cdir.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(produced, seg_path)
            result["seg"] = str(seg_path)
            res_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

            job.progress = 0.99
            job.message = "registering labels"
            self._register(job, vol, seg_path, result)

            job.status = "done"
            job.progress = 1.0
            job.finished_at = time.time()
            took = job.finished_at - (job.started_at or job.finished_at)
            job.message = "done in {s:.0f}s".format(s=took)
            log.info("AI job %s done: model=%s %d structures in %.1fs",
                     job.job_id, job.model, len(job.structures or []), took)
            return job
        except AiError as exc:
            self._fail(job, str(exc))
            return job
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _run_subprocess(self, job: Job, cmd: list[str]) -> Optional[dict[str, Any]]:
        started = time.perf_counter()
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=subprocess_env(),
                cwd=str(BACKEND_DIR),
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except OSError as exc:
            self._fail(job, "cannot start the inference venv ({p}): {e}".format(
                p=cmd[0], e=exc))
            return None

        with job._lock:
            job._proc = proc

        result: Optional[dict[str, Any]] = None
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.rstrip("\r\n")
            if not line:
                continue
            event = None
            if line.startswith("{"):
                try:
                    event = json.loads(line)
                except ValueError:
                    event = None
            if isinstance(event, dict) and "event" in event:
                kind = event.get("event")
                if kind == "progress":
                    try:
                        job.progress = max(0.03, min(0.97, float(event.get("value", 0))))
                    except (TypeError, ValueError):
                        pass
                    job.message = str(event.get("message") or job.message)
                    job.note("[{p:.0%}] {m}".format(p=job.progress, m=job.message))
                elif kind == "result":
                    result = {k: v for k, v in event.items() if k != "event"}
                elif kind == "error":
                    job.error = str(event.get("message") or "runner error")
                    job.note("ERROR " + job.error)
                else:
                    job.note(str(event.get("message") or line))
            else:
                job.note(line)

        code = proc.wait()
        with job._lock:
            job._proc = None
            cancelled = job._cancelled
        took = time.perf_counter() - started

        if cancelled:
            self._fail(job, "cancelled")
            return None
        if code != 0:
            self._fail(job, job.error or
                       "the runner exited with code {c}".format(c=code))
            return None
        job.note("runner finished in {s:.1f}s".format(s=took))
        return result

    def _register(self, job: Job, vol: SeriesVolume, seg_path: Path,
                  result: dict[str, Any]) -> None:
        """Hand every structure a stable label_id, colour and volume."""
        structures_in = result.get("structures") or []
        if not structures_in:
            labels = result.get("labels") or {}
            structures_in = [{"label_value": int(k), "name": v}
                             for k, v in sorted(labels.items(), key=lambda kv: int(kv[0]))]

        dz, dy, dx = (float(s) for s in vol.spacing)
        voxel_ml = dx * dy * dz / 1000.0

        out: list[dict[str, Any]] = []
        for item in structures_in:
            try:
                value = int(item["label_value"])
            except (KeyError, TypeError, ValueError):
                continue
            name = str(item.get("name") or "label_{v}".format(v=value))
            n_vox = int(item.get("n_voxels") or 0)
            if n_vox <= 0:
                continue
            ref = LabelRef(
                label_id=str(uuid.uuid4()),
                series_uid=job.series_uid,
                name=name,
                label_value=value,
                seg_path=Path(seg_path),
                color=color_for(name),
                model=job.model,
                job_id=job.job_id,
                n_voxels=n_vox,
                volume_ml=float(item.get("volume_ml", n_vox * voxel_ml)),
            )
            _remember(ref)
            out.append(ref.public())

        job.structures = out
        job.note("registered {n} structures".format(n=len(out)))


JOBS = JobManager()


def reset() -> None:
    """Drop every job and label reference (the tests use this)."""
    global _CLASS_MAP
    with JOBS._lock:
        JOBS._jobs.clear()
    with _refs_lock:
        _refs.clear()
    _CLASS_MAP = None
