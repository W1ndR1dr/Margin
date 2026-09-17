# `backend/ai` — the inference side

Everything in this folder runs in a **separate interpreter** from the FastAPI
app. The app (`backend/.venv`, Python 3.13) never imports torch, nnU-Net or
TotalSegmentator; it launches these scripts as subprocesses and reads a
line protocol off stdout. `backend/hnrad/ai.py` is the app-side half.

```
backend/.venv          FastAPI, pydicom, SimpleITK, numpy, scipy, scikit-image
%LOCALAPPDATA%\HNRad\venv-ai   torch(cpu), TotalSegmentator, nnunetv2, SimpleITK, nibabel
```

## Files

| file | runs in | what it is |
|---|---|---|
| `run_totalseg.py` | venv-ai | TotalSegmentator driver: N tasks → one multi-label NIfTI |
| `run_hnlnl.py`    | venv-ai | self-contained nnU-Net **v1** inference for the HNLNL 20-level model |
| `dump_classes.py` | venv-ai | writes `class_map.json` from the *installed* TotalSegmentator |
| `bench.py`        | .venv   | wall time + peak RAM for one job |
| `class_map.json`  | —       | build artefact: class lists, dataset ids, licences |
| `requirements-ai.txt` | — | `pip freeze` of venv-ai |

`class_map.json` is what `GET /api/ai/models` serves. Regenerate it after any
TotalSegmentator upgrade:

```powershell
$env:TOTALSEG_HOME_DIR = "$env:LOCALAPPDATA\HNRad\models\totalseg"
& "$env:LOCALAPPDATA\HNRad\venv-ai\Scripts\python.exe" backend\ai\dump_classes.py
```

`backend/tests/test_ai.py::test_class_map_json_is_present_and_matches_the_catalogue`
fails if it goes stale.

## The line protocol

A runner writes **one JSON object per line** to stdout and nothing else;
library chatter goes to stderr, where it only feeds a job's `log_tail`.

```json
{"event": "progress", "value": 0.42, "message": "task teeth (3/4)"}
{"event": "log",      "message": "task total: 18 structures in 61.2s"}
{"event": "error",    "message": "RuntimeError: ..."}
{"event": "result",   "seg": "...\\seg.nii.gz",
                      "labels":     {"1": "thyroid_gland", ...},
                      "structures": [{"label_value": 1, "name": "thyroid_gland",
                                      "n_voxels": 4211, "volume_ml": 2.11}, ...]}
```

`value` is 0–1; the app clamps it into 0.03–0.97 and owns the ends. Exit code 0
plus exactly one `result` event means success. Everything else is an error.

A runner also writes `seg.nii.gz`, `labels.json` and `result.json` into `--out`.
`seg.nii.gz` **must be on the input grid** — same shape, spacing, origin and
direction as `--input`. The app refuses a mismatch rather than guessing.

## Geometry

The app exports the cached HU volume with `hnrad.ai.export_nifti`, which is
`SimpleITK` writing on the series' own grid. SimpleITK holds geometry in **LPS**
(like DICOM) and performs the LPS→RAS flip itself on write, so the file's
`srow` equals `hnrad.ai.nifti_affine_ras(vol)`:

```
P_lps = origin + i·dx·row_dir + j·dy·col_dir + k·dz·slice_dir     (i=col, j=row, k=slice)
P_ras = diag(-1, -1, +1) · P_lps
```

which is exactly what `segmentation.ijk_to_lps` computes, so an AI mask and a
region-grown mask land in the same millimetres. `test_ai.py` checks this three
ways: against `ijk_to_lps`, against the raw `srow_x/y/z` bytes parsed out of the
gzipped NIfTI-1 header, and by a SimpleITK read-back.

## TotalSegmentator

Version pinned in `requirements-ai.txt`; class lists in `class_map.json`.
Weights live under `TOTALSEG_HOME_DIR = %LOCALAPPDATA%\HNRad\models\totalseg`
(**never** the default `%USERPROFILE%\.totalsegmentator`, which is
OneDrive-synced on this box).

Tasks Margin offers — all **Apache-2.0 code *and* weights**, no licence key:

| task | classes | nnU-Net datasets | crops using | `--fast`? |
|---|---|---|---|---|
| `total` | 117 | 291–295 (1.5 mm) | — | yes → 297 (3 mm) |
| `headneck_bones_vessels` | 12 | 776 | `total` | no |
| `head_glands_cavities` | 19 | 775 | `total` | no |
| `headneck_muscles` | 23 | 778, 779 | `total` | no |
| `craniofacial_structures` | 7 | 115 | `total` | no |
| `teeth` | 77 | 113 | `craniofacial_structures` | no |

Two consequences that are easy to get wrong:

* **Every head/neck subtask secretly needs the `total` weights**, because
  TotalSegmentator runs `total` first to find its crop box (clavicles + C1/C5/T1/T4,
  or the skull). `teeth` needs `craniofacial_structures` for the same reason.
  `/api/ai/models` reports a subtask as unavailable when its crop model is missing.
* **`--fast` only applies to `total`.** Every subtask sets `disallow_fast`, so
  passing `fast: true` with only subtasks selected changes nothing but the cache key.

Never run `total` without an ROI subset — the 117-class forward pass wants
~20 GB. `hnrad.ai.DEFAULT_ROI_SUBSET` is the neck slice (thyroid, trachea,
oesophagus, skull, brain, spinal cord, both common carotids, subclavians,
brachiocephalics, clavicles, C1–C7) and is applied automatically when `total`
is requested without one.

Tasks Margin deliberately does **not** offer, because their weights need a free
non-commercial licence key: `heartchambers_highres`, `appendicular_bones`,
`tissue_types`, `brain_structures`, `face`, `thigh_shoulder_muscles`,
`coronary_arteries`, `aortic_sinuses`, `renal_arteries`, `aorta_annulus`,
`aortic_dissection`, `pulmonary_artery_landmarks`, `tissue_4_types` and their
`_mr` variants. None are needed for head and neck.

## HNLNL — 20 cervical nodal levels

* Source: <https://github.com/putzfn/HNLNL_autosegmentation_trained_models> (**CC0-1.0**)
* Paper: Putz F et al., *Deep learning for automatic head and neck lymph node
  level delineation provides expert-level accuracy.* Front Oncol 2023, PMID 36874135.
* Release used: tag `nnUnet_model_export`, `NnunetModelExport.z01` (1.86 GB) +
  `NnunetModelExport.zip` (258 MB) — a `zip -s` split archive, **2.12 GB total**.
* Staged at `%LOCALAPPDATA%\HNRad\models\hnlnl\nnunet_v1_results\3d_fullres\Task110_HNLNFixed_MirrorBest\nnUNetTrainerV2__nnUNetPlansv2.1\`

### These are nnU-Net **v1** weights

This is the single biggest surprise in the whole integration. The archive
contains `nnUNetTrainerV2__nnUNetPlansv2.1`, `plans.pkl` and
`model_final_checkpoint.model` — nnU-Net **v1** layout, and the release notes
quote the v1 CLI (`nnUNet_export_model_to_zip`, `nnUNet_predict`).
**`nnunetv2` cannot load this.** nnU-Net v1 itself is not installable here
either: it needs `numpy < 2`, for which there is no cp313 wheel.

So `run_hnlnl.py` re-implements the inference half of nnU-Net v1 directly in
torch, reading every hyper-parameter out of the shipped `plans.pkl`:
`Generic_UNet` (6 context stages, 5 localisation stages, transposed-conv
upsampling, InstanceNorm3d + LeakyReLU 0.01), the CT preprocessing (fill-holes
non-zero crop → spline resample to 3.0 × 1.1716 × 1.1716 mm → clip to
[−148, 302] HU → z-score with mean 14.790 / sd 97.739), Gaussian-weighted
sliding-window prediction over the 56 × 128 × 224 patch, softmax resampled back
to the CT grid with a running arg-max, and the largest-component filter from
the released `postprocessing.json`.

The rebuild is verified, not hoped for: the checkpoint loads
`strict=True` — 98/98 tensors, no shape mismatches
(`test_ai.py` keeps the label table honest; the strict load is checked by
`run_hnlnl.py` itself, which raises if anything is missing or unexpected).

### Deviations from the published pipeline — read before trusting a contour

| what the paper did | what Margin does | why |
|---|---|---|
| 5-fold ensemble | `fold_0` only | 5× the CPU time |
| 3d_fullres **+ 2d** ensemble | 3d_fullres only | 2× the CPU time |
| mirror TTA | off unless `--tta` | 8× the CPU time |
| `Adjust3DCNNcontoursToCTslicePlaneOrientation.py` slice-plane adjustment | **not applied** | not ported yet; the paper says it measurably improves ratings |

All four make the output worse than the paper's Dice. These are starting
contours to correct, never measurements.

### Label map

Label values 1–20 come from `plans.pkl` (`all_classes`). The *names and their
order* are verbatim from the author's own 3D Slicer review module,
`Blinded review module for 3DSlicer/HN_Lvl_Blinded_Review.py`, `self.LevelNameList`.

The 1-based alignment of the two lists is an **inference**, not something the
repository states. It is corroborated by the author's postprocessing script
`Adjust3DCNNcontoursToCTslicePlaneOrientation.py`, whose mutually-exclusive
label groups — `[[18,5],[17,4],[5,7],[4,6],[7,9],[6,8]]`,
`[[11,9,13],[10,8,12]]`, `[[14,1,2,3]]` — resolve under this mapping into six
correctly mirrored left/right pairs of *adjacent* levels plus a coherent
"VIa vs level I" group, and under no other assignment do. Class 16 also has the
lowest Dice in `postprocessing.json` (0.554), matching the paper's note that
the retropharyngeal level scored worst.

| id | name | Robbins level | id | name | Robbins level |
|---|---|---|---|---|---|
| 1 | `level_Ia` | Ia | 11 | `level_IVb_right` | IVb right |
| 2 | `level_Ib_left` | Ib left | 12 | `level_V_left` | V left |
| 3 | `level_Ib_right` | Ib right | 13 | `level_V_right` | V right |
| 4 | `level_II_left` | II left | 14 | `level_VIa` | VIa |
| 5 | `level_II_right` | II right | 15 | `level_VIb` | VIb |
| 6 | `level_III_left` | III left | 16 | `level_VIIa` | VIIa (retropharyngeal) |
| 7 | `level_III_right` | III right | 17 | `level_VIIb_left` | VIIb left (retrostyloid) |
| 8 | `level_IVa_left` | IVa left | 18 | `level_VIIb_right` | VIIb right |
| 9 | `level_IVa_right` | IVa right | 19 | `level_VIII_left` | VIII left (parotid) |
| 10 | `level_IVb_left` | IVb left | 20 | `level_VIII_right` | VIII right |

**Laterality is unverified.** Neither the repository nor the paper says whether
`_left`/`_right` means patient-left or image-left. Check one case of known
laterality before believing a side.

### Re-staging the weights

The release is a `zip -s` split archive, which Python's `zipfile` mis-reads
after concatenation (it applies a "concat" correction to every header offset
once the central directory is not where the EOCD claims). Concatenate
`NnunetModelExport.z01 + NnunetModelExport.zip`, skip the 4-byte spanning
marker `PK\x07\x08` at offset 0, then walk the local file headers sequentially
from there instead of trusting their recorded offsets.

## Measured CPU wall times

Reference box: i5-14500T (6 P + 8 E = 14 physical cores, 20 logical), 32 GB,
Intel UHD 770, **no CUDA**. Series: `PHANTOM_NECK`, 512 × 512 × 180 at
0.45 × 0.45 × 1.0 mm (the synthetic phantom — timings are representative of a
real neck CT of the same size; the *contours* are not). 12 threads unless
noted. Wall time is the whole job as the server runs it: NIfTI export →
subprocess → merge → label registration. Peak RSS is the peak working set of
the inference process tree.

| job | wall | peak RSS | structures found |
|---|---|---|---|
| `total`, neck `roi_subset`, `--fast` (3 mm) | **88 s** | 5.5 GB | 16 |
| `total`, neck `roi_subset` (1.5 mm) | **220 s** | 5.4 GB | 14 |
| `headneck_bones_vessels` | **216 s** | 5.8 GB | 10 |
| `headneck_bones_vessels`, 18 threads | 243 s | — | 10 |
| `hnlnl` 20 nodal levels, fold 0, no TTA | **186 s** | 3.3 GB | 16 / 20 |
| any of the above, **second request** (cache hit) | **0.4 s** | — | — |

Read from this:

* **A useful head/neck set is ~5 minutes, not 3.** `total --fast` + one
  subtask is 88 + 216 ≈ **5 min**; adding `head_glands_cavities` and
  `craniofacial_structures` roughly doubles it. The ~3 min target is only met
  by `total --fast` alone (88 s) or one subtask alone.
* **`--fast` is worth 2.5× on `total`** (88 s vs 220 s) and is unavailable on
  every subtask (`disallow_fast` upstream). It is the single biggest lever.
* **`roi_subset` is not optional.** It is what keeps peak RSS at ~5.5 GB
  instead of the ~20 GB the unrestricted 117-class forward pass wants.
* **More threads is worse.** 18 threads was *slower* than 12 (243 s vs 216 s)
  on this hybrid CPU — the P-cores' SMT siblings and the E-cores fight over
  the same memory bandwidth. `hnrad.ai.default_threads()` caps at 12;
  `HNRAD_AI_THREADS` overrides if you want to re-measure.
* **The cache is the real interactive story.** 0.4 s on a repeat request, and
  every geometry tool in the v0.2 Analysis API then runs on the resulting
  masks in milliseconds. Segmentation is a background job with a progress
  bar; geometry is the interactive layer. This is the design assumption
  `RESEARCH.md` §2.5 asked for, now measured rather than inferred.
* Peak RSS peaks around 5.8 GB, comfortably inside 32 GB, so two jobs *could*
  run concurrently — but they would contend for the same cores, so the queue
  stays serial.

Not attempted, and the documented next lever if these numbers are not good
enough: ONNX Runtime / OpenVINO export (FLARE 2024 got an nnU-Net to 26 s/case
on CPU that way, and the Intel iGPU can be an OpenVINO *device*). No export
recipe has been published for the TotalSegmentator head/neck weights
specifically, so that is unvalidated work — see `RESEARCH.md` §2.5.

### Geometry sanity on the phantom

`overlay.py` renders the masks on the CT. On `PHANTOM_NECK` the `total` masks
land voxel-for-voxel on the right synthetic structures: trachea on the midline
air lumen (centroid i = 256 of 512), thyroid midline, common carotids
bilaterally and symmetrically (i = 202 right / 311 left), spinal cord in the
canal, C2–C5 stacked in the correct superior-to-inferior order, clavicles only
in the most caudal 18 slices, skull only in the most cranial 72. That is the
LPS→RAS round trip verified by eye on top of the unit test.

The same run also pins down the HNLNL laterality convention *on this data*:
its `_left` levels sit at i ≈ 308–330 and `_right` at i ≈ 188–214, i.e. on the
same sides as TotalSegmentator's `common_carotid_artery_left/right`, which is
known-correct. `_left` therefore appears to mean **patient** left. This is
evidence, not proof — confirm on a real case of known laterality.

## Running a model by hand

```powershell
$env:TOTALSEG_HOME_DIR = "$env:LOCALAPPDATA\HNRad\models\totalseg"
$AI = "$env:LOCALAPPDATA\HNRad\venv-ai\Scripts\python.exe"

& $AI backend\ai\run_totalseg.py --input ct.nii.gz --out out\ `
      --tasks headneck_bones_vessels craniofacial_structures --threads 12

& $AI backend\ai\run_hnlnl.py --input ct.nii.gz --out out_levels\ `
      --weights "$env:LOCALAPPDATA\HNRad\models\hnlnl\nnunet_v1_results\3d_fullres\Task110_HNLNFixed_MirrorBest\nnUNetTrainerV2__nnUNetPlansv2.1" `
      --threads 12
```

Benchmark one job the way the server runs it:

```powershell
backend\.venv\Scripts\python.exe backend\ai\bench.py --series <uid> `
    --model totalseg --tasks headneck_bones_vessels --no-cache
```
