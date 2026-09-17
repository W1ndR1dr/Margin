"""TotalSegmentator runner -- executed inside the *inference* venv.

This file is never imported by the FastAPI app.  It is launched as::

    %LOCALAPPDATA%\\HNRad\\venv-ai\\Scripts\\python.exe backend/ai/run_totalseg.py
        --input  <ct.nii.gz>
        --out    <dir>
        --tasks  total headneck_bones_vessels ...
        [--roi-subset thyroid_gland trachea ...]      (``total`` task only)
        [--fast] [--threads N]

and speaks the line protocol described in ``backend/ai/README.md``: one JSON
object per line on stdout, ``{"event": "progress"|"log"|"result"|"error", ...}``.
Anything the underlying libraries print goes to stderr and is only used for the
job's ``log_tail``.

Output (in ``--out``):

``seg.nii.gz``   uint16 multi-label volume on the *input* grid
``labels.json``  ``{"1": "thyroid_gland", ...}`` -- label value -> structure name
``result.json``  the same payload that is emitted as the ``result`` event
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path


def emit(event: str, **kw) -> None:
    """One JSON object per line on stdout, flushed immediately."""
    payload = {"event": event}
    payload.update(kw)
    sys.stdout.write(json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()


def _class_map(task: str) -> dict[int, str]:
    """The installed TotalSegmentator's class list for *task*."""
    from totalsegmentator.map_to_binary import class_map

    if task not in class_map:
        raise KeyError(
            "task {t!r} is unknown to this TotalSegmentator "
            "(have: {k})".format(t=task, k=", ".join(sorted(class_map)))
        )
    return {int(k): str(v) for k, v in class_map[task].items()}


def run_task(
    inp: Path,
    work: Path,
    task: str,
    fast: bool,
    roi_subset: list[str] | None,
) -> tuple["object", dict[int, str]]:
    """Run one TotalSegmentator task; return (numpy array (z,y,x), value->name)."""
    import SimpleITK as sitk
    from totalsegmentator.python_api import totalsegmentator

    out_file = work / "{t}.nii.gz".format(t=task)
    kwargs = dict(
        input=str(inp),
        output=str(out_file),
        ml=True,                 # one multi-label file rather than N binaries
        task=task,
        fast=bool(fast),
        device="cpu",
        quiet=True,
        verbose=False,
    )
    # roi_subset is only meaningful for the 117-class `total` task; passing it
    # to a subtask makes TotalSegmentator raise.
    if roi_subset and task == "total":
        kwargs["roi_subset"] = list(roi_subset)

    totalsegmentator(**kwargs)

    img = sitk.ReadImage(str(out_file))
    arr = sitk.GetArrayFromImage(img)            # (z, y, x)
    return arr, _class_map(task)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="TotalSegmentator runner (inference venv)")
    ap.add_argument("--input", required=True, help="CT as .nii.gz, already on the series grid")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--tasks", nargs="+", required=True)
    ap.add_argument("--roi-subset", nargs="*", default=None)
    ap.add_argument("--fast", action="store_true")
    ap.add_argument("--threads", type=int, default=0,
                    help="0 = leave OMP_NUM_THREADS alone")
    args = ap.parse_args(argv)

    if args.threads and args.threads > 0:
        os.environ["OMP_NUM_THREADS"] = str(args.threads)
        os.environ["MKL_NUM_THREADS"] = str(args.threads)

    inp = Path(args.input)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / "_work"
    work.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    try:
        import numpy as np
        import SimpleITK as sitk

        ref = sitk.ReadImage(str(inp))
        shape_zyx = (ref.GetSize()[2], ref.GetSize()[1], ref.GetSize()[0])
        merged = np.zeros(shape_zyx, dtype=np.uint16)
        labels: dict[int, str] = {}
        per_task: dict[str, list[str]] = {}
        next_id = 1

        n = len(args.tasks)
        emit("progress", value=0.02, message="starting")

        for idx, task in enumerate(args.tasks):
            emit("progress", value=0.02 + 0.93 * idx / max(1, n),
                 message="task {t} ({i}/{n})".format(t=task, i=idx + 1, n=n))
            t0 = time.perf_counter()
            arr, cmap = run_task(inp, work, task, args.fast,
                                 args.roi_subset)
            if arr.shape != shape_zyx:
                raise RuntimeError(
                    "task {t} returned shape {a} but the input is {b}".format(
                        t=task, a=arr.shape, b=shape_zyx))

            present = [int(v) for v in np.unique(arr) if int(v) != 0]
            names: list[str] = []
            for value in present:
                name = cmap.get(value)
                if name is None:
                    continue
                # First task to claim a structure name wins; a later task that
                # produces the same organ is ignored rather than duplicated.
                if name in labels.values():
                    continue
                merged[(arr == value) & (merged == 0)] = next_id
                labels[next_id] = name
                names.append(name)
                next_id += 1
            per_task[task] = names
            emit("log", message="task {t}: {k} structures in {s:.1f}s".format(
                t=task, k=len(names), s=time.perf_counter() - t0))

        emit("progress", value=0.96, message="writing multi-label volume")

        seg = sitk.GetImageFromArray(merged)
        seg.CopyInformation(ref)
        seg_path = out_dir / "seg.nii.gz"
        sitk.WriteImage(seg, str(seg_path), True)

        counts = {int(v): int(c) for v, c in
                  zip(*np.unique(merged, return_counts=True)) if int(v) != 0}
        sx, sy, sz = ref.GetSpacing()
        voxel_ml = float(sx) * float(sy) * float(sz) / 1000.0

        structures = [
            {
                "label_value": int(v),
                "name": labels[v],
                "n_voxels": int(counts.get(v, 0)),
                "volume_ml": float(counts.get(v, 0) * voxel_ml),
            }
            for v in sorted(labels)
        ]
        result = {
            "seg": str(seg_path),
            "labels": {str(k): v for k, v in sorted(labels.items())},
            "structures": structures,
            "per_task": per_task,
            "tasks": list(args.tasks),
            "fast": bool(args.fast),
            "roi_subset": list(args.roi_subset) if args.roi_subset else None,
            "seconds": float(time.perf_counter() - started),
        }
        (out_dir / "labels.json").write_text(
            json.dumps(result["labels"], indent=2), encoding="utf-8")
        (out_dir / "result.json").write_text(
            json.dumps(result, indent=2), encoding="utf-8")

        # The per-task intermediates are large; the merged volume is the product.
        for leftover in work.glob("*.nii.gz"):
            try:
                leftover.unlink()
            except OSError:
                pass

        emit("progress", value=1.0, message="done")
        emit("result", **result)
        return 0
    except Exception as exc:                                  # noqa: BLE001
        traceback.print_exc()
        emit("error", message="{t}: {e}".format(t=type(exc).__name__, e=exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
