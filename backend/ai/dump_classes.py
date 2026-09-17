"""Dump the *installed* TotalSegmentator's task metadata into JSON.

Run inside the inference venv; the FastAPI app (which must never import torch)
reads the result from ``backend/ai/class_map.json``::

    %LOCALAPPDATA%\\HNRad\\venv-ai\\Scripts\\python.exe backend/ai/dump_classes.py

The point is that every class list, dataset id and licence note Margin shows is
read out of the version actually installed, never copied from a README.

What lands in ``class_map.json`` per task:

``classes``       label value -> structure name (``map_to_binary.class_map``)
``dataset_ids``   the nnU-Net ``DatasetNNN_*`` folders the task needs
``crop_datasets`` dataset ids the task needs *indirectly*, because
                  TotalSegmentator first runs another model to crop
``license``       "Apache-2.0", or a warning when the task is flagged
                  ``commercial`` (= a free non-commercial licence key is
                  required, and Margin refuses to offer it)
``fast``          whether ``--fast`` is allowed, and which dataset it uses
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The head/neck tasks Margin offers, in the order they appear in the UI.
TASKS = [
    "total",
    "headneck_bones_vessels",
    "head_glands_cavities",
    "headneck_muscles",
    "craniofacial_structures",
    "teeth",
]


def _ids(value) -> list[int]:
    if value is None:
        return []
    if isinstance(value, int):
        return [int(value)]
    return [int(v) for v in value]


def main() -> int:
    import totalsegmentator
    from totalsegmentator.map_tasks_config import TASK_CONFIGS
    from totalsegmentator.map_to_binary import class_map

    try:
        version = totalsegmentator.__version__
    except AttributeError:
        from importlib.metadata import version as _v
        version = _v("totalsegmentator")

    def task_datasets(task: str) -> tuple[list[int], dict[str, list[int]]]:
        """(default-mode dataset ids, {sub_mode: ids})."""
        cfg = TASK_CONFIGS[task]
        if "sub_modes" in cfg:
            modes = {k: _ids(v.get("task_id")) for k, v in cfg["sub_modes"].items()}
            return modes.get("default", []), modes
        return _ids(cfg.get("task_id")), {}

    out: dict[str, object] = {
        "totalsegmentator_version": str(version),
        "python": sys.version.split()[0],
        "all_task_names": sorted(class_map.keys()),
        "tasks": {},
    }

    for task in TASKS:
        if task not in class_map or task not in TASK_CONFIGS:
            out["tasks"][task] = {"error": "not present in TotalSegmentator %s" % version}
            print("MISSING TASK: %s" % task, file=sys.stderr)
            continue

        cfg = TASK_CONFIGS[task]
        cmap = {int(k): str(v) for k, v in class_map[task].items()}
        default_ids, sub_modes = task_datasets(task)

        # Every head/neck subtask first runs another model to find its crop
        # box, so those weights have to be present as well.
        crop_ids: list[int] = []
        crop_model = cfg.get("crop_model")
        if cfg.get("crop"):
            crop_ids = task_datasets(crop_model)[0] if crop_model else task_datasets("total")[0]

        commercial = bool(cfg.get("commercial", False))
        entry = {
            "n_classes": len(cmap),
            "classes": {str(k): v for k, v in sorted(cmap.items())},
            "dataset_ids": default_ids,
            "sub_modes": sub_modes,
            "crop_from": crop_model or ("total" if cfg.get("crop") else None),
            "crop_dataset_ids": crop_ids,
            "fast_allowed": not bool(cfg.get("disallow_fast", False)),
            "commercial_license_required": commercial,
            "license": ("NON-COMMERCIAL LICENCE KEY REQUIRED - not offered by Margin"
                        if commercial else "Apache-2.0 (code and weights)"),
        }
        out["tasks"][task] = entry

        print("=== %s: %d classes | datasets %s | crop from %s %s | fast=%s | %s ==="
              % (task, len(cmap), default_ids, entry["crop_from"], crop_ids,
                 entry["fast_allowed"], entry["license"]))
        for k in sorted(cmap):
            print("  %3d  %s" % (k, cmap[k]))

    dest = HERE / "class_map.json"
    dest.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("\nwrote %s (TotalSegmentator %s)" % (dest, version))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
