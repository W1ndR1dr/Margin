"""HNLNL 20-level cervical nodal-level runner -- runs in the *inference* venv.

    %LOCALAPPDATA%\\HNRad\\venv-ai\\Scripts\\python.exe backend/ai/run_hnlnl.py
        --input <ct.nii.gz> --out <dir> --weights <model dir> [--fast] [--tta]

Why this file exists
--------------------
The published HNLNL weights
(https://github.com/putzfn/HNLNL_autosegmentation_trained_models, CC0-1.0) are
**nnU-Net v1** -- ``Task110_HNLNFixed_MirrorBest``, trainer ``nnUNetTrainerV2``,
plans ``nnUNetPlansv2.1``, ``model_final_checkpoint.model``, ``plans.pkl``.
nnU-Net **v2** cannot load that layout, and nnU-Net v1 itself does not install
on Python 3.13 / numpy 2 (it needs numpy < 2, for which there is no cp313
wheel).  So this module re-implements exactly the part of nnU-Net v1 that
inference needs, reading every hyper-parameter out of the shipped
``plans.pkl`` rather than hard-coding it:

* ``Generic_UNet`` (the plain conv/instance-norm/leaky-ReLU 3D U-Net of
  nnU-Net v1) rebuilt from ``plans_per_stage`` + ``base_num_features``,
* the CT preprocessing pipeline: crop to the non-zero box, resample to the
  plan's target spacing, clip to the plan's 0.5/99.5 percentiles, z-score with
  the plan's mean/sd,
* Gaussian-weighted sliding-window prediction with the plan's patch size,
* softmax resampled back to the input grid, arg-maxed, and (optionally) the
  largest-component filter from the released ``postprocessing.json``.

Known deviations from the upstream pipeline, stated plainly:

* single fold (``fold_0``), never the 5-fold ensemble -- 5x the runtime on CPU;
* the published result ensembles the 3d_fullres model with a 2d model; Margin
  runs 3d_fullres alone;
* test-time mirroring is **off** unless ``--tta`` is given (8x the runtime);
* the repository's ``Adjust3DCNNcontoursToCTslicePlaneOrientation.py``
  slice-plane adjustment is **not** applied.

All four make the output worse than the numbers in the paper.  Treat the masks
as a starting contour to correct, never as a measurement.
"""

from __future__ import annotations

import argparse
import json
import pickle
import sys
import time
import traceback
from pathlib import Path

import numpy as np

#: label value -> level name.  See backend/ai/README.md for provenance.
LEVEL_NAMES = {
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


def emit(event: str, **kw) -> None:
    payload = {"event": event}
    payload.update(kw)
    sys.stdout.write(json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()


# --------------------------------------------------------------------------
# nnU-Net v1 Generic_UNet, rebuilt
# --------------------------------------------------------------------------

def build_unet(plans: dict, stage: int = 0):
    """The exact ``Generic_UNet`` the shipped checkpoint was trained as."""
    import torch.nn as nn

    st = plans["plans_per_stage"][stage]
    pool_kernels = [list(map(int, k)) for k in st["pool_op_kernel_sizes"]]
    conv_kernels = [list(map(int, k)) for k in st["conv_kernel_sizes"]]
    num_pool = len(pool_kernels)
    base = int(plans["base_num_features"])
    per_stage = int(plans["conv_per_stage"])
    num_classes = int(plans["num_classes"]) + 1          # + background
    in_ch = int(plans["num_modalities"])
    max_features = 320                                   # Generic_UNet 3D default

    def block(cin, cout, kernel, stride):
        pad = [k // 2 for k in kernel]
        mod = nn.Module()
        mod.conv = nn.Conv3d(cin, cout, tuple(kernel), tuple(stride),
                             tuple(pad), 1, 1, True)
        mod.instnorm = nn.InstanceNorm3d(cout, eps=1e-5, affine=True,
                                         momentum=0.1)
        mod.lrelu = nn.LeakyReLU(negative_slope=1e-2, inplace=True)
        mod.forward = lambda x, m=mod: m.lrelu(m.instnorm(m.conv(x)))
        return mod

    def stacked(cin, cout, n, kernel, first_stride=None):
        blocks = nn.Module()
        blocks.blocks = nn.Sequential(
            block(cin, cout, kernel, first_stride or [1] * 3),
            *[block(cout, cout, kernel, [1] * 3) for _ in range(n - 1)],
        )
        blocks.forward = lambda x, b=blocks: b.blocks(x)
        blocks.output_channels = cout
        return blocks

    net = nn.Module()
    net.conv_blocks_context = nn.ModuleList()
    net.conv_blocks_localization = nn.ModuleList()
    net.tu = nn.ModuleList()
    net.seg_outputs = nn.ModuleList()

    out_features = base
    in_features = in_ch
    for d in range(num_pool):
        stride = pool_kernels[d - 1] if d != 0 else None
        net.conv_blocks_context.append(
            stacked(in_features, out_features, per_stage, conv_kernels[d], stride))
        in_features = out_features
        out_features = min(int(round(out_features * 2)), max_features)

    final_features = out_features
    bottleneck = nn.Sequential(
        stacked(in_features, out_features, per_stage - 1,
                conv_kernels[num_pool], pool_kernels[-1]),
        stacked(out_features, final_features, 1, conv_kernels[num_pool]),
    )
    net.conv_blocks_context.append(bottleneck)

    for u in range(num_pool):
        from_down = final_features
        from_skip = net.conv_blocks_context[-(2 + u)].output_channels
        final_features = from_skip                       # convolutional_upsampling
        k = pool_kernels[-(u + 1)]
        net.tu.append(nn.ConvTranspose3d(from_down, from_skip, tuple(k),
                                         tuple(k), bias=False))
        net.conv_blocks_localization.append(nn.Sequential(
            stacked(from_skip * 2, from_skip, per_stage - 1,
                    conv_kernels[-(u + 1)]),
            stacked(from_skip, final_features, 1, conv_kernels[-(u + 1)]),
        ))
    for loc in net.conv_blocks_localization:
        net.seg_outputs.append(
            nn.Conv3d(loc[-1].output_channels, num_classes, 1, 1, 0, 1, 1, False))

    def forward(x):
        skips = []
        for d in range(len(net.conv_blocks_context) - 1):
            x = net.conv_blocks_context[d](x)
            skips.append(x)
        x = net.conv_blocks_context[-1](x)
        for u in range(len(net.tu)):
            import torch

            x = net.tu[u](x)
            x = torch.cat((x, skips[-(u + 1)]), dim=1)
            x = net.conv_blocks_localization[u](x)
        return net.seg_outputs[-1](x)

    net.forward = forward
    net.patch_size = [int(v) for v in st["patch_size"]]
    net.target_spacing = [float(v) for v in st["current_spacing"]]
    net.num_classes = num_classes
    return net


# --------------------------------------------------------------------------
# nnU-Net v1 preprocessing
# --------------------------------------------------------------------------

def crop_to_nonzero(data: np.ndarray):
    """nnU-Net v1's ``ImageCropper``: the filled bounding box of ``data != 0``."""
    from scipy import ndimage

    mask = data != 0
    for k in range(mask.shape[0]):
        mask[k] = ndimage.binary_fill_holes(mask[k])
    if not mask.any():
        return data, tuple(slice(0, s) for s in data.shape)
    box = []
    for axis in range(3):
        others = tuple(a for a in range(3) if a != axis)
        hits = np.flatnonzero(mask.any(axis=others))
        box.append(slice(int(hits[0]), int(hits[-1]) + 1))
    box = tuple(box)
    return data[box], box


def _separate_z(spacing, threshold: float = 3.0) -> bool:
    spacing = np.asarray(spacing, dtype=np.float64)
    return bool((np.max(spacing) / np.min(spacing)) > threshold)


def resample_to(data: np.ndarray, new_shape, order: int = 3) -> np.ndarray:
    """nnU-Net v1 ``resample_data_or_seg``: skimage resize, edge, no AA."""
    from skimage.transform import resize

    new_shape = tuple(int(v) for v in new_shape)
    if tuple(data.shape) == new_shape:
        return data.astype(np.float32, copy=False)
    return resize(data.astype(np.float32, copy=False), new_shape, order=order,
                  mode="edge", anti_aliasing=False).astype(np.float32)


def normalize_ct(data: np.ndarray, props: dict) -> np.ndarray:
    lo = float(props["percentile_00_5"])
    hi = float(props["percentile_99_5"])
    mean = float(props["mean"])
    sd = float(props["sd"])
    out = np.clip(data, lo, hi).astype(np.float32)
    return (out - np.float32(mean)) / np.float32(sd)


# --------------------------------------------------------------------------
# sliding window
# --------------------------------------------------------------------------

def compute_steps(patch, shape, step_size: float) -> list[list[int]]:
    steps = []
    for dim in range(3):
        target = patch[dim] * step_size
        n = int(np.ceil((shape[dim] - patch[dim]) / target)) + 1
        if n > 1:
            actual = (shape[dim] - patch[dim]) / (n - 1)
        else:
            actual = 99999999.0
        steps.append([int(np.round(actual * i)) for i in range(n)])
    return steps


def gaussian_map(patch) -> np.ndarray:
    from scipy.ndimage import gaussian_filter

    tmp = np.zeros(patch, dtype=np.float32)
    centre = [i // 2 for i in patch]
    tmp[tuple(centre)] = 1.0
    sigmas = [i * (1.0 / 8) for i in patch]
    g = gaussian_filter(tmp, sigmas, 0, mode="constant", cval=0)
    g /= g.max()
    g = g.astype(np.float32)
    g[g == 0] = g[g != 0].min()
    return g


def predict_sliding_window(net, data: np.ndarray, patch, step_size: float,
                           tta: bool, on_progress=None) -> np.ndarray:
    """Returns the softmax as ``(C, z, y, x)`` on ``data``'s own grid."""
    import torch

    shape = list(data.shape)
    pad = [max(0, patch[d] - shape[d]) for d in range(3)]
    if any(pad):
        before = [p // 2 for p in pad]
        data = np.pad(data, [(before[d], pad[d] - before[d]) for d in range(3)],
                      mode="constant", constant_values=0)
        slicer = tuple(slice(before[d], before[d] + shape[d]) for d in range(3))
    else:
        slicer = tuple(slice(0, s) for s in shape)
    work = list(data.shape)

    steps = compute_steps(patch, work, step_size)
    n_tiles = len(steps[0]) * len(steps[1]) * len(steps[2])
    gauss = gaussian_map(patch)

    agg = np.zeros([net.num_classes] + work, dtype=np.float32)
    weights = np.zeros(work, dtype=np.float32)
    gauss_t = torch.from_numpy(gauss)

    done = 0
    with torch.no_grad():
        for z in steps[0]:
            for y in steps[1]:
                for x in steps[2]:
                    sl = (slice(z, z + patch[0]), slice(y, y + patch[1]),
                          slice(x, x + patch[2]))
                    tile = torch.from_numpy(
                        np.ascontiguousarray(data[sl])[None, None])
                    logits = net.forward(tile)
                    prob = torch.softmax(logits, 1)[0]
                    if tta:
                        acc = prob
                        for axes in ((2,), (3,), (4,), (2, 3), (2, 4),
                                     (3, 4), (2, 3, 4)):
                            flipped = net.forward(torch.flip(tile, axes))
                            back = torch.flip(
                                torch.softmax(flipped, 1),
                                [a for a in axes])
                            acc = acc + back[0]
                        prob = acc / 8.0
                    agg[(slice(None),) + sl] += (prob * gauss_t).numpy()
                    weights[sl] += gauss
                    done += 1
                    if on_progress is not None:
                        on_progress(done, n_tiles)

    agg /= np.maximum(weights, 1e-8)[None]
    return agg[(slice(None),) + slicer]


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="HNLNL nodal-level runner")
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--weights", required=True,
                    help="the nnUNetTrainerV2__nnUNetPlansv2.1 folder")
    ap.add_argument("--fold", type=int, default=0)
    ap.add_argument("--fast", action="store_true",
                    help="no sliding-window overlap (step 1.0) instead of 0.5")
    ap.add_argument("--tta", action="store_true",
                    help="8x mirror test-time augmentation (8x slower)")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--no-postprocess", action="store_true")
    args = ap.parse_args(argv)

    started = time.perf_counter()
    try:
        import torch

        if args.threads and args.threads > 0:
            torch.set_num_threads(int(args.threads))
        import SimpleITK as sitk

        weights = Path(args.weights)
        out_dir = Path(args.out)
        out_dir.mkdir(parents=True, exist_ok=True)

        emit("progress", value=0.02, message="loading plans")
        plans = pickle.load(open(weights / "plans.pkl", "rb"))
        props = plans["dataset_properties"]["intensityproperties"][0]
        target_spacing = [float(v) for v in
                          plans["plans_per_stage"][0]["current_spacing"]]
        patch = [int(v) for v in plans["plans_per_stage"][0]["patch_size"]]

        emit("progress", value=0.05, message="building network")
        net = build_unet(plans)
        ckpt_path = weights / ("fold_%d" % args.fold) / "model_final_checkpoint.model"
        try:
            ckpt = torch.load(str(ckpt_path), map_location="cpu", weights_only=True)
        except Exception:
            # The v1 checkpoint carries numpy training curves alongside the
            # weights, which the safe loader refuses.  The archive is the CC0
            # GitHub release of a published paper.
            ckpt = torch.load(str(ckpt_path), map_location="cpu", weights_only=False)
        state = ckpt["state_dict"] if "state_dict" in ckpt else ckpt
        state = {k[7:] if k.startswith("module.") else k: v
                 for k, v in state.items()}
        missing, unexpected = net.load_state_dict(state, strict=False)
        if missing or unexpected:
            raise RuntimeError(
                "checkpoint does not match the rebuilt Generic_UNet: "
                "%d missing, %d unexpected (first: %s / %s)"
                % (len(missing), len(unexpected),
                   missing[:3], unexpected[:3]))
        net.eval()

        emit("progress", value=0.08, message="preprocessing")
        img = sitk.ReadImage(str(args.input))
        raw = sitk.GetArrayFromImage(img).astype(np.float32)   # (z, y, x)
        sx, sy, sz = img.GetSpacing()
        spacing = [float(sz), float(sy), float(sx)]             # (z, y, x)
        orig_shape = raw.shape

        cropped, box = crop_to_nonzero(raw)
        new_shape = np.round(np.asarray(cropped.shape)
                             * np.asarray(spacing)
                             / np.asarray(target_spacing)).astype(int)
        new_shape = np.maximum(new_shape, 1)
        if _separate_z(spacing) or _separate_z(target_spacing):
            emit("log", message="anisotropic series: nnU-Net would resample z "
                                "separately; this runner uses one 3D spline")
        resampled = resample_to(cropped, new_shape, order=3)
        data = normalize_ct(resampled, props)
        emit("log", message="grid {a} -> crop {b} -> {c} at {s} mm".format(
            a=orig_shape, b=cropped.shape, c=tuple(new_shape),
            s=[round(v, 3) for v in target_spacing]))

        step = 1.0 if args.fast else 0.5

        def progress(done, total):
            emit("progress", value=0.10 + 0.75 * done / max(1, total),
                 message="tile {d}/{t}".format(d=done, t=total))

        softmax = predict_sliding_window(net, data, patch, step, args.tta,
                                         progress)

        emit("progress", value=0.88, message="resampling back to the CT grid")
        # Running arg-max over the classes so the 21-channel softmax is never
        # upsampled to the full grid all at once.
        best_val = np.full(cropped.shape, -1.0, dtype=np.float32)
        best_idx = np.zeros(cropped.shape, dtype=np.uint8)
        for c in range(softmax.shape[0]):
            up = resample_to(softmax[c], cropped.shape, order=1)
            better = up > best_val
            best_val[better] = up[better]
            best_idx[better] = c
        del softmax, best_val

        seg = np.zeros(orig_shape, dtype=np.uint8)
        seg[box] = best_idx

        if not args.no_postprocess:
            pp_path = weights / "postprocessing.json"
            if pp_path.is_file():
                pp = json.loads(pp_path.read_text(encoding="utf-8"))
                classes = sorted(int(c) for c in (pp.get("for_which_classes") or []))
                if classes:
                    emit("progress", value=0.92,
                         message="largest-component filter on %d classes" % len(classes))
                    seg = keep_largest(seg, classes)

        emit("progress", value=0.96, message="writing")
        out = sitk.GetImageFromArray(seg)
        out.CopyInformation(img)
        seg_path = out_dir / "seg.nii.gz"
        sitk.WriteImage(out, str(seg_path), True)

        values, counts = np.unique(seg, return_counts=True)
        counts = {int(v): int(c) for v, c in zip(values, counts) if int(v) != 0}
        voxel_ml = float(sx) * float(sy) * float(sz) / 1000.0
        structures = [
            {
                "label_value": int(v),
                "name": LEVEL_NAMES.get(int(v), "hnlnl_label_%d" % int(v)),
                "n_voxels": int(counts[v]),
                "volume_ml": float(counts[v] * voxel_ml),
            }
            for v in sorted(counts)
        ]
        result = {
            "seg": str(seg_path),
            "labels": {str(k): v for k, v in sorted(LEVEL_NAMES.items())},
            "structures": structures,
            "model": "hnlnl",
            "fold": int(args.fold),
            "step_size": step,
            "tta": bool(args.tta),
            "seconds": float(time.perf_counter() - started),
        }
        (out_dir / "labels.json").write_text(
            json.dumps(result["labels"], indent=2), encoding="utf-8")
        (out_dir / "result.json").write_text(
            json.dumps(result, indent=2), encoding="utf-8")

        emit("progress", value=1.0, message="done")
        emit("result", **result)
        return 0
    except Exception as exc:                                  # noqa: BLE001
        traceback.print_exc()
        emit("error", message="{t}: {e}".format(t=type(exc).__name__, e=exc))
        return 1


def keep_largest(seg: np.ndarray, classes) -> np.ndarray:
    """The released postprocessing: one connected component per listed class."""
    from scipy import ndimage

    out = seg.copy()
    for c in classes:
        mask = seg == c
        if not mask.any():
            continue
        lab, n = ndimage.label(mask)
        if n <= 1:
            continue
        sizes = ndimage.sum(mask, lab, range(1, n + 1))
        keep = int(np.argmax(sizes)) + 1
        out[mask & (lab != keep)] = 0
    return out


if __name__ == "__main__":
    raise SystemExit(main())
