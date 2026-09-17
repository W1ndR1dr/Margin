"""Render an axial CT slice with the AI labels drawn on top, as a PNG.

A sanity check you can actually look at: carotids should be small round tubes
that appear bilaterally over many slices, the mandible a horseshoe, the airway
a midline lucency.  Run in the **app** venv (no torch)::

    backend\\.venv\\Scripts\\python.exe backend\\ai\\overlay.py \\
        --series <uid> --model totalseg --out overlay.png [--slices 5]

Colours are the ones the API hands the frontend (``hnrad.ai.color_for``), so
what you see here is what the viewer will draw.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hnrad import ai                                        # noqa: E402

WINDOW_WIDTH = 350.0
WINDOW_CENTER = 40.0


def _grey(hu: np.ndarray) -> np.ndarray:
    lo = WINDOW_CENTER - WINDOW_WIDTH / 2.0
    hi = WINDOW_CENTER + WINDOW_WIDTH / 2.0
    out = np.clip((hu - lo) / (hi - lo), 0.0, 1.0)
    return (out * 255.0).astype(np.uint8)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--series", required=True)
    ap.add_argument("--model", default="totalseg")
    ap.add_argument("--out", default="overlay.png")
    ap.add_argument("--slices", type=int, default=5,
                    help="how many evenly spaced axial slices to tile")
    ap.add_argument("--alpha", type=float, default=0.45)
    args = ap.parse_args()

    from PIL import Image

    vol = ai.load_volume(args.series)
    cdir = ai.cache_dir(args.series, args.model)
    segs = sorted(cdir.glob("seg-*.nii.gz"))
    if not segs:
        print("no cached segmentation in %s -- run a job first" % cdir)
        return 1
    seg_path = segs[-1]
    res_path = cdir / seg_path.name.replace("seg-", "result-").replace(
        ".nii.gz", ".json")
    labels = {}
    if res_path.is_file():
        result = json.loads(res_path.read_text(encoding="utf-8"))
        labels = {int(k): v for k, v in (result.get("labels") or {}).items()}

    seg = ai.read_multilabel(seg_path, vol)
    present = [int(v) for v in np.unique(seg) if int(v) != 0]
    print("using %s (%d structures present)" % (seg_path.name, len(present)))

    # Only show slices that actually contain something.
    hits = np.flatnonzero((seg > 0).any(axis=(1, 2)))
    if hits.size == 0:
        print("the segmentation is empty")
        return 1
    ks = np.linspace(hits[0], hits[-1], max(1, args.slices)).round().astype(int)

    tiles = []
    for k in ks:
        base = _grey(vol.hu[k])
        rgb = np.dstack([base, base, base]).astype(np.float32)
        lab = seg[k]
        for value in present:
            mask = lab == value
            if not mask.any():
                continue
            colour = np.asarray(
                ai.color_for(labels.get(value, "label_%d" % value)),
                dtype=np.float32)
            rgb[mask] = (1.0 - args.alpha) * rgb[mask] + args.alpha * colour
        tiles.append(np.clip(rgb, 0, 255).astype(np.uint8))

    strip = np.concatenate(tiles, axis=1)
    Image.fromarray(strip).save(args.out)
    print("wrote %s  (%d x %d, slices k=%s)"
          % (args.out, strip.shape[1], strip.shape[0], list(ks)))

    for value in present:
        name = labels.get(value, "label_%d" % value)
        idx = np.argwhere(seg == value)
        print("  %-38s n=%-8d k=%d..%d  centroid i=%.0f j=%.0f  colour=%s"
              % (name, idx.shape[0], idx[:, 0].min(), idx[:, 0].max(),
                 idx[:, 2].mean(), idx[:, 1].mean(), ai.color_for(name)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
