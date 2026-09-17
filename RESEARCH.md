# Margin (hnrad) — Research Basis and Build Decisions

**Scope.** What Margin should build, borrow, and refuse to build, based on ~250 findings across
nine research sweeps (VSP/reconstruction, viewers & platforms, validation & regulatory, CT
foundation models, datasets, OAR segmentation, tumour/node AI, vessel/airway/bone, registration &
longitudinal, niche H&N tasks). 228 unique sources, all listed in section 8.

**Target machine.** Windows 11 Enterprise, no admin rights, Intel UHD 770 (no CUDA), 32 GB RAM,
Python 3.13.12 + pip 25.3 at user level, Node 20, corporate proxy. Nothing leaves the device.

**Audience.** The surgeon-author plus whoever (human or agent) implements the backlog in
`ROADMAP.md` and the algorithm specs in `TOOLS-SPEC.md`.

**How to read the verdicts.** Every recommendation is one of **adopt** (build on it now),
**evaluate** (prototype and measure before committing), **skip** (do not build; the evidence or
the licence says no). Where a feature is better served by deterministic geometry on masks than by
a model, that is stated explicitly along with the published clinical criterion it implements.

**Empirical checks run on the actual workstation while writing this document** (pip 25.3, Python
3.13.12, dry-run resolution over the corporate proxy):

| Package | Resolves on 3.13? | Version pip picked |
|---|---|---|
| `totalsegmentator` | yes | 2.18.0 (pulls `nnunetv2` 2.8.1, `torch` 2.14.0, `vtk` 9.7.0, `simpleitk` 2.5.6) |
| `nnunetv2==2.5.1` (pinned, for third-party weights) | yes | 2.5.1 |
| `torch` from `download.pytorch.org/whl/cpu` | yes | 2.14.0+cpu |
| `itk-elastix` | yes | 0.25.4 (cp311-abi3 wheel) |
| `highdicom` | yes | 0.28.1 + pydicom 3.0.2 |
| `rt_utils`, `dcmqi` | yes | 1.2.7, 1.5.7 |
| `vmtk` | yes | 1.5.1 (pins `vtk` 9.6.2 — conflicts with TotalSegmentator's 9.7.0, so isolate it) |
| `pyradiomics` | **no** | newest Windows wheel is cp38; do not depend on it |

The proxy did not block PyPI or `download.pytorch.org`. This resolves the single biggest open
question the source sweeps left ("is a separate Python 3.11/3.12 inference venv mandatory?") —
it is not mandatory for *resolution*; it is still recommended for *pin isolation* (section 2).

---

## 0. License and architecture context (added 2026-09-17 after review)

Margin is a **personal, non-commercial tool**. Non-commercial weights are therefore usable:
NVIDIA VISTA-3D (OneWay Noncommercial), nnInteractive (CC BY-NC-SA), MedSAM2, and HaN-Seg
may be used for training as well as validation. Item 10 below ("skip VISTA3D weights") is
superseded: VISTA-3D is **evaluate**. Clinical use on real patients remains an institutional
question independent of licenses.

Architecture is **AI-native with auditable numbers**: learned models do all perception
(organ, vessel, node-level, canal masks; click-prompted tumour and node contours); geometry
turns masks into the published clinical criteria (degrees of carotid contact, mm to the
pharyngeal wall, airway CSA reduction, volume against prognostic thresholds) so every AI
result carries a number drawn on the image; an LLM layer reasons over the structured
findings (report drafting, resectability flags, tumour board summary) with pixels never
leaving the device; and the backend is exposed as an MCP server so Claude can drive Margin
directly. Surgeon corrections are kept as training data for CT-foundation-embedding probes.

## 1. Executive summary

1. **Adopt TotalSegmentator now.** Its Apache-2.0 head/neck subtasks (`headneck_bones_vessels`,
   `head_glands_cavities`, `head_muscles`, `headneck_muscles`, `craniofacial_structures`, `teeth`)
   give carotid, IJV, laryngeal cartilages, hyoid, parotid/submandibular, pharynx, SCM,
   constrictors, mandible **and both inferior alveolar canals** — every mask the geometry tools
   need, with no training and no licence key.
   <https://github.com/wasserth/TotalSegmentator>
2. **Adopt the HNLNL 20-level nodal model.** The only openly released model that labels cervical
   nodal *levels* on CT (Dice 0.86 union / 0.78 per-level), and its repository is CC0-1.0 — verified.
   It turns roadmap item 7 from hand-coded landmark rules into a mask lookup.
   <https://github.com/putzfn/HNLNL_autosegmentation_trained_models>
3. **Adopt deterministic geometry, not ML, for the flagship clinical readouts.** Carotid
   circumferential contact (>270° = encasement), carotid-to-pharyngeal-wall distance (<5 mm =
   high risk), airway minimum CSA / percent reduction, prevertebral fat-plane profile, and
   tumour volume are all published clinical criteria computable in milliseconds from masks —
   auditable, explainable, and immune to the domain shift that breaks every learned model here.
4. **Adopt DentalSegmentator weights for the mandibular canal.** nnU-Net v2, Dice 92.2% internal /
   94.2% external over 7 institutions, and the Zenodo weights are **CC-BY-4.0** (verified) — a
   cleaner licence than most. Use it when TotalSegmentator's `teeth` canal is not good enough.
   <https://zenodo.org/records/10829675>
5. **Adopt `itk-elastix` for prior-vs-current alignment, and never present a warped contour as a
   measurement.** Apache-2.0, cp311-abi3 Windows wheel verified on 3.13. The DIR literature says
   bone beats soft tissue in the neck and demons-family methods rank last, so: bone-weighted rigid
   first, B-spline only as an editable suggestion with a quality indicator.
   <https://github.com/InsightSoftwareConsortium/ITKElastix>
6. **Adopt standards-compliant output from day one:** `highdicom` (SEG, SR, parametric maps),
   `dcmqi` (labelmap→SEG with coded anatomic regions — the right way to encode a Robbins level),
   `rt-utils` (RTSTRUCT, which is what radiation-oncology colleagues actually consume). All three
   verified pip-installable on this box. <https://github.com/ImagingDataCommons/highdicom>
7. **Adopt tumour volumetrics as a first-class number.** A voxel count against published
   prognostic thresholds (GTVp <30 cc; GTV-N <4 cc; GTV-P+N <50 cc) is the highest
   evidence-to-effort ratio item in the entire corpus, externally validated as recently as 2025.
   <https://www.redjournal.org/article/S0360-3016(11)01655-5/fulltext>
8. **Evaluate prompt-based interactive segmentation (nnInteractive, browser SAM) for the tumour
   and for individual nodes.** There are **no publicly released weights for any H&N GTV model**,
   so a surgeon-supplied prompt is the only route to a tumour contour — but the maintainers say
   CPU is impractically slow and the checkpoint is CC BY-NC-SA. Measure before shipping.
   <https://github.com/MIC-DKFZ/nnInteractive>
9. **Evaluate frozen CT-foundation embeddings + tiny probes as the *only* learned-model path.**
   CT-FM is MIT, 77M params, CPU-plausible; cheap linear probes predict full fine-tuning rank
   (Spearman 0.90–1.00), and a ~10-channel sparse probe beat a generative CT chat model on
   clinical F1 by 0.549 vs 0.184. Encode once overnight, train heads in minutes.
   <https://github.com/project-lighter/CT-FM>
10. **Skip: HPV-from-CT** (HECKTOR 2025 multi-centre balanced accuracy **0.56** — chance);
    **skip generative VLMs for anything spatial** (eight 3D medical VLMs average 34% on
    localisation/laterality, i.e. at or below chance, and a report in context makes them stop
    looking at the pixels); **skip `pyradiomics`** (no Windows wheel past cp38 — implement
    SUVmax/MTV/TLG directly); **skip MONAI Auto3DSeg training and VISTA3D weights** (CUDA-only
    training; NVIDIA OneWay Noncommercial weights).

---

## 2. Recommended AI stack on CPU-only Windows without admin

### 2.1 Two virtual environments (three if you use VMTK)

The sweeps assumed a mandatory Python 3.11/3.12 inference venv. Dry-run resolution on this
workstation shows that is **not** required: `totalsegmentator` 2.18.0, `nnunetv2` 2.5.1 and 2.8.1,
and `torch` 2.14.0+cpu all resolve cleanly on Python 3.13.12. Keep the environments separate
anyway, for three concrete reasons:

- **Pin isolation.** Third-party weights (DentalSegmentator, HNLNL) were produced with nnU-Net
  v2.2-era plans. nnU-Net 2.8.x has been reported to fail on Windows 11 CPU with an "old nnU-Net
  plans format" error and then hang its workers; the inference venv must be free to pin
  `nnunetv2==2.5.1` without dragging the app back.
- **VTK version conflict (verified).** `totalsegmentator` resolves `vtk==9.7.0`; `vmtk` 1.5.1 pins
  `vtk==9.6.2`. They cannot share a venv.
- **Blast radius.** A Python bump or a torch upgrade must never take the DICOM library and viewer
  offline. The app talks to inference as a subprocess, not an import.

```
hnrad/
  .venv-app        Python 3.13  FastAPI, pydicom, SimpleITK, highdicom, rt-utils, dcmqi,
                                itk-elastix, numpy, scikit-image, scipy
  .venv-infer      Python 3.13  torch(cpu), nnunetv2==2.5.1, TotalSegmentator  [fallback: 3.12]
  .venv-vmtk       Python 3.13  vmtk 1.5.1 (+vtk 9.6.2)  - only if you use VMTK centrelines
```

If anything in `.venv-infer` misbehaves at *runtime* (not resolution), rebuild it on Python 3.12;
every model reviewed targets 3.9-3.12 and that is the tested combination upstream.

### 2.2 Proxy setup (once)

```powershell
# PowerShell, user scope. Replace host/port with the KP values.
setx HTTPS_PROXY "http://proxy.kp.org:8080"
setx HTTP_PROXY  "http://proxy.kp.org:8080"
# pip also honours an explicit flag if the env vars are not picked up:
#   python -m pip install --proxy http://proxy.kp.org:8080 <pkg>
```

Weight downloads are plain HTTPS GETs from Zenodo, GitHub Releases and Hugging Face. Zenodo and
GitHub Releases worked in this session's checks. **Google Drive and Baidu NetDisk are the likely
blocks** - that rules out casually pulling SAM-Med3D checkpoints or the SegRap mirrors; plan a
manual side-load for anything hosted there.

### 2.3 App venv

```powershell
cd C:\Users\o948145\hnrad
py -3.13 -m venv .venv-app
.\.venv-app\Scripts\python -m pip install --upgrade pip

.\.venv-app\Scripts\pip install fastapi "uvicorn[standard]" pydicom==3.0.2 SimpleITK numpy scipy scikit-image highdicom rt_utils dcmqi itk-elastix
```

Notes, all verified this session:

- `highdicom` 0.28.1 requires `pydicom>=3.0.1` - pin the backend to pydicom 3.x, never 2.x. Its
  one compiled dependency, `pyjpegls`, ships a cp313 Windows wheel.
- `dcmqi` 1.5.7 installs as `dcmqi-1.5.7-py3-none-win_amd64.whl` - a wheel that bundles
  precompiled executables, no compiler needed. It puts `itkimage2segimage` on PATH; call it by
  subprocess from FastAPI. If pip ever balks, unzip the GitHub Releases `dcmqi-1.5.7-win64.zip`
  (26.8 MB) and call the `.exe` by absolute path.
- `rt_utils` on PyPI is stuck at 1.2.7 (Jan 2023). The orientation/PixelSpacing fix and
  `contour_mode='voxel_edge'` exist only on `main`; prefer
  `pip install git+https://github.com/qurit/rt-utils@main` once the proxy allows git+https.
- `itk-elastix` 0.25.4 (Aug 2026) ships `itk_elastix-0.25.4-cp311-abi3-win_amd64.whl`. The stable
  ABI tag covers 3.11 and every later CPython, so 3.13 is fine - no compiler, no conda, no CUDA.
- **Do not** plan around `sitk.ElastixImageFilter`. Elastix-enabled SimpleITK is published only as
  unofficial third-party wheels; that is a supply-chain risk on a clinical tool. Use `itk-elastix`
  for registration and stock SimpleITK for I/O, resampling and distance maps.
- **No pyradiomics.** Verified blocker: latest release 3.1.0 (May 2023), newest Windows wheel is
  cp38, and there is no MSVC build chain on this box. Everything Margin actually needs from it -
  SUVmax, SUVmean, MTV, TLG, volume, first-order HU statistics - is a handful of numpy reductions
  over a mask. Write those directly (section 3, item 12).

### 2.4 Inference venv, CPU torch, and pre-staged weights

```powershell
cd C:\Users\o948145\hnrad
py -3.13 -m venv .venv-infer
.\.venv-infer\Scripts\python -m pip install --upgrade pip

# CPU-only torch. This avoids the ~2.5 GB CUDA payload entirely.
.\.venv-infer\Scripts\pip install --index-url https://download.pytorch.org/whl/cpu torch
#   -> resolves torch-2.14.0+cpu on this box

# Pin nnU-Net for third-party weights built with the 2.2-era plans format.
.\.venv-infer\Scripts\pip install "nnunetv2==2.5.1"

# TotalSegmentator brings its own compatible nnU-Net; install it last and let it win,
# or give it its own venv if the pin fight gets ugly.
.\.venv-infer\Scripts\pip install TotalSegmentator
```

**Weight staging with `TOTALSEG_HOME_DIR`.** Default is `%USERPROFILE%\.totalsegmentator`, which
on this machine risks landing in a OneDrive-synced profile. Redirect it into the repo's data dir
and pre-fetch everything once, then run fully offline:

```powershell
setx TOTALSEG_HOME_DIR "C:\Users\o948145\hnrad\data\totalseg"
# new shell, then:
.\.venv-infer\Scripts\totalseg_download_weights -t total
.\.venv-infer\Scripts\totalseg_download_weights -t headneck_bones_vessels
.\.venv-infer\Scripts\totalseg_download_weights -t head_glands_cavities
.\.venv-infer\Scripts\totalseg_download_weights -t head_muscles
.\.venv-infer\Scripts\totalseg_download_weights -t headneck_muscles
.\.venv-infer\Scripts\totalseg_download_weights -t craniofacial_structures
.\.venv-infer\Scripts\totalseg_download_weights -t teeth
```

If the proxy blocks the download, fetch the task zips on any machine and drop them into
`%TOTALSEG_HOME_DIR%\nnunet\results\` - the layout is the only thing that matters.

**Running it.** Always name the ROIs; never run the 117-class head model blind (its forward pass
wants ~20 GB, which 32 GB can *just* survive but should not be asked to).

```powershell
$env:OMP_NUM_THREADS=8    # tune to physical cores; oversubscription hurts on this CPU
.\.venv-infer\Scripts\TotalSegmentator -i study.nii.gz -o out\ --device cpu --fast --roi_subset thyroid_gland trachea esophagus skull clavicula_left clavicula_right
.\.venv-infer\Scripts\TotalSegmentator -i study.nii.gz -o out_hn\ --device cpu --task headneck_bones_vessels
.\.venv-infer\Scripts\TotalSegmentator -i study.nii.gz -o out_teeth\ --device cpu --task teeth
```

**DentalSegmentator** (mandible, maxilla, upper/lower teeth, mandibular canal):

```powershell
# Download Zenodo record 10829675 -> Dataset112_DentalSegmentator_v100.zip (229.7 MB)
Expand-Archive Dataset112_DentalSegmentator_v100.zip -DestinationPath C:\Users\o948145\hnrad\data\nnunet\results
setx nnUNet_results "C:\Users\o948145\hnrad\data\nnunet\results"
setx nnUNet_raw     "C:\Users\o948145\hnrad\data\nnunet\raw"
setx nnUNet_preprocessed "C:\Users\o948145\hnrad\data\nnunet\preprocessed"

.\.venv-infer\Scripts\nnUNetv2_predict -i in\ -o out\ -d 112 -c 3d_fullres -f 0 -device cpu --disable_tta
```

`-f 0` (single fold, not the 5-fold ensemble) and `--disable_tta` are not optional on this
hardware - each multiplies runtime by 5 and by ~8 respectively.

**HNLNL 20-level nodal model** (the single highest-value asset in the corpus):

```powershell
# Weights are in the Releases tab of github.com/putzfn/HNLNL_autosegmentation_trained_models
# Unzip into %nnUNet_results%, then (dataset id per the release README):
.\.venv-infer\Scripts\nnUNetv2_predict -i in\ -o out_levels\ -d <id> -c 3d_fullres -f 0 -device cpu --disable_tta
```

Then reimplement the repo's `Adjust3DCNNcontoursToCTslicePlaneOrientation.py` step in numpy in the
FastAPI backend rather than depending on 3D Slicer - the paper shows slice-plane-adjusted contours
were rated significantly better than raw model output.

### 2.5 Expected runtimes - and the honest state of the evidence

**No published CPU wall-clock exists for any of these models on Intel-iGPU-class hardware.** This
is one of the most consistent gaps across every sweep. What the literature actually says:

| Anchor | Number | Source |
|---|---|---|
| TotalSegmentator `--fast`, large CT, CPU | ~70 s | TotalSegmentator README |
| TotalSegmentator, GPU (RTX 3090) reference | ~30 s | same (do not quote as a CPU figure) |
| nnU-Net exported to OpenVINO, low-res isotropic, CPU-only track | **26 s/case**, Dice 76.8% | FLARE 2024 |
| nnU-Net 3D-fullres neck CT, single fold, TTA off, CPU | several min to ~15 min | inferred, unmeasured |
| nnInteractive on CPU | "prohibitively slow", authors recommend a remote GPU | maintainers |
| itk-elastix rigid, 2 mm downsample, neck pair | seconds to tens of seconds | inferred |
| itk-elastix / ANTs SyN B-spline, full-res neck pair | minutes | inferred |
| Geometry on existing masks (arc, distance, CSA, volume) | **milliseconds** | trivially true |

**Therefore: benchmark before you promise an interactive UX.** Budget a half day to time each task
on a real 512x512x180 neck CT on this box and record the numbers in the repo. Design assumption
until then: **segmentation is a background job with a progress bar and a cached result per study,
never a click-and-wait.** Geometry on cached masks is the interactive layer.

If the measured numbers are unacceptable, the documented mitigation is ONNX Runtime / OpenVINO
export (`openvino`, `onnxruntime-openvino` are pip wheels, user-level, and the Intel iGPU can be
targeted as an OpenVINO *device*, not just the CPU). Note that no ONNX/OpenVINO export recipe has
been published for the TotalSegmentator head/neck weights specifically - FLARE 2024 proves the
approach for abdominal nnU-Net; the H&N port is unvalidated work.

### 2.6 Weight-licence caveats, stated plainly

Code licence and weight licence are different things, and for several of these they disagree.

| Component | Code | Weights | What it means for Margin |
|---|---|---|---|
| TotalSegmentator - `total`, `total_mr`, `headneck_bones_vessels`, `head_glands_cavities`, `head_muscles`, `headneck_muscles`, `craniofacial_structures`, `teeth`, `oculomotor_muscles`, `body`, `lung_vessels`, `vertebrae_body` | Apache-2.0 | Apache-2.0 | Fully usable, redistributable, commercial-safe. These are all the H&N tasks Margin needs. |
| TotalSegmentator - asterisked tasks: `heartchambers_highres`, `appendicular_bones`, `tissue_types`, `brain_structures`, `face`, `thigh_shoulder_muscles`, `coronary_arteries`, `aortic_sinuses` | Apache-2.0 | **free non-commercial key required** | Do not use. None are needed; `face` in particular is tempting and not worth the licence entanglement. |
| DentalSegmentator | Apache-2.0 | **CC-BY-4.0** (Zenodo 10829675, verified) | Usable and redistributable **with attribution**. Cite Dot G et al., J Dent 2024;147:105130. |
| HNLNL nodal levels | nnU-Net is Apache-2.0 | repo **CC0-1.0** (verified) | Public domain dedication. Confirm the release binaries carry the same terms before bundling them into a distributable build - the repo page is what was verified, not each asset. |
| nnU-Net v2 runtime | Apache-2.0 | n/a | Clean. |
| nnInteractive | Apache-2.0 | **CC BY-NC-SA 4.0** | Fine for local clinical-research use. Blocks any commercial distribution and, via share-alike, contaminates derivatives. |
| VISTA3D | Apache-2.0 | **NVIDIA OneWay Noncommercial** | Skip. H&N coverage is thin anyway. |
| MedSAM2 / SAM-Med3D | Apache-2.0 (SAM-Med3D confirmed) | MedSAM2 inherits SAM2 + curated-dataset research terms (unverified); SAM-Med3D Apache-2.0 | SAM-Med3D is the cleanest interactive option on licence grounds; its checkpoints are on Google Drive/Baidu, which the proxy will likely block. |
| SegVol | - | **not confirmed from a primary source** | Treat as restricted until the repo/HF card is actually read. |
| MedGemma 1.5 4B | - | **Health AI Developer Foundations terms**, gated download | Not Apache/MIT. Gated HF download may be proxy-blocked. Read the terms before any use. |
| MedImageInsight | - | **unknown** (HF card returned HTTP 401) | Licence is the deciding factor; unresolved. |
| CT-FM, Merlin, BiomedCLIP | MIT | MIT | Clean. BiomedCLIP's card nonetheless declares deployment out of scope. |
| HaN-Seg dataset | n/a | **CC BY-NC-ND 4.0** | Internal validation only. The no-derivatives clause blocks redistributing modified masks or any dataset derived from it. |
| Orthanc (if used as the DICOM store) | GPLv3 core, AGPLv3 DICOMweb plugin | n/a | Run it as a **separate localhost process** that Margin calls over HTTP/REST. The Orthanc licensing FAQ explicitly permits that, including with AGPL plugins installed. Never statically link or vendor it. |

**The one-line version:** everything Margin needs to ship is Apache-2.0 / MIT / BSD / CC0 / CC-BY.
Every non-commercial-encumbered item on this list is optional.

---

## 3. Per roadmap item

Evidence quality is tagged as it was in the source sweeps: **validated** (peer-reviewed result or
a directly confirmed artefact), **preliminary** (single-centre, preprint, or unconfirmed), and
**unverified** (the sweep could not open the primary source).

### Item 1 - Local DICOM library (done, v0.1)

**Verdict: keep the SQLite index, and put Orthanc behind it as an optional DICOMweb source.**
A real DICOMweb endpoint is what Cornerstone3D expects; a bespoke file walker will drift.

| How we use it | Source | Evidence |
|---|---|---|
| Standalone (non-service) Windows build of Orthanc, extracted into a user folder, bound to 127.0.0.1, `RemoteAccessAllowed false`. Gives QIDO-RS search and STOW-RS for writing SEG/RTSTRUCT back. **Separate process over REST only** - GPLv3 core / AGPLv3 DICOMweb plugin. | <https://orthanc.uclouvain.be/book/users/quick-start-windows.html> | validated |
| `idc-index` (pip, no login, no Java) to pull CC BY test series - the practical alternative to the TCIA Data Retriever desktop app on a no-admin box. | <https://portal.imaging.datacommons.cancer.gov/explore/> | validated |
| **Acquisition-adequacy gate at ingest.** Read `SliceThickness` and `ConvolutionKernel` in the pydicom layer and warn when a series is not adequate for a cortical-invasion read. The 96%/87% mandible-invasion numbers were achieved on thin-section 3 mm bone-algorithm CT; a 5 mm soft-tissue-only series does not support that call. Zero compute, highest value-per-line in the whole document. | <https://ajronline.org/doi/10.2214/ajr.177.1.1770237> | validated |
| Reference only for the data/workflow model (Kubernetes, AGPL - not deployable here). | <https://github.com/kaapana/kaapana> | validated |
| **Skip** dcm4chee-arc-light: JDK 17 + WildFly + LDAP is absurd for one workstation. | <https://github.com/dcm4che/dcm4chee-arc-light> | preliminary |

### Item 2 - Fast MPR viewer, neck presets, linked crosshairs, cine (done, v0.1)

**Verdict: stay on Cornerstone3D; copy OHIF's hanging-protocol schema rather than adopting OHIF.**

| How we use it | Source | Evidence |
|---|---|---|
| Cornerstone3D core/tools/dicomImageLoader. Shared-offscreen-WebGL-canvas design is exactly what makes 3-up MPR plus a 3D view affordable on a UHD 770. | <https://github.com/cornerstonejs/cornerstone3D> | validated |
| Copy the declarative hanging-protocol JSON schema + `seriesMatchingRules` pattern into Margin: neck CT-with-contrast to 3-up MPR; PET/CT to fusion 2x2; prior+current to compare. Zero install. **Pin the doc version you copy from** - the schema drifts between 3.10/3.11/3.12/3.13. | <https://docs.ohif.org/platform/extensions/modules/hpmodule/> | validated |
| **Hard constraint to measure on day one:** `MAX_3D_TEXTURE_SIZE` is capped at 2048 per axis, and the Intel driver may report lower. A 0.5 mm neck CT at 600-1200 slices plus a same-geometry labelmap can hit it. Read `gl.MAX_3D_TEXTURE_SIZE` on the actual box before designing the volume pipeline; plan on cropping to the neck and downsampling for the 3D view. | <https://github.com/cornerstonejs/cornerstone3D/issues/1360> | validated |
| Adopt progressive/streaming load and native-dtype textures from the start rather than retrofitting them after the first 1000-slice CTA fails. | <https://github.com/OHIF/Viewers/issues/3082> | preliminary |
| The whole OHIF viewer is MIT and can be lifted wholesale if the bespoke app stalls - but its node_modules are multi-GB, so keep them off OneDrive-synced paths. | <https://github.com/OHIF/Viewers> | validated |

### Item 3 - 3D volume rendering with H&N presets (done, v0.1)

**Verdict: WebGL2 is the target. Do not wait for WebGPU volume rendering.**

| How we use it | Source | Evidence |
|---|---|---|
| vtk-js is already in the dependency tree via `@cornerstonejs/core` - import from `@kitware/vtk.js`, do not `npm i vtk.js` (two copies break class checks in `STLWriter`). BSD-3-Clause. | <https://github.com/Kitware/vtk-js> | validated |
| VTK's own roadmap puts WebGPU image-slice and volume rendering late in 2026, and WebGPU availability in a locked-down enterprise browser is itself uncertain. Ship WebGL2; treat WebGPU as an opt-in fast path only (which is exactly what OHIF did - WebGPU for GrowCut only). | <https://discourse.vtk.org/t/vtk-webgpu-roadmap/13749> | unverified |
| NiiVue as a possible second, lighter viewport for mesh/STL display; its native-dtype texture trick is the technique to copy if GPU memory binds. | <https://github.com/niivue/niivue> | preliminary |

### Item 4 - Measurement toolkit (done, v0.1)

**Verdict: add a depth-of-invasion caliper, and ship it with its bias caveat visible.**

| How we use it | Source | Evidence |
|---|---|---|
| A perpendicular-from-mucosal-surface DOI caliper. DOI drives T stage and the elective-neck decision under AJCC 8, and there is **no automatic DOI-from-imaging model in existence** - this is a viewer feature, not an AI feature. | <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10362784/> | validated |
| **Mandatory safety caveat on that caliper.** CT and MRI systematically *overestimate* histologic DOI in oral SCC, especially below 5 mm, upstaging >50% of cases; artefacts degrade >20% of studies. Published shifted imaging cut-points (~6.2 mm and ~11.4 mm to match pathologic 5 mm and 10 mm) should be displayed alongside the raw measurement. Without this, Margin pushes surgeons toward unnecessary elective neck dissections in thin tumours. | <https://www.sciencedirect.com/science/article/pii/S0720048X20306707> | validated |
| Offer a three-diameter ellipsoid volume estimate next to the segmentation volume, with the published error bar, so the surgeon knows which number to trust. | <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4587740/> | validated |
| The LesionTracker timepoint/lesion data model is the ready-made schema for measurement tracking that feeds compare mode and the tumour-board export. | <https://doi.org/10.1158/0008-5472.CAN-17-0334> | validated |

### Item 5 - Carotid encasement tool (v0.2, next)

**Verdict: deterministic geometry on masks. This implements the AJNR / Int J Surg Oncol
>270-degree circumferential-contact criterion for unresectability. Do not use a model.**

No published model automates the carotid encasement angle end-to-end on H&N CT - Margin would be
implementing a geometrically simple derivation of a *validated clinical criterion*, which is a very
different (and much safer) claim than "our AI predicts carotid invasion".

| How we use it | Source | Evidence |
|---|---|---|
| The criterion itself: >270 degrees of circumferential tumour contact suggests unresectability; <=270 degrees suggests no true invasion. Also the source for the wider resectability checklist (prevertebral, skull base, mediastinal). | <https://www.ajnr.org/content/27/10/2024> | validated |
| The calibration numbers to display next to the angle so the readout is a probability, not just geometry: MR predicted unresectable disease with 100% sensitivity (12/12), 88% specificity (36/41), 91% accuracy; among patients with >270 degrees, true carotid invasion was found in ~71%. Encasement was missed in only ~1.5% of operable-selection cases, but interobserver variation is the real limit. | <https://onlinelibrary.wiley.com/doi/10.1155/2013/968758> | validated |
| **Report more than the angle.** A CT multivariable model found contact *length* (cut-point <=26 mm), arterial deformation, tortuosity, stenosis and loss of the intervening fat plane all predicted true wall invasion. All are derivable from the same masks plus HU sampling in the perivascular ring. | <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9582344/> | validated |
| Methodological template that survived prospective validation in another anatomy: segment tumour + vessels, then extract 3D encasement angles, benchmarked against radiologist resectability calls in 202 prospective patients. Same clinical logic, same pipeline shape. | <https://www.nature.com/articles/s41746-025-02260-3> | validated |
| Vessel masks come free from `headneck_bones_vessels` (internal carotid L/R, internal jugular L/R). **Caveat to display:** the supra-aortic vessel update was validated on *chest* CT, so the cervical ICA above the bifurcation is outside the validated range. | <https://www.ejradiology.com/article/S0720-048X(25)00092-0/fulltext> | validated |
| **Evaluate** as a fine-tuning starting point if TotalSegmentator's ICA is inadequate at the skull base: an nnU-Net ICA segmenter (Dice 0.884, avg HD 0.246 mm) that already computes structure-to-structure distances. Apache-2.0, but n=30 training scans, so expect domain shift on contrast neck CT. | <https://github.com/YuliangXiaoYLX/AutoSeg4ETICA> | preliminary |
| Use the centreline-normal cross-section (not the axial slice) as the true perpendicular plane for the angle, per the VMTK Cross-Section Analysis approach. `vmtk` 1.5.1 now has a cp313 Windows wheel (verified), so this no longer requires conda. | <https://github.com/vmtk/SlicerExtension-VMTK> | validated |

Implementation note: `TOOLS-SPEC.md` section 1 already specifies the per-slice polar sweep, the
longest-contiguous-arc handling and the clock-face output. Keep the longest-arc number - a tumour
touching the vessel in two places is not encasement, and a naive sum of contact fractions says it is.

### Item 6 - Segmentation, volumetrics, STL export (v0.2)

**Verdict: adopt the client-side labelmap to mesh to STL path; adopt volumetrics as a
decision aid; treat every auto-contour as a draft.**

| How we use it | Source | Evidence |
|---|---|---|
| **Volume as a prognostic number, not a curiosity.** Primary GTV <30 cc associated with local control 100% vs 59.4%, nodal control 100% vs 66.8%, OS 93.1% vs 61.5%. ROC work supports GTV-P <30 cc, GTV-N <4 cc, GTV-P+N <50 cc. This is `mask.sum() * prod(spacing) / 1000` - microseconds, no model. | <https://www.redjournal.org/article/S0360-3016(11)01655-5/fulltext> | validated |
| The 2025 external validation showing GTVp volume still predicts local failure, PFS and OS on multivariable analysis adjusted for stage, subsite and race - i.e. it adds information beyond T stage, which is the argument for a pre-op summary line. | <https://onlinelibrary.wiley.com/doi/10.1002/hed.70315> | validated |
| Client-side labelmap to marching cubes to decimate to binary STL, entirely in the browser, no Python round-trip. Run marching cubes in a Web Worker and decimate before export. | <https://kitware.github.io/vtk-js/examples/ImageMarchingCubes.html> | validated |
| In-browser interactive segmentation that already exists and is MIT: SAM Labelmap Assist (slice propagation, include/exclude prompt points), morphological slice interpolation, per-segment volume/intensity/centroid/SUVpeak stats, accept/edit/reject brush preview. **Gotcha:** `@cornerstonejs/ai` exact-pins `@cornerstonejs/core@5.10.6`, and the SAM vit_b ONNX weights (~178 MB, Apache-2.0) are not shipped - vendor them into `public/` once. | <https://ohif.org/newsletters/2025-04-09-ohif%20viewer%20v3.10%20with%20local%20ai%20enhanced%20segmentation%20and%20more--release-note3p10> | validated |
| Emit DICOM SEG via `highdicom` (pure Python) or `dcmqi` (`itkimage2segimage`, bundled binaries). dcmqi is preferred where the structure needs a **coded anatomic region** rather than a free-text label - which is exactly what a Robbins level needs. | <https://github.com/ImagingDataCommons/highdicom>, <https://github.com/QIICR/dcmqi> | validated |
| Emit RTSTRUCT too - radiation-oncology colleagues and planning systems consume contours, not SEG. `rt_utils` builds an RTSTRUCT from boolean numpy masks in a few lines. | <https://github.com/qurit/rt-utils> | validated |
| **Acceptance metric: surface DSC, not volumetric Dice.** Surface DSC measures deviation within a clinically derived tolerance band, i.e. how much boundary a human must actually redraw - which is what "accept vs edit" means. | <https://www.jmir.org/2021/7/e26151> | validated |
| Metric selection by problem fingerprint: Dice alone is misleading for small, tubular or boundary-critical structures (carotid, canal, airway wall). Use NSD/HD95 and detection metrics where appropriate. Reference implementation is pip-installable and Apache-2.0. | <https://www.nature.com/articles/s41592-023-02151-z> | validated |
| **Regulatory constraint on STL.** Models intended for diagnostic or surgical-planning use are expected to come from cleared segmentation software, and this review compiles the cleared platforms and the accuracy-verification methods (phantom / known-geometry checks) an in-house pipeline must implement. Label Margin's STL exports accordingly. | <https://pmc.ncbi.nlm.nih.gov/articles/PMC10080800/> | validated |
| Reference app wiring the same stack (Cornerstone3D MPR + vtk-js meshing + PolySeg WASM SEG-to-mesh + one-click STL). Read it for the wiring; its licence is unverified and it is an individual's project. | <https://github.com/vishnusureshperumbavoor/cs3d-viewer> | preliminary |

### Item 7 - Neck level mapper (v0.3)

**Verdict: adopt the HNLNL model as the primary engine; keep the landmark rules in
`TOOLS-SPEC.md` section 3 as the fallback and the cross-check. This is the single biggest
capability jump available to Margin.**

| How we use it | Source | Evidence |
|---|---|---|
| Run once per neck CT to get 20 level masks (Ia, VIa, VIb, VIIa + bilateral Ib, II, III, IVa, IVb, V, VIIb, VIII), then assign any clicked node to a level by centroid containment or mask overlap. **CC0-1.0 repository, verified.** | <https://github.com/putzfn/HNLNL_autosegmentation_trained_models> | validated |
| The methods paper: nnU-Net 3D-fullres + 2D ensemble, 35 training / 20 test planning CTs; volumetric Dice 0.86 union / 0.78 per level, surface Dice 0.89 / 0.84; geometric accuracy not different from intraobserver variability; slice-plane-adjusted contours rated significantly better than raw output. Gives the exact label indices to map to Robbins names. | <https://pmc.ncbi.nlm.nih.gov/articles/PMC9978473/> | validated |
| The published blueprint for the assignment logic itself, including nodes straddling two levels: level autosegmentation + centroid assignment correctly categorised **all 449 nodes in 193 patients**. Use the direct-segmentation variant; skip their deformable-registration variant (minutes on CPU for no gain). | <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10526893/> | validated |
| The consensus atlas defining each level's cranial/caudal/anterior/posterior/lateral/medial boundaries against CT landmarks, and the primary sites at risk per level. Use it for the human-readable boundary text shown next to an auto-assigned level. **Copyrighted - link and cite, do not embed verbatim.** | <https://www.dahanca.dk/uploads/TilFagfolk/Guideline/GUID_Atlas_neck_CTV_2014.pdf> | validated |
| Geometric cross-check from free masks: SCM, scalenes, prevertebral muscles, constrictors (`headneck_muscles`) plus hyoid, cricoid, carotid, IJV (`headneck_bones_vessels`) reproduce the landmark rules without a second model. | <https://github.com/wasserth/TotalSegmentator> | validated |
| **The sobering counter-evidence, and it is directly on point.** Seven centres, four continents, 11 nodal levels + 7 OARs: overall time savings 42% then 49%, but levels IA, IB, III, IVA and IVB showed **no significant saving**, and some centres edited longer than manual. The study **excluded post-operative cases and dental-artefact scans** - precisely Margin's surgical population. Expect the model to be weakest exactly where a surgeon needs it most. | <https://pubmed.ncbi.nlm.nih.gov/40419731/> | validated |
| Encode each level as a DICOM SEG with a coded anatomic region via dcmqi, not as free text, so the export is machine-readable downstream. | <https://github.com/QIICR/dcmqi> | validated |

**Two unresolved items before this ships.** (a) The HNLNL weights were trained on 35 arms-down RT
*planning* CTs; behaviour on diagnostic contrast neck CTs and on post-operative / post-radiation
necks is unvalidated and must be tested case by case. (b) Robbins and Gregoire/DAHANCA
nomenclature are **not** identical - Gregoire adds levels and renames boundaries. A mapping table
from the 20 model labels to surgical Robbins levels must be hand-authored and signed off by the
surgeon-author before any label reaches a report. No public dataset with Robbins-level contours
exists to validate against, so validation is the author's own manual assignment on local cases.

### Item 8 - Airway analyzer (v0.3)

**Verdict: deterministic geometry. Implements the Myer-Cotton grading and the
percent-reduction-versus-own-mid-trachea criterion. No model needed for the trachea/subglottis.**

| How we use it | Source | Evidence |
|---|---|---|
| The algorithm blueprint: centreline extraction (maximum-inscribed-sphere radius) plus cross-sectional area perpendicular to the centreline, with tables and plots. Port the Python; or now simply `pip install vmtk` (1.5.1 ships a cp313 win_amd64 wheel - **verified**, superseding the sweep's "conda-only" warning). Keep it in its own venv: it pins `vtk==9.6.2`. | <https://github.com/vmtk/SlicerExtension-VMTK>, <https://github.com/vmtk/vmtk> | validated |
| **A self-normalising stenosis metric that needs no age-matched norms:** percent reduction of subglottic CSA relative to a predicted healthy subglottis derived from the patient's own mid-trachea area. Report minimal CSA, mid-trachea CSA and percent reduction, then map to Myer-Cotton bands (I <50, II 51-70, III 71-99, IV no lumen). | <https://pmc.ncbi.nlm.nih.gov/articles/PMC5257243/> | validated |
| Airway mask: region-grow under -400 HU capped to the body mask (per `TOOLS-SPEC.md` section 4), or `larynx_air` + `trachea` from TotalSegmentator as the seed/sanity check. | <https://github.com/wasserth/TotalSegmentator> | validated |
| **The honest test set.** AeroPath is 27 CTs deliberately enriched for pathology - stenosis, tumour compression, distorted anatomy - which is exactly Margin's case mix, and exactly where models trained on normals degrade. 5 GB, NIfTI, CPU-runnable demo. Caveat: coverage is tracheobronchial and largely *below* the larynx, so supraglottic/glottic stenosis remains unvalidated. | <https://github.com/raidionics/AeroPath>, <https://arxiv.org/pdf/2311.01138> | validated |
| **Evaluate** if the trachea class is too coarse at the subglottis: ATM'22 (500 annotated airway trees, nnU-Net-class winners) and NaviAirway (thin-structure loss, pretrained weights, licence unconfirmed). Full bronchial-tree models are heavy; for trachea-only, crop to the neck and run coarse - very CPU-friendly. | <https://atm22.grand-challenge.org/>, <https://github.com/AntonotnaWang/NaviAirway> | validated / preliminary |

### Item 9 - Mandible planner (v0.4)

**Verdict: adopt DentalSegmentator (or TotalSegmentator `teeth`) for the canal; port
BoneReconstructionPlanner's geometry rather than reinventing it; ship the five cephalometric
validation metrics the open-source VSP literature already uses.**

| How we use it | Source | Evidence |
|---|---|---|
| Mandible + maxilla + upper/lower teeth + **mandibular canal** in one nnU-Net pass. Dice 92.2 +/- 6.3% internal (n=133) and 94.2 +/- 7.4% external (n=123, 7 institutions), trained on 470 CT/CBCT - explicitly CT, not just CBCT. Weights **CC-BY-4.0** (verified). | <https://zenodo.org/records/10829675>, <https://www.sciencedirect.com/science/article/pii/S0300571224002999> | validated |
| The Slicer packaging of the same model, with the README's explicit statement that it runs on CPU (slower) and wants 32 GB RAM - i.e. this exact machine. Use it as the reference wiring; call nnU-Net directly from FastAPI rather than shipping Slicer. | <https://github.com/gaudot/SlicerDentalSegmentator> | validated |
| **Cheaper first try:** TotalSegmentator's Apache-2.0 `teeth` task already outputs `left_inferior_alveolar_canal` / `right_inferior_alveolar_canal`, and `craniofacial_structures` outputs the mandible - **verified against the README this session**. Try these before adding a second nnU-Net dataset; fall back to DentalSegmentator if canal continuity is poor. | <https://raw.githubusercontent.com/wasserth/TotalSegmentator/master/README.md> | validated |
| The reference implementation for the planner itself: segment mandible + fibula, lay a reconstruction curve, auto-seed osteotomy planes from that curve, simulate the neomandible, generate miter-box and saw-box guides, export STL. **BSD-3-Clause** - the plane-from-curve seeding, centreline resampling and boolean-free miter-box geometry are exactly the algorithms Margin would otherwise invent, and they port cleanly to `vtk` on CPU. Note: optional SlicerVESPA binaries derive from GPLv3 CGAL code and are not redistributed by BRP. | <https://github.com/SlicerIGT/SlicerBoneReconstructionPlanner> | validated |
| Its methods/accuracy paper (cite anything borrowed). DOI resolved from the repo README rather than the publisher, so volume/pages are unconfirmed. | <https://doi.org/10.1016/j.stlm.2023.100109> | preliminary |
| **The validation metric set to adopt verbatim:** intercondylar distance, intergonial distance, AP distance, gonial angle, per-segment fibula length. A 25-patient open-source-planned FFF series (3D Slicer + Blender, printed reference models, freehand osteotomies) reported planned-vs-postop linear deviations of 1.53-3.05 mm with 100% flap survival - the clinical evidence that a free stack reaches acceptable accuracy. | <https://pubmed.ncbi.nlm.nih.gov/42305074/> | validated |
| **The design target.** Five VSP-naive residents: commercial CAS 91 +/- 15 min and SUS 67.5; open-source Slicer+Blender 111 +/- 26 min and **SUS 50** ("poor"). Margin exists to close that 17.5-point usability gap. Concrete goal: beat SUS 67.5 and stay under 90 min. The click-count and time-per-step methodology is directly reusable to benchmark Margin against Slicer. | <https://pubmed.ncbi.nlm.nih.gov/40271475/> | validated |
| The step-by-step in-house pipeline (which thresholds, which mesh operations, which export formats, what printing needs) written out in an open-access paper - effectively a spec for Margin's default parameters. | <https://pmc.ncbi.nlm.nih.gov/articles/PMC11613268/> | validated |
| **147 clinically derived mandibular defect models, each with its HCL (Jewer-Boyd) class label.** The only public resource pairing defect geometry with HCL labels; a ready-made PHI-free fixture set for unit tests. | <https://www.nature.com/articles/s41597-025-06048-8> | validated |
| **Evaluate** the morphometric-descriptor objective function from the automated FFF planning framework: even without their generative shape-completion model, a small set of interpretable 2D descriptors plus a scalar cost lets Margin *rank* candidate osteotomy plans instead of only displaying them. Pure NumPy/SciPy, CPU-feasible. No public repo. | <https://pubmed.ncbi.nlm.nih.gov/40132366/> | validated |
| **Evaluate the metric, not the code**, from OsteoOpt: bone-apposition area (contact surface between adjacent fibula segments and between fibula and native mandible) as a per-plan score, reported to predict 70-85% of actual year-1 bone formation. **PolyForm Noncommercial 1.0.0**, and the stack is Java + ArtiSynth + MATLAB + Python 3.8 - impractical to vendor. Borrow the definition. | <https://github.com/hamidreza-aftabi/OsteoOpt> | validated |
| **Evaluate** automatic fibula segmentation (two-step coarse-to-fine 3D U-Net, Dice 0.95, ASD <0.31 mm in the surgically relevant ROI) if Margin ever ingests a lower-extremity CTA. Weight release unconfirmed; the two-stage design is itself the right CPU pattern (fine model sees only a cropped ROI). | <https://www.nature.com/articles/s41598-025-29130-y> | validated |
| **Scope honesty.** In-house VSP is measurably *less precise* than commercial VSP, but cheaper and faster. If Margin's output is ever used for guide fabrication, disclose the accuracy gap. Even a dedicated cadaveric navigation rig lands at HD95 ~7 mm. | <https://onlinelibrary.wiley.com/doi/full/10.1002/hed.27642>, <https://pmc.ncbi.nlm.nih.gov/articles/PMC11717937/> | validated |
| Midface side: Brown class is the vocabulary surgeons expect for maxillary defects; the mirror-and-compare feature (orbital volume and orbital height versus the mirrored contralateral orbit) is low effort and high value - VSP achieved 1.78 +/- 1.33 mm orbit-height difference vs 4.25 +/- 0.95 mm freehand. | <https://onlinelibrary.wiley.com/doi/full/10.1002/hed.27352>, <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8560731/> | validated |
| The orbital analogue worth reading for the plate-to-surface distance map computation. Licence unverified. | <https://arxiv.org/abs/2512.19534> | preliminary |

**Genuine gap Margin could fill cheaply:** no open-source tool computes defect length or assigns an
HCL class from a segmented mandible. The dataset supplies the labels; the classifier does not exist.
Caveat: mirroring-based methods fail for Brown class C/D and HCL defects with no contralateral
reference - those need statistical shape modelling (PCA on aligned meshes, comfortably CPU-bound).

### Item 10 - Vascular safety flags (v0.4)

**Verdict: all four flags are deterministic geometry on masks. This is the most
differentiating, lowest-effort, highest-safety-value module in the roadmap.**

| Flag | How we compute it | Source | Evidence |
|---|---|---|---|
| **Retropharyngeal / medialised ICA** (pre-TORS, pre-tonsillectomy, pre-nasotracheal intubation) | Shortest 3D distance from the ICA mask to the posterior pharyngeal mucosal surface at the tonsillar-fossa level, per side, in mm. `SimpleITK.SignedMaurerDistanceMap` between two TotalSegmentator masks - sub-second. Colour thresholds from the reported high-risk series: **<5 mm high risk, contact = critical** (published minimum distances 3.3-4.9 mm down to direct contact). | <https://onlinelibrary.wiley.com/doi/10.1002/ca.70072>, <https://pubmed.ncbi.nlm.nih.gov/28828115/> | validated |
| ...and how to phrase it | **Do not over-warn.** Twenty patients with a retropharyngeal carotid underwent TORS with neck dissection and microvascular reconstruction with no serious vascular complications and acceptable negative margins. A medialised carotid is a planning flag that changes the reconstruction strategy, not an automatic disqualification. Extend the check to the lingual and facial branches actually encountered during resection. | <https://pubmed.ncbi.nlm.nih.gov/32621638/>, <https://pmc.ncbi.nlm.nih.gov/articles/PMC5915826/> | preliminary |
| **Aberrant right subclavian (ARSA) -> non-recurrent laryngeal nerve** | The best-validated single model in the whole corpus: 2D EfficientNet patch classifier, 556 ARSA + 312 control CTs, multicentre + temporal external validation, **AUC 0.97-0.99, sensitivity 100%, specificity 94-98.5%**, across neck CT, chest CT and CTA. **No code or weights released.** So: rule-based v1 - ARSA is a large, high-contrast vessel whose retro-oesophageal left-to-right course at the arch is detectable by simple geometry on the aorta/trachea/oesophagus masks. Clinical payoff: ARSA predicts NRLN in ~87% of cases, and NRLN injury rates are ~12.9% vs 1.2%. | <https://pmc.ncbi.nlm.nih.gov/articles/PMC11359603/> | validated |
| **High-riding innominate** (pre-tracheostomy) | Innominate artery crossing anterior to the trachea at or above the sternal notch plane, from the same contrast-vessel mask. Per `TOOLS-SPEC.md` section 5. No dedicated literature found - present it as a geometric observation, not a validated criterion. | - | (none) |
| **IJV patency / thrombosis** | Report patency, cross-sectional area versus the contralateral side, intraluminal filling defect, and whether the defect *enhances*. The four mechanisms to distinguish are bland thrombus, tumour thrombus, extrinsic compression/invasion, and post-dissection fibrotic collapse; CT signs of tumour thrombus are tumour-like attenuation, irregular luminal expansion and post-contrast enhancement. All are mask statistics plus HU sampling. | <https://www.sciencedirect.com/science/article/abs/pii/S0748798321001128> | validated |

**No public dataset with annotated vascular variants exists** (retropharyngeal ICA, ARSA,
high-riding innominate). Validation has to be prevalence-based against published case series plus
the surgeon's own confirmed cases - which is a reason to log every flag and its adjudication from day one.

### Item 11 - Compare mode (v0.5)

**Verdict: adopt `itk-elastix`; bone-weighted rigid first; a propagated contour is an editable
suggestion with a quality score, never a measurement.**

| How we use it | Source | Evidence |
|---|---|---|
| Registration engine: rigid, affine and B-spline with ready-made parameter-map presets, multi-threaded CPU, no GPU, stored parameter maps making each comparison reproducible and auditable. `itk_elastix-0.25.4-cp311-abi3-win_amd64.whl` - verified installable on this box's 3.13. | <https://github.com/InsightSoftwareConsortium/ITKElastix>, <https://proceedings.scipy.org/articles/gerudo-f2bc6f59-00d> | validated |
| **Which algorithm class to use, and which to avoid.** Ten DIR algorithms compared for neck contour propagation: markedly better on bone than soft tissue; optical-flow methods best; **demons-based methods usually worst**; auto-propagated contours required review before clinical acceptance. | <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5393623/> | validated |
| The neck's specific problem is flexion/extension between studies. A phantom study imposing up to 8 mm neck flexion showed deformable registration stayed valuable, with improvements on the order of the ~3 mm margins used clinically. Justifies two-stage: bone-weighted rigid init, then constrained B-spline. Set expectations at a few millimetres. | <https://pmc.ncbi.nlm.nih.gov/articles/PMC7067662/> | validated |
| **Show a per-case registration-quality indicator** (post-registration mutual information + a Jacobian-determinant sanity check) rather than silently trusting the warp: DIR uncertainty in the neck is comparable to interobserver contouring variation. | <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6036371/> | validated |
| **Evaluate** ANTsPy (`ants.registration` SyN + `apply_transforms` is the cleanest way to carry a prior contour forward). Apache-2.0; SyN on a full neck CT is minutes on CPU, so run it as an async job. Python 3.13 wheel availability was **not** verified. | <https://github.com/ANTsX/ANTsPy> | validated |
| **Reference only** - learned registration. uniGradICON, TransMorph and VoxelMorph checkpoints are brain- or thorax-centric; a learned warp in the neck is off-distribution and unvalidated, and there is no neck training set on a local-only device. | <https://github.com/uncbiag/uniGradICON>, <https://github.com/junyuchen245/TransMorph_Transformer_for_Medical_Image_Registration>, <https://github.com/voxelmorph/voxelmorph/wiki> | preliminary / validated |
| **The surveillance report schema:** NI-RADS, with independent primary-site and neck categories, each carrying its own management recommendation, plus the 2025 MRI-specific descriptors. Encode the lexicon as a local JSON file - no network, no model, no licensing cost. | <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12805746/> | validated |
| Posterior-risk numbers to show next to a category so the surgeon sees a calibrated probability: category 1 showed 0% recurrence and category 4 showed 100% recurrence at both primary and neck sites in a pilot where recurrence occurred at 36% of primary and 27% of neck sites. | <https://pmc.ncbi.nlm.nih.gov/articles/PMC13454081/> | preliminary |
| Score the **first post-op baseline**, not only the 3-month scan - early post-operative NI-RADS carries prognostic signal in high-risk oral cavity SCC. Directly relevant to a surgeon following their own patients. | <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12872724/> | preliminary |
| Justification for the volume-trend chart: percent volume change between baseline and post-treatment imaging significantly affected OS (p=0.026) and DFS (p=0.028); serial volumetry at weeks 1-2 already improves prediction of later volume. | <https://link.springer.com/article/10.1007/s00405-019-05323-w>, <https://pmc.ncbi.nlm.nih.gov/articles/PMC11261256/> | validated / preliminary |
| **Skip** automated NI-RADS category assignment. No open-source validated tool does it; all published work is human-read scoring. Margin provides structured data entry plus the lexicon, not a category. | <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12805746/> | validated |

### Item 12 - PET/CT fusion, SUV, MTV (v0.5)

**Verdict: port the SUV conversion logic rather than inventing it; implement MTV/TLG directly in
numpy; no pyradiomics.**

| How we use it | Source | Evidence |
|---|---|---|
| **The highest-value copy-the-logic finding for PET.** A readable Python implementation of header-driven SUV conversion: decay correction from `RadiopharmaceuticalStartTime` and half-life, `Units` handling (BQML vs CNTS vs PROPCPS), SUVbw = activity concentration / (injected dose / body weight). The multi-vendor decay-time and units quirks are what silently break home-grown SUV code. | <https://github.com/QIICR/Slicer-PETDICOMExtension/blob/master/DICOMPETSUVPlugin/DICOMPETSUVPlugin.py> | validated |
| Independent cross-check: run one anonymised PET series through the SUV factor calculator (SUVbw, SUVlbm, SUVbsa, SUVibw) and compare before trusting Margin's number clinically. | <https://github.com/QIICR/Slicer-SUVFactorCalculator> | validated |
| The MTV segmentation convention to implement: selectable **41%-of-SUVmax** thresholding and fixed SUV 2.5. LIFEx is the widely cited reference implementation and a validation oracle - but it is a Java desktop app, free-for-research, not open source, and not embeddable. | <https://www.lifexsoft.org/index.php/resources/overview> | validated |
| Why MTV/TLG and not just SUVmax: MTV and TLG of the primary predicted local response to chemoradiotherapy, outperforming SUVmax as prognostic markers. | <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4302687/> | validated |
| Fusion viewport API: one CT actor plus one resampled PET actor in the same `VolumeViewport`; `setColormap`/`setOpacity` take a `volumeId` so CT stays greyscale while PET gets hot-metal with an opacity slider. PET must be resampled onto the CT frame of reference server-side (SimpleITK). | <https://www.cornerstonejs.org/docs/api/core/classes/volumeviewport/> | validated |
| Mirror OHIF's SUV-unit plumbing (`petSeriesModule` modality units, so measurement statistics report SUV rather than raw counts) plus its window-level/colormap/transparency components. MIT - lift the patterns. | <https://ohif.org/release-notes/3p7/> | validated |
| **Unknown-primary hotspot map.** Implement as a deterministic anatomic checklist (both tonsils, both tongue-base halves, pyriform sinuses, nasopharynx) with the pooled **40% (95% CI 31-49%)** detection rate displayed so the tool does not overpromise. | <https://link.springer.com/article/10.1007/s40336-021-00429-w> | validated |
| ...and annotate each hotspot with its **site-specific false-positive prior**: FP rate 39.3% in the tonsils vs 21.4% at the tongue base vs 8.3% in the hypopharynx; overall sensitivity 88.3%, specificity 74.9%. A tonsillar hotspot is much weaker evidence than a hypopharyngeal one - exactly the nuance that should precede a directed biopsy or lingual tonsillectomy. A small static lookup table. | <https://www.sciencedirect.com/science/article/pii/S2090074013000765> | validated |
| **Evaluate** before hard-coding a numeric prior for the HPV-positive unknown-primary population: only the abstract was reviewed. | <https://pubmed.ncbi.nlm.nih.gov/40719095/> | validated |
| **Evaluate, behind an explicit button, never on study open:** nnU-Net with PET+CT concatenated channels is the evidence-backed baseline for automatic lesion segmentation, and the autoPET benchmark showed elaborate variants buy little. Whole-body CPU inference is many minutes and the models are not neck-specific. | <https://www.nature.com/articles/s42256-024-00912-9> | validated |
| **Skip pyradiomics** (verified: no Windows wheel past cp38). SUVmax = max over mask; MTV = voxel count x spacing; TLG = mean SUV x MTV. These are three numpy reductions. | <https://pmc.ncbi.nlm.nih.gov/articles/PMC13413217/> | validated |

### Item 13 - AI organ segmentation on CPU (v0.6)

**Verdict: TotalSegmentator is the backbone; validate it locally before showing any confidence
number; never quote the 0.943 whole-body figure as an H&N accuracy claim.**

| How we use it | Source | Evidence |
|---|---|---|
| The five (now seven, with `craniofacial_structures` and `teeth`) Apache-2.0 H&N subtasks and exactly what each outputs - see section 2.4 for the task list and section 2.6 for the licence split. | <https://github.com/wasserth/TotalSegmentator> | validated |
| The citable evidence base: 104 structures, Dice 0.943 on a test set deliberately including major pathology. **This is a whole-body average and must not be presented as per-structure H&N accuracy.** | <https://pubs.rsna.org/doi/full/10.1148/ryai.230024> | validated |
| The honest ceiling to show clinicians instead: the HaN-Seg challenge winner reached **DSC 76.9% and HD95 3.5 mm averaged over 30 H&N OARs**. SegRap2023 (45 OARs, 400 CTs) reported OAR Dice 76.68-86.70% and GTV 70.42-73.44% - large OARs near clinical grade, small/thin structures still weak. Use these to set the per-structure confidence hint next to each contour. | <https://www.sciencedirect.com/science/article/pii/S0167814024006807>, <https://arxiv.org/abs/2312.09576> | validated |
| **Evaluate** as an alternative backend if nnU-Net packaging becomes painful: a SegResNet retrained on the TotalSegmentator dataset, shipped as a self-contained MONAI bundle (config-driven, no plans/fingerprint directory), with a 3.0 mm variant that is the practical CPU choice. No H&N-specific labels beyond the TS v1 104 set - no hyoid, cricoid, IJV or constrictors. | <https://github.com/Project-MONAI/model-zoo/tree/dev/models/wholeBody_ct_segmentation> | validated |
| **Evaluate** the CPU-latency mitigation: nnU-Net exported to OpenVINO at low isotropic resolution reached Dice 76.8% / NSD 80.5% at **26 s per case on CPU** under strict resource limits. `openvino` and `onnxruntime-openvino` are pip wheels; the Intel iGPU can be an OpenVINO device. | <https://link.springer.com/chapter/10.1007/978-3-031-96202-8_9> | validated |
| **Evaluate** the MONAI Label client/server topology - a local inference server the Cornerstone3D front end talks to over HTTP is the same topology Margin already has, and the OHIF client plugin is already written and Apache/MIT. Its docs assume CUDA; borrow the protocol, not the server. | <https://github.com/Project-MONAI/MONAILabel> | validated |
| **Skip** MONAI Auto3DSeg as a segmenter - it is a *training* AutoML system and training requires CUDA. Relevant only if Margin ever trains on locally curated contours. | <https://github.com/Project-MONAI/tutorials/blob/main/auto3dseg/README.md> | validated |
| **The state of the art Margin cannot have.** Individual pathological cervical lymph node instance segmentation has no permissively licensed released model; the literature says plainly there is still no free, high-performing, adaptable open-source solution for H&N nodal autosegmentation. Nodal *levels* are solved openly; node picking stays prompt-based or manual. | <https://www.nature.com/articles/s41598-024-84804-3> | validated |
| **Evaluate** the node-finding half if it ever becomes available: U-Net + adapted spatial-context network on 25,119 slices from 221 *normal* neck CTs, Dice 0.8084 for 5-10 mm nodes. Largely 2D, so CPU inference is minutes at worst. Trained on normal necks, so sensitivity on necrotic/matted nodes is unproven; no public weights found. | <https://pmc.ncbi.nlm.nih.gov/articles/PMC11612088/> | preliminary |
| **Evaluate** prompt-based 3D segmentation for the tumour and for individual nodes - the only route to a GTV, since no public H&N GTV weights exist. nnInteractive (Apache-2.0 code / **CC BY-NC-SA checkpoint**) is the best UX but its maintainers say CPU is impractically slow; SAM-Med3D is Apache-2.0 end to end but its checkpoints sit on Google Drive/Baidu; MedSAM2 needs quantisation and its checkpoint terms are unverified. Prototype on a cropped ROI and measure. | <https://github.com/MIC-DKFZ/nnInteractive>, <https://github.com/openmedlab/SAM-Med3D>, <https://github.com/bowang-lab/MedSAM> | validated / preliminary |
| **Evaluate** text-prompted segmentation ("left internal jugular vein") as an interactive fallback where TotalSegmentator has no label - but its licence is not confirmed from a primary source. | <https://github.com/BAAI-DCAI/SegVol> | preliminary |
| **Skip** VISTA3D: 127 classes but largely thoraco-abdominal, ViT-scale encoder (many minutes per neck CT on CPU), and **NVIDIA OneWay Noncommercial weights**. | <https://github.com/Project-MONAI/VISTA/blob/main/vista3d/README.md> | validated |

**On CT-only auto-GTV, if it is ever attempted:** the honest ceiling for CT-only (no PET) GTV
contouring is median Dice ~0.6-0.7 with surface Dice 0.30-0.56 and HD95 14.7-19.7 mm, and a single
user click to seed the crop materially helps. Present any such contour as a draft a surgeon edits,
never as a measurement. <https://www.nature.com/articles/s41598-023-48944-2>

### Item 14 - Reporting, tumour board export, de-identified sharing (v0.6)

**Verdict: everything in DICOM; a model card per bundled model; and a hard line about what Margin
is allowed to claim.**

| How we use it | Source | Evidence |
|---|---|---|
| Emit outputs as standard DICOM objects - SEG for segmentations, Parametric Map for SUV maps, SR (TID1500) for measurements, Presentation States for saved layouts - so KP's PACS and any other viewer can read them. Strongly preferred over hand-rolling datasets in pydicom. | <https://github.com/ImagingDataCommons/highdicom>, <https://link.springer.com/article/10.1007/s10278-022-00683-y> | validated |
| Reuse the **CC BY 4.0 standardised OAR-name mapping file** from HNC-IMRT-70-33 for structure-name normalisation in the export - it is freely downloadable independently of the (controlled-access) images, and is arguably the more useful half of that collection. | <https://www.cancerimagingarchive.net/collection/hnc-imrt-70-33/> | validated |
| **The decisive regulatory fact.** Software that acquires, processes or analyses a medical image fails criterion 1 of the Cures Act Non-Device CDS test - so segmentation, encasement degrees, minimum CSA and SUV/MTV are all *device* functions and cannot use the CDS exemption. That is the argument for keeping Margin strictly local, unmarketed, personal-practice/research use, and for documenting that intent explicitly in the repo. A revised final guidance dated 6 Jan 2026 supersedes the 2022 version. | <https://www.fda.gov/regulatory-information/search-fda-guidance-documents/clinical-decision-support-software> | validated |
| The best-articulated template for what an in-house clinical software tool must document even where no equivalent US rule exists: design rationale, why no commercial product suffices, a quality system, and use confined to the institution. | <https://health.ec.europa.eu/system/files/2023-01/mdcg_2023-1_en.pdf> | validated |
| **A model-card JSON per bundled model** recording training data, subgroup performance, version and monitoring plan, surfaced in the UI. If a model is ever swapped, that is change control, not silent replacement. | <https://www.fda.gov/medical-devices/medical-devices-news-and-events/cdrh-issues-guiding-principles-predetermined-change-control-plans-machine-learning-enabled-medical> | validated |
| **If Margin ever auto-drafts tumour-board text**, BLEU/ROUGE are worthless. Use the GREEN error taxonomy as the acceptance gate - error-typed and explainable, auditable by a surgeon. Cheapest version: use the taxonomy as a manual review checklist, which costs nothing. | <https://arxiv.org/abs/2405.03595v2> | validated |
| ...and design against this specific failure: when a radiology report is supplied in context, swapping the image changed a medical VLM's answer only **4.26%** of the time versus 20.94% without the report. A tool meant to catch what the report missed must not be fed the report alongside the pixels. | <https://arxiv.org/abs/2609.15635v1> | preliminary |
| Grounded reporting - each generated sentence carrying a region pointer - is the right safety architecture if narrative text is ever generated at all. | <https://arxiv.org/abs/2406.04449v2> | validated |
| Reality check on automated CT reporting generally: state-of-the-art clinical macro-F1 for 3D CT report generation is still around **50%**. Not close to clinical reliability. | <https://arxiv.org/abs/2608.08713v1> | preliminary |

---

### T-stage descriptor: thyroid cartilage invasion (T3 vs T4a)

**Verdict: ship a graded, measurement-backed flag. Never emit a T stage.**

The clinically decisive split - focal (T3) versus extensive or extralaryngeal (T4a) involvement -
is explicitly unsolved. An ensemble ML model reported 96.54% accuracy and AUC 0.99 for *detecting*
infiltration, and its own authors state plainly that it **cannot distinguish focal from extensive
or extralaryngeal** involvement. That is the distinction that changes the operation.

| How we use it | Source | Evidence |
|---|---|---|
| The cartilage mask itself is free: `thyroid_cartilage`, `cricoid_cartilage`, `hyoid` from `headneck_bones_vessels`. From it, report sclerosis/erosion quantitatively - HU statistics inside and just outside the cartilage mask, side-to-side asymmetry, and whether tumour signal crosses the inner or outer cortex. | <https://github.com/wasserth/TotalSegmentator> | validated |
| The most implementable near-term learned path if local labels ever exist: handcrafted radiomics on a cartilage ROI outperformed subjective radiologist criteria. Open access with a reproducible feature pipeline. **But** the pyradiomics wheel problem (section 2.3) means reimplementing the first-order and GLCM features directly. | <https://link.springer.com/article/10.1186/s40644-020-00359-2> | preliminary |
| A 2D deep-learning signature reached AUC 0.835 internal / 0.804 external, and **2D outperformed 3D** - convenient for CPU deployment. No code or weights released; training data would have to be local. Reference/template only. | <https://www.nature.com/articles/s41598-025-23809-y> | preliminary |
| The text to quote in the UI disclaimer. | <https://pmc.ncbi.nlm.nih.gov/articles/PMC12654700/> | preliminary |

### T-stage descriptor: mandible invasion (cortical vs medullary)

**Verdict: no model. A DICOM-header adequacy gate plus the canal/cortex geometry, with the
human benchmark stated.**

| How we use it | Source | Evidence |
|---|---|---|
| The human benchmark and the acquisition requirement: thin-section 3 mm CT reconstructed with a **bone algorithm** detected mandibular invasion with 96% sensitivity, 87% specificity, 89% PPV, 95% NPV. Any AI would have to beat that. Implement the zero-compute half now: check `SliceThickness` and `ConvolutionKernel` and warn when the series does not support the read. | <https://ajronline.org/doi/10.2214/ajr.177.1.1770237> | validated |
| Mandible + inferior alveolar canal masks for the marginal-vs-segmental question. | <https://zenodo.org/records/10829675>, <https://raw.githubusercontent.com/wasserth/TotalSegmentator/master/README.md> | validated |
| **Second-read module for equivocal marrow involvement:** an MRI radiomics/ML model framed explicitly around the marginal-vs-segmental decision. Margin is CT-first; MRI ingest is already covered by pydicom/SimpleITK. | <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11564286/> | preliminary |
| Per-tooth labels for "which teeth sit in the planned segment": ToothFairy2/3 give FDI-numbered teeth and the canal, and OraSeg does tooth instance segmentation (Dice 0.8316) - but both are **CBCT**, so expect degradation on contrast neck CT, and OraSeg is **non-commercial only** with a Mamba backbone that may assume CUDA. DentalSegmentator remains the better CT-domain choice. | <https://toothfairy3.grand-challenge.org/>, <https://www.sciencedirect.com/science/article/pii/S1361841526001647>, <https://pmc.ncbi.nlm.nih.gov/articles/PMC12464119/> | validated / preliminary |
| **Osteoradionecrosis risk, if and only if RTDOSE/RTSTRUCT are retrievable locally:** classical ML on DVH parameters is the workhorse, and the follow-up work argues for **per-subregion** mandible dose (ramus, body, symphysis, dentate vs edentulous) rather than one global DVH - which is also how a surgeon reasons about an ORN resection. DVH from RTDOSE + RTSTRUCT is numpy + pydicom; a sklearn logistic model is milliseconds. Deliberately skip the 3D deep-learning arm. | <https://pmc.ncbi.nlm.nih.gov/articles/PMC8010531/>, <https://www.sciencedirect.com/science/article/pii/S245210942200269X> | preliminary |
| Closest existing implementation of the per-subregion ORN idea (auto-annotates mandible, maxilla and dental subregions with per-structure dose). Preprint; licence unknown; verify before reuse. | <https://www.medrxiv.org/content/10.1101/2025.11.23.25340237.full.pdf> | preliminary |

### T-stage descriptor: prevertebral fascia invasion

**Verdict: a rule-out only. Margin must be able to say "prevertebral plane preserved" and must
refuse to assert invasion.**

MRI predicted *absence* of prevertebral invasion with NPV 100% and specificity 95.2%; CT achieved
NPV 99.2% and specificity 88.2%. Imaging is strong at ruling out and weak at ruling in, and the
retropharyngeal fat plane is frequently absent in normal patients - which is exactly why the
positive read has poor specificity. Invasion can ultimately only be settled intraoperatively.

| How we use it | Source | Evidence |
|---|---|---|
| The performance numbers that justify the rule-out framing. | <https://pubmed.ncbi.nlm.nih.gov/25416240/> | validated |
| The explicit anatomical rule and the false-positive caveat text for the UI. | <https://www.ajronline.org/doi/10.2214/ajr.170.5.9574622> | validated |
| The computation: a sampled HU profile along the line between the pharynx/tumour ROI and the vertebral body / longus colli, reporting fat-plane thickness in mm. Zero ML, instant on CPU, using the `prevertebral` muscle masks from `headneck_muscles` and the vertebral bodies from `total`. | <https://github.com/wasserth/TotalSegmentator> | validated |

### Extranodal extension (ENE)

**Verdict: not implementable locally today. Build the node-crop plumbing; do not show a number.**

The evidence for the *concept* is now strong. The evidence that Margin can *run* it is zero: no
public weights or code exist for any ENE classifier.

| Finding | Number | Source | Evidence |
|---|---|---|---|
| The reference multi-institutional result | External institution AUC 0.84 / accuracy 83.1% vs radiologist AUCs 0.70 and 0.71; TCGA AUC 0.90 / 88.6% vs radiologist 0.60 and 0.82 | <https://ascopubs.org/doi/abs/10.1200/JCO.19.02031?af=R> | validated |
| The original DualNet methods paper (open access - the citation to show a surgeon when explaining what a radiologic ENE score means) | AUC 0.91 ENE, 0.91 nodal metastasis | <https://www.nature.com/articles/s41598-018-32441-y> | validated |
| The strongest externally validated result to date, and the accuracy bar | 289 patients, 1954 pathologically confirmed nodes; internal AUC 0.93, external 0.96 / 0.87 / 0.90; outperformed five board-certified H&N specialists | <https://pubmed.ncbi.nlm.nih.gov/41528225/> (also indexed as <https://pubs.rsna.org/doi/10.1148/radiol.250332>) | validated |
| The reproducible architecture, if Margin ever trains its own | nnU-Net node segmentation then radiomic-vs-deep classification, with outcome linkage rather than bare AUC. Single-centre, no external validation - a design template, not a validated claim | <https://pubmed.ncbi.nlm.nih.gov/41026592/> | preliminary |
| The systematic review's two lessons | Report decision-curve / per-1000-patients impact, not just AUC; and the field's external-validation record is thin, so label any ENE feature **investigational** in the UI and in the export. A generalist VLM reached sensitivity 1.00 but specificity **0.34** | <https://pmc.ncbi.nlm.nih.gov/articles/PMC12711475/> | validated |
| **The number that governs the design** | AUC dropped 0.96 to 0.87 across external sites. Any borrowed ENE model must be locally validated on Kaiser scans before a number is shown to a surgeon | <https://pubmed.ncbi.nlm.nih.gov/41528225/> | validated |
| If an ENE model ever arrives, make it explainable | A gradient-mapping explainable 3D DNN produces saliency over the node, mapping cleanly onto a Cornerstone3D heatmap layer over the node crop. Backward pass on a small patch is seconds on CPU | <https://arxiv.org/pdf/2201.00895> | preliminary |

**What to build now:** the node-centred crop pipeline (click a node, get a 64^3 patch in the right
frame with spacing metadata), because every published ENE architecture consumes exactly that, and
because it is also what the level-assignment and volumetrics features need. Ship no ENE score.

### HPV status from CT

**Verdict: skip. This is the clearest skip in the corpus.**

HECKTOR 2025, >1100 patients across 10 centres, 35 teams, 15 final submissions: best HPV-status
**balanced accuracy 0.56** - near chance.
<https://arxiv.org/abs/2606.20143> (verified this session), <https://hecktor25.grand-challenge.org/tasks-and-evaluation/>

Single-centre AUCs look much better and do not survive multi-centre testing: a 3D CNN pretrained on
sports video clips reached AUC 0.81 externally (<https://arxiv.org/pdf/2011.08555>), and a
radiomics + off-the-shelf-deep-features study reached AUC ~0.79 with a stated public code release
(<https://pmc.ncbi.nlm.nih.gov/articles/PMC12059277/>). Read side by side with 0.56, the single-centre
numbers are the reason to skip, not a reason to try. The blocker here is evidence quality, not
compute - a radiomics pipeline on a GTV mask would run in seconds. Do not ship it.

### Perineural spread and skull base foramina

**Verdict: adopt a non-ML symmetry checklist. Highest value-per-effort item in the niche sweep.**

| How we use it | Source | Evidence |
|---|---|---|
| The rule set: obliteration of fat within skull base foramina, nerve enlargement and enhancement, and bony foraminal widening or destruction, organised by nerve (V2, V3, VII, Vidian) and primary site. Implement as **side-to-side fat-attenuation and cross-sectional-area asymmetry** at foramen ovale, foramen rotundum, stylomastoid foramen, Vidian canal and pterygopalatine fossa. HU statistics and area symmetry inside a mirrored ROI - milliseconds, pydicom + SimpleITK only. | <https://jnm.snmjournals.org/content/60/3/304> | validated |
| How to place those ROIs automatically: **the multi-atlas half** of a hybrid foramina framework - register a labelled skull-base atlas to the patient CT, then apply the symmetry metrics. No trained network, no weights to license. SimpleITK affine + B-spline on a skull-base crop is tens of seconds. Skip their Mamba component. | <https://link.springer.com/article/10.1007/s44443-026-00640-7> | preliminary |
| CN VII specifically (also serving the parotid facial-nerve plane): DL cranial-nerve segmentation is feasible but needs thin-slice heavily T2-weighted MRI (CISS/FIESTA), not routine contrast neck CT. A second-modality add-on, no public weights - design reference only. | <https://pmc.ncbi.nlm.nih.gov/articles/PMC13264006/> | preliminary |
| **The feasibility warning that applies here more than anywhere.** A frozen-feature benchmark of ten CT encoders found detectability scales with a finding's contrast against surrounding tissue: widespread or high-contrast abnormalities are reliably detected, **small low-contrast focal lesions fail across all encoders**. That is perineural spread, early cartilage invasion and early ENE precisely. Foundation-model features will not solve these. | <https://arxiv.org/abs/2608.05960v1> | preliminary |

**Gap:** no permissively licensed skull-base foramina atlas was found. The ROI atlas has to be
built in-house from a few annotated CTs, or derived by registration from an existing craniofacial atlas.

### Parathyroid (4D-CT)

**Verdict: adopt the cheap version - multiphase first-order HU statistics and a washout curve in
a user-placed ROI. No model file.**

| How we use it | Source | Evidence |
|---|---|---|
| Parathyroid adenomas and lymph nodes carry statistically distinct radiomic signatures on arterial-phase 4D-CT, **with the largest separation in first-order features** - i.e. simple intensity statistics, not exotic texture matrices. So: report mean/SD/percentile HU across the phases inside a user-placed ROI, plus the classic arterial-enhancement and washout curve per candidate. Instant on CPU. The real engineering work is reliable phase identification and inter-phase registration, both of which SimpleITK handles. | <https://pubmed.ncbi.nlm.nih.gov/41270058/> | preliminary |
| **Evaluate** a UI pattern, not a model: slice-level classification maps cleanly onto the viewer - highlight candidate slices in the scrollbar so the surgeon jumps straight to them. Deliberately lightweight residual architecture; weights not confirmed available. | <https://pmc.ncbi.nlm.nih.gov/articles/PMC13509628/> | preliminary |

**Gap:** no public thyroid or parathyroid 4D-CT dataset was located, so there is nothing to
validate against except local cases.

### Thyroid nodules / TI-RADS

**Verdict: out of scope for now, but adopt its architecture as a principle.**

The explainable TI-RADS decomposition - predict each ACR descriptor separately (composition,
echogenicity, shape, margin, echogenic foci) and sum to a level, rather than emitting one opaque
malignancy score - is **the correct architecture for every Margin module**, not just thyroid.
Auditable descriptor-level findings a surgeon can check against the images.
<https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10459295/>. Ultrasound sits outside Margin's CT/MR
DICOM core and would need a separate ingest path; TN5000 (5,000 annotated B-mode images with biopsy
confirmation) is the substrate if it is ever added.
<https://www.nature.com/articles/s41597-025-05757-4>

### Difficult airway from CT

**Verdict: evaluate the morphometric arm only. Novel, but no published thresholds to anchor it.**

Difficult-airway prediction from CT is essentially unstudied as a standalone problem - the ML
literature is dominated by facial photographs and ultrasound. What is transferable is the
**morphometric** half: thyromental distance, mandibular length and gonial angle (retrognathia),
and airway cross-sectional area, all measurable directly from the `craniofacial_structures`
mandible mask and the airway mask as pure geometry. That produces an auditable table, not a black
box; the XGBoost/sklearn tail is negligible in cost. Copy the morphometrics, not the photo arm.
<https://www.nature.com/articles/s41598-024-65060-x>

Because no CT-specific thresholds are published, present these as measurements with the
contralateral/normal-range context, not as a "difficult airway: yes" flag.

### Parotid: deep vs superficial lobe

**Verdict: a genuine gap and a differentiating feature - but label it clearly as Margin's own
unvalidated geometric approximation.**

Whole-gland parotid segmentation is solved (U-Net variants at AUC ~0.96, and the mask is free from
`head_glands_cavities`). **No published model divides deep from superficial lobe.** The plan is a
geometric surrogate for the facial nerve plane - derived from the retromandibular/posterior facial
vein and the stylomastoid foramen - then classify the tumour centroid relative to that plane.
No paper validates that approximation on CT, so it must be presented as a computed plane the
surgeon can see and move, not as an anatomic fact.
<https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9955422/>

### Resectability as a single AI score

**Verdict: skip.** The only direct AI-resectability precedent found for oral cavity cancer is a
single-site pilot distinguishing borderline- from upfront-resectable buccal mucosa cancer at F1
~0.8, with no released weights and too small a sample to trust clinically. It belongs in Margin as
a *citation for why* deterministic geometric criteria - carotid arc, prevertebral plane, pterygoid
involvement - beat an opaque resectability score today.
<https://pmc.ncbi.nlm.nih.gov/articles/PMC12469078/>

### Foundation models and VLMs, as a class

**Verdict: one narrow adopt, everything else evaluate or skip.**

| Judgement | Reasoning | Source |
|---|---|---|
| **Adopt (later, and only as a pattern):** frozen encoder + ~10-channel sparse probe | Each radiological finding is encoded by roughly 10 vision-encoder channels; the resulting probe beat a published CT chat model on clinical-efficacy F1 **0.549 vs 0.184** at far lower latency, and it is inherently auditable - you can show which channels drove a flag | <https://arxiv.org/abs/2607.20993v1> |
| **Adopt:** choose encoders by cheap linear probes, never by fine-tuning | Probe-vs-fine-tuning rank agreement Spearman 0.90-1.00. A matrix solve on cached embeddings is trivially CPU-feasible; fine-tuning on this box is not | <https://arxiv.org/abs/2607.22771v2> |
| **Adopt as the candidate backbone:** CT-FM | MIT, 77M-param convolutional SegResEncoder (~300 MB fp32), pretrained on 148,000 CTs, whole-body Dice 0.898. The only class of CT foundation model realistically runnable here. Cache embeddings once per study overnight | <https://github.com/project-lighter/CT-FM> |
| **Evaluate:** cache-embeddings-then-train-a-small-head adaptation | Anatomy-contextualised adaptation of a frozen backbone trains in under an hour once embeddings are cached - the only realistic fine-tuning strategy without a GPU | <https://arxiv.org/abs/2607.27154v2> |
| **Evaluate:** Merlin, VoxelFM, MedImageInsight | Merlin is MIT and pip-installable but pretrained on *abdominal* CT (neck is out of distribution) and documents no CPU path; VoxelFM's language-free self-distillation is the right shape (no hallucination surface) but weight release is unconfirmed; MedImageInsight would be ideal for local similar-case retrieval but its HF card returned HTTP 401 and its licence is unknown | <https://arxiv.org/abs/2406.06512v2>, <https://arxiv.org/abs/2604.04133v1>, <https://arxiv.org/abs/2410.06542v1> |
| **Evaluate only if a 3D VLM is ever in the stack:** ORCA token compression | Training-free, 64x visual-context compression and 31x speedup - the difference between minutes and an hour per study. Licence unconfirmed | <https://arxiv.org/abs/2608.00345v1> |
| **Skip:** any VLM for spatial questions | Eight 3D medical VLMs average **34% accuracy** on explicit localisation, laterality and inter-structure relational reasoning - often below random. Laterality errors alone are a surgical safety issue. Compute carotid arcs, Robbins levels, canal relations and vascular variants geometrically | <https://arxiv.org/abs/2605.08787v2> |
| **Skip:** quantised local VLMs without per-case testing | Quantisation changed answers up to 20% of the time with minimal aggregate performance drop, and up to 6.5% of changes flipped correct to incorrect. Aggregate parity hides per-case instability - test the exact quantisation that ships | <https://arxiv.org/abs/2503.06794v4> |
| **Skip:** BiomedCLIP for CT interpretation | ViT-B/16 at 224px is genuinely CPU-real-time, but it is 2D figure-caption data with no CT volume understanding, and the authors disclaim deployment. Limitation is scientific, not computational | <https://huggingface.co/microsoft/BiomedCLIP-PubMedBERT_256-vit_base_patch16_224> |
| **Skip:** CT-CLIP/CT-RATE, RadFM as runtimes | CC-BY-NC-SA and chest-only; GPU-cluster sized. Useful as eval substrate and comparison points only | <https://arxiv.org/abs/2403.17834v5>, <https://arxiv.org/abs/2308.02463v5> |
| **Reference:** the only two H&N-specific foundation-model results | Both are outcome prediction, not geometry: a benchmark across 3,644 H&N patients found persistent difficulty generalising across imaging distributions with significant external-validation drops; and CT-foundation embeddings beat radiomics for distant metastasis by only ~0.02 AUC (0.791 vs 0.772). Nothing evaluates these encoders on encasement, level assignment, cartilage invasion, ENE or airway geometry | <https://arxiv.org/abs/2608.00071v1>, <https://arxiv.org/abs/2607.26276v1> |
| **Reference:** what an H&N-specific foundation model would look like | HiCur-NPC pretrains on 755K multimodal NPC images and covers exactly Margin's task mix (segmentation + report + prognosis) - evidence that H&N-specific pretraining beats generic CT models on H&N tasks. No confirmed public weights; heavy MoE design | <https://doi.org/10.1109/TMI.2025.3558775> |
| **Reference:** the design lesson worth keeping | Full-resolution volumetric processing (not slice downsampling) is what makes CT foundation models work, and anatomy-guided cropping beats brute-force resolution - which suits a neck-focused tool that already segments structures | <https://arxiv.org/abs/2511.17803v1>, <https://arxiv.org/abs/2608.08713v1> |

---

## 4. Datasets for local validation without PHI

Ordered by how soon Margin should download them. "Access" distinguishes **open** (direct download,
no gate), **sign-up** (registration or a data-use agreement), and **controlled** (NIH Controlled
Data Access Policy because the CTs can reconstruct faces - an application, a delay, and a
KP-institutional-policy question that has not been investigated).

| Dataset | Modality | n | Contours included | Licence | Access | What we'd validate with it |
|---|---|---|---|---|---|---|
| **PDDCA** <https://www.imagenglab.com/newsite/pddca/> | CT (RTOG 0522) | 48 | Mandible, parotid L/R, submandibular L/R, brainstem, optic chiasm, optic nerves, **plus manual bony landmarks** | stated public domain; cite Raudaschl Med Phys 2017 | open (3 zips, direct HTTPS) | **Start here.** Least encumbered H&N set with a mandible ground truth: item 9 mandible surface + osteotomy geometry, item 6 STL export, and the bony landmarks calibrate the landmark-driven level mapper (item 7) |
| **HaN-Seg** <https://zenodo.org/records/7442914> | CT + T1 MR, same patients | 42 | 30 OARs per AAPM TG-263, **including carotid L/R and mandible** | **CC BY-NC-ND 4.0** | open (single 4.9 GB zip, no login) | The cleanest OAR validation set and the only same-patient CT/MR pair for testing compare-mode registration (item 11). Carotid + mandible for items 5 and 9. **ND clause blocks redistributing modified masks or anything derived** |
| **AeroPath** <https://github.com/raidionics/AeroPath> | CT | 27 | Airway + lung, deliberately enriched for obstructing pathology | CC BY 4.0 (Zenodo) **or** MIT (GitHub README) - unresolved | open (5 GB, Zenodo + HF) | Item 8 airway analyzer, against the pathological cases that matter. Caveat: tracheobronchial and largely *below* the larynx, so supraglottic/glottic stenosis stays unvalidated |
| **TotalSegmentator dataset v2.0.1** <https://zenodo.org/records/10047292> | CT | 1,228 | 117 structures | **CC BY 4.0** - most permissive here | open (23.6 GB zip, no agreement) | Item 13: confirm the CPU inference path reproduces published Dice. Great-vessel and skeletal labels for items 5 and 10. Per-structure H&N coverage must be checked against the GitHub list, not the Zenodo record |
| **NCI Imaging Data Commons** <https://portal.imaging.datacommons.cancer.gov/explore/> | CT, PET, MR, RTSTRUCT, SEG | 90+ collections | varies by collection | per-collection; filter to CC BY 4.0 / 3.0 | open, **no login**, `pip install idc-index` | The practical *access mechanism* on a no-admin box - no Java Data Retriever, no CyberArk credential problem. Pull CT/PET/RTSTRUCT/SEG test series for items 1, 6, 12, 14. Verify the proxy permits the S3/GCS endpoints `s5cmd` targets |
| **QIN-HEADNECK** <https://www.cancerimagingarchive.net/collection/qin-headneck/> | serial FDG-PET/CT | 279 | **DICOM SEG + DICOM SR + Real World Value Mapping objects** | CC BY 3.0 (NIH controlled access for face-reconstructible series) | sign-up / partly controlled | **Highest-value set for item 12.** The RWV objects let Margin's SUV conversion be checked against a reference rather than re-derived; the SEG/SR objects are ground truth for items 6 and 14. Native DICOM - pydicom reads it directly. Pull a subset, not 201 GB |
| **Head-Neck-Radiomics-HN1** <https://www.cancerimagingarchive.net/collection/head-neck-radiomics-hn1/> | CT (+ some PET) | 137 | GTV as **both DICOM SEG and RTSTRUCT** | clinical CC BY-NC 3.0; imaging controlled | controlled (11.79 GB) | The routine regression fixture for item 1 and item 6: the same GTV in two formats lets Margin verify its two parsers agree with each other |
| **HECKTOR 2022** <https://hecktor.grand-challenge.org/> | FDG-PET/CT | ~882, 9 centres | GTVp + GTVn, plus clinical data and RFS endpoints | not stated on the landing page; participation agreement required | sign-up | Primary validation corpus for items 12 and 13; GTVn gives nodal volumetrics ground truth, and indirectly the level mapper if node centroids are assigned manually |
| **HECKTOR 2025** <https://hecktor25.grand-challenge.org/> | FDG-PET/CT + RT dose | >1,100-1,200, 10-11 centres | GTVp + GTVn, HPV labels, RFS | not stated; registration required | sign-up | The HPV and RFS labels - which is how you'd *disconfirm* an HPV feature locally rather than ship it. Also the source of the 0.56 balanced-accuracy result |
| **SegRap 2023** <https://segrap2023.grand-challenge.org/> | **paired non-contrast + contrast CT**, same patient | 200 NPC patients / 400 CTs | 45 OARs + GTVnx + GTVnd | signed EUA; **redistribution and link-sharing explicitly forbidden** | sign-up (Google Drive / Baidu mirrors - **likely proxy-blocked**) | The only large public set with paired contrast phases: exactly the setup for item 11 and for checking that vessel-dependent features (items 5, 10) behave on both phases. Richest OAR label set for item 13 |
| **HNTS-MRG 2024** <https://zenodo.org/records/11199559> | T2w MRI, **two timepoints per patient** | 150 | GTVp + GTVn at pre-RT and mid-RT | **CC BY-NC 4.0** | open (15 GB, no application) | The best public longitudinal same-patient set for item 11 - real anatomical change between timepoints, consistent labelling. MRI sits outside Margin's CT-centric viewer assumptions |
| **RADCURE** <https://www.cancerimagingarchive.net/collection/radcure/> | planning CT | 3,346 | GTVp, GTVn, 19 TG-263 OARs, + TNM, treatment, 5-yr outcomes | clinical CC BY 4.0; imaging controlled | **controlled** (391 GB; 58.55 GB oropharynx subset) | By far the largest labelled H&N CT corpus - statistically meaningful validation of items 5, 6, 7, 13. Take the OPC subset. Confirm KP institutional posture before applying |
| **TCIA HNSCC (MD Anderson)** <https://www.cancerimagingarchive.net/collection/hnscc/> | CT + PET + MR | 627 | TG-263 GTVp + GTVn; Head-Neck-CT-Atlas subset | clinical CC BY 3.0/4.0; imaging controlled | controlled (309.81 GB) | Multi-modal same-patient data for items 11 and 12; the CT-Atlas subset is the reference for OAR naming conventions in item 14 |
| **Head-Neck-PET-CT** <https://www.cancerimagingarchive.net/collection/head-neck-pet-ct/> | FDG-PET/CT + planning CT | 298, 4 Québec centres | GTV primary + GTV lymph nodes | clinical CC BY 3.0; imaging controlled | controlled (72.46 GB) | The source cohort behind much of HECKTOR, but in **native DICOM** - which is what Margin's pydicom ingest actually eats. Weight the 93 directly-contoured cases; the other 207 were deformably propagated, so Dice against them understates performance |
| **ToothFairy2 / ToothFairy3** <https://toothfairy3.grand-challenge.org/> | **CBCT** at 0.3 mm | 530 (TF2) | 42 classes (TF2) to 77 (TF3): FDI-numbered teeth, mandible, maxilla, **inferior alveolar canal**, pharynx | CC BY-NC-SA 4.0 | sign-up | The only public ground truth for the IAC and per-tooth mandible anatomy (item 9). TF2's pharynx class is usable for item 8 at the oropharyngeal level. **CBCT HU behave differently from diagnostic neck CT** - anything validated here needs re-checking on MDCT |
| **Mandibular defect dataset** <https://www.nature.com/articles/s41597-025-06048-8> | 3D meshes | 147 | Defect geometry **+ HCL (Jewer-Boyd) class labels** | Scientific Data descriptor (confirm CC terms on the record) | open | The fixture set for an automatic HCL classifier and defect-length calculator (item 9). Meshes, not DICOM - needs trimesh/vtk |
| **HNC-IMRT-70-33** <https://www.cancerimagingarchive.net/collection/hnc-imrt-70-33/> | simulation CT + RTSTRUCT/RTDOSE/RTPLAN | 211 | 26 standardised normal-tissue structures | imaging controlled; **OAR-name mapping file CC BY 4.0** | controlled images / open mapping file | Download the **name-mapping file only** - it is directly reusable for structure-name normalisation in item 14 and is the more useful half of the collection |
| **ATM'22** <https://atm22.grand-challenge.org/> | chest CT | 500 | full airway trees | challenge data agreement | sign-up | Pretrained airway models and loss functions for item 8 - though only the proximal airway matters here, which is the easy part |
| **CPTAC-HNSCC** <https://www.cancerimagingarchive.net/collection/cptac-hnscc/> | CT + MR + PET (+ pathology) | 207 (v19 lists 156) | **none** | radiology controlled; slides CC BY 4.0 | controlled | Low priority: no contours, so it cannot validate segmentation at all. Secondary multi-modal cohort only |
| **TopCoW** <https://topcow23.grand-challenge.org/> | CTA + MRA | 110 | Circle of Willis per-component labels | not stated; cite arXiv 2312.17670 | sign-up | Indirect. The anatomy is intracranial, above Margin's target, but the **multi-class vessel-labelling formulation and evaluation metrics** are the right template for a cervical carotid/vertebral labelling scheme |
| **OsiriX DICOM library** <https://www.osirix-viewer.com/resources/dicom-image-library/> | CTA, dental CT, angio | named samples (MANIX, INCISIX, ...) | none | research/teaching only, no redistribution | **Premium Membership now required** | Small viewer smoke-tests for items 1-3, and their JPEG2000 transfer syntax is itself a good compatibility test (needs `pylibjpeg` or `gdcm` on top of pydicom). Paywall + login behind a corporate proxy makes acquisition uncertain - **prefer IDC-sourced CTAs** |
| **COSMOS 2022** <https://vessel-wall-segmentation-2022.grand-challenge.org/> | black-blood carotid MRI | not stated | lumen + outer wall | **challenge-restricted: participants agree not to use the images in any other capacity** | effectively closed | **Skip.** Informs the measurement definition (wall thickness, lumen area, percent stenosis) but is unusable as a validation set |

**A blunt note on disk.** RADCURE (391 GB), HNSCC (310 GB) and QIN-HEADNECK (201 GB) will not fit
alongside everything else. Take subsets via IDC manifests. The realistic first four downloads are
**PDDCA (small), HaN-Seg (4.9 GB), AeroPath (5 GB), and a QIN-HEADNECK subset** - roughly 20 GB
buys validation coverage for items 5, 6, 8, 9, 11, 12 and 13.

**What no dataset covers** (see section 7): Robbins-level contours, annotated vascular variants,
per-node ENE labels, perineural spread, cartilage/prevertebral invasion, parathyroid 4D-CT, and
laryngotracheal stenosis with lumen contours. Those features are validated against the surgeon's
own adjudicated cases or not at all - which is precisely why the audit log in section 5 is not optional.

---

## 5. Validation and safety plan

The evidence base here is unusually clear about one thing: **essentially all clinical validation
for H&N autosegmentation comes from radiation oncology, where the downstream endpoint is dose, not
an osteotomy or a decision to resect the carotid.** Margin's core use case has no validation
literature of its own. That is not a reason to stop; it is a reason to be explicit about what is
measured, what is claimed, and what is logged.

### 5.1 The frameworks to write the design doc against

| Framework | Why | Source |
|---|---|---|
| **FUTURE-AI** - 117 experts, 50 countries; six principles (Fairness, Universality, Traceability, Usability, Robustness, Explainability) as 30 best practices with imaging-specific instantiations | The single best scaffold for the whole quality story. "Traceability" *is* the audit-log requirement | <https://pubmed.ncbi.nlm.nih.gov/39961614/> |
| **ESTRO/AAPM guideline** on development, clinical validation and reporting of AI models in RT | The closest thing to a domain-specific SOP for a single-operator in-house tool | <https://www.thegreenjournal.com/article/S0167-8140(24)00615-7/fulltext> |
| **ACR-SIIM Practice Parameter for Imaging AI** (approved 2026) | The US professional-standard answer to "what must a site do before using AI on patients": governance, a **versioned inventory of tools**, local acceptance testing, drift monitoring, and **stop rules**. Margin should satisfy this even though it is not a marketed device | <https://gravitas.acr.org/PPTS/DownloadPreviewDocument?DocId=217> |
| **DECIDE-AI** | Exactly Margin's evaluation stage: one clinician, live cases, small n, human factors dominant. Defines what to record during the first-in-practice period - which doubles as the audit-log spec | <https://pubmed.ncbi.nlm.nih.gov/36639172/> |
| **TRIPOD+AI** (27 items) | The checklist for any non-segmentation predictor. Its insistence on **calibration**, not just discrimination, matters: a surgeon acting on a probability needs it calibrated, and the ENE literature routinely omits this | <https://pmc.ncbi.nlm.nih.gov/articles/PMC11019967/> |
| **Metrics Reloaded** | Which numbers to report per problem type. Dice alone is misleading for small, tubular and boundary-critical structures - i.e. carotid, canal, airway wall | <https://www.nature.com/articles/s41592-023-02151-z> |
| **NICE HTE11** early value assessment | Its before/after evidence-generation design (time, edit magnitude, decision change at the implementing department) is the most feasible study a single surgeon can actually run on their own cases | <https://www.nice.org.uk/guidance/hte11> |
| **MDCG 2023-1** in-house exemption | Not in force in the US, but the best template for the governance file: design rationale, why no commercial product suffices, QMS, use confined to the institution | <https://health.ec.europa.eu/system/files/2023-01/mdcg_2023-1_en.pdf> |
| **RCR auto-contouring guidance 2024** | UK counterpart to ACR-SIIM; worth reading in full for the commissioning checklist. **Caveat: the sweep downloaded the PDF but could not extract its text**, so its specific recommendations are unverified here | <https://www.rcr.ac.uk/media/rqjlnlny/rcr-auto-contouring-in-radiotherapy-2024.pdf> |
| **Communications Medicine evaluation framework 2025** | Likely the most directly reusable commissioning protocol for item 13 - but the publisher redirected authentication and its contents are **unverified**. Re-fetch via PMC before relying on it | <https://www.nature.com/articles/s43856-025-01048-6> |

### 5.2 Human-in-the-loop rules

These are rules for the software, not aspirations.

1. **No AI output is ever a measurement until a human accepts it.** Every auto-contour enters the
   UI in a distinct "draft" state with a visible accept / edit / reject control, following the
   pattern OHIF already ships for brush preview.
2. **No number is reported from an unaccepted mask.** Volume, encasement angle, minimum CSA and
   distance readouts are computed from the *accepted* mask, and the report records which.
3. **Automation bias is the dominant hazard here, by construction.** The FMEA of an automated
   contouring/planning workflow found 126 failure modes unique to the automated path out of 290,
   with the top 10 driven by automation bias, operator error and software error; UI simplification
   and training cut mean RPN from 56.3 to 33.7. In Margin the surgeon who built the tool is the
   surgeon who trusts it - there is no second reader to catch a systematic error. Run that FMEA as
   a half-day exercise **before item 13 ships**.
   <https://pubmed.ncbi.nlm.nih.gov/35305941/>
4. **A propagated or registered contour is never a measurement.** Ten-algorithm DIR comparison:
   auto-propagated contours required review before clinical acceptance, and DIR uncertainty in the
   neck is comparable to interobserver contouring variation. Show the registration-quality
   indicator next to every compare-mode number.
5. **Refuse to compute when the input cannot support the claim.** The mandible-invasion adequacy
   gate (slice thickness, bone kernel) is the first instance; add analogues for contrast phase
   (vessel features) and for PET units/decay metadata (SUV).
6. **Rule out, never rule in, where the evidence only supports one direction.** Prevertebral
   invasion is the canonical case: Margin may say "prevertebral fat plane preserved"; it may not
   say "prevertebral invasion".
7. **No T stage, ever.** The cartilage literature is explicit that the best models detect invasion
   but cannot grade focal vs extensive - the distinction that changes the operation. Margin emits
   graded descriptors and the measurements behind them; a human assigns stage.
8. **Anything without external validation is labelled `INVESTIGATIONAL` in the UI and in the
   export.** That currently means: any ENE score, any recurrence score, any HPV inference (which
   should not exist at all), and the parotid deep/superficial plane.

### 5.3 The audit log

This is the concrete design, lifted from the statistical-process-control work on 500 H&N patients
contoured by an in-house automated system: <https://pubmed.ncbi.nlm.nih.gov/37797883/>

Per case, per structure, store:

- the model name and **version**, the weight file hash, and the exact CLI/parameters used;
- the **AI mask as produced** and the **surgeon's final mask**, both retained;
- **Dice and added path length** between them;
- wall-clock time from job start to acceptance, and the number of edit actions;
- every flag that fired (carotid arc, RP-ICA distance, ARSA, adequacy gate) and its adjudication -
  agreed / overruled / not applicable - with a free-text reason;
- the acquisition metadata that gated the computation (slice thickness, kernel, contrast phase,
  PET units and decay fields).

Then chart Dice and added path length per structure over time on SPC charts with 3-SD limits. The
reference major-edit rates from that study give a starting expectation: optic nerve 11% / 6.1%,
parotid 5.9%, oesophagus 4.8%, mandible 2.5%. **A moving mean of edit magnitude that drifts
downward is the automation-bias alarm** - it means the tool is being trusted more over time without
having earned it. That is the single most useful thing a solo-developer audit log can do.

Architecturally, mirror the ACR Assess-AI pattern - central metrics with local re-identification of
discordant cases - but build the whole dashboard **on-device**. Registry participation is off the
table for a nothing-leaves-the-device tool, and that is fine; the pattern is what matters.
<https://www.jacr.org/article/S1546-1440(26)00231-0/fulltext>

**Gap worth naming:** no literature was found on audit-logging design, provenance or version
control specifically for *offline/air-gapped* clinical imaging software. The SPC and Assess-AI work
both assume a networked, multi-user institutional deployment. Margin is inventing this part.

### 5.4 What to test - failure modes, concretely

The validation-budget question has a settled answer for a solo developer: one side of the
Point/Counterpoint argues for 400+ case multi-site testing with slice-by-slice review, the other
for small targeted samples plus continuous post-implementation monitoring and automatic
contour-integrity checks. **Adopt the second position** - 400 cases is not available, and both
sides agree human review remains mandatory. <https://pmc.ncbi.nlm.nih.gov/articles/PMC9859989/>

**Automatic integrity checks that run on every case** (all cheap in SimpleITK/scikit-image):

| Check | Catches |
|---|---|
| Connected-component count per structure (expect 1 for mandible, 2 for paired structures) | Fragmented or hallucinated masks |
| Laterality: does `*_left` sit left of midline (midline = mean of the two carotid centres)? | **The failure mode with surgical consequences.** Left/right swaps |
| Volume within a plausible range per structure | Gross failures (the cited example: lumbar spine contoured as bladder) |
| Topology: is the airway mask a single connected lumen? is the canal a single curve? | Leaks into surrounding air; broken canals |
| Mask present at all where anatomy must be | Silently missing segments (the cited subtle failure: missing spinal cord segments) |
| Registration: Jacobian determinant sign and range; post-registration mutual information | Folded or collapsed warps |

**Domain-shift tests that must be run before trusting anything on real cases:**

- **Post-operative necks and flap reconstruction.** HARMONY excluded post-op cases; there is no H&N
  validation of registering post-surgical free-flap anatomy, and flap anatomy is essentially absent
  from public training sets. This is Margin's population.
- **Dental artefact.** Also excluded from HARMONY. Very common in exactly the oral-cavity cases
  where the mandible mask matters most.
- **Diagnostic contrast CT vs RT planning CT.** The HNLNL weights were trained on 35 arms-down
  planning CTs; everything else Margin ingests is a diagnostic study from whatever outside facility
  the patient arrived from.
- **Scanner and protocol heterogeneity.** Worth reading the transfer-learning work aimed explicitly
  at heterogeneous CT for the intensity-harmonisation and augmentation tricks.
  <https://www.nature.com/articles/s41598-024-84804-3>
- **Small, low-contrast findings.** Expect failure, by the physics argument in the frozen-feature
  benchmark: perineural spread, subtle cartilage invasion and early ENE are exactly the class no
  current encoder detects.

**The "did it make me better or just faster?" test.** Run the pre/post consensus comparison from
the human-factors work: measure the fraction of slices left unmodified, grade residual deviations
for clinical significance, and compare clinically used contours against an independent standard
before and after the tool exists. Otherwise time saved is indistinguishable from accuracy lost.
The practical constraint for a solo user is the second reader - a delayed self-rereview, blinded to
the AI output, is the feasible substitute.
<https://pubmed.ncbi.nlm.nih.gov/37646527/>

**And the geometric-vs-clinical trap.** A real-world evaluation of commercial H&N autocontouring
(n=60 retrospective + 61 prospective) found median volumetric Dice 0.23-0.88, blinded preference
roughly even between AI and clinician contours, and significant time savings - **yet clinically
significant dosimetric differences persisted for larynx and elective nodal volumes despite good
geometry.** A structure can look geometrically fine and still be clinically wrong. That is the
direct warning for encasement degrees and airway metrics, where a sub-millimetre boundary error
changes the number Margin prints.
<https://pubmed.ncbi.nlm.nih.gov/40627370/>

### 5.5 Claims to avoid, and how to phrase AI-derived numbers

**Never say, in the UI or in an export:**

- "T4b", "unresectable", "N2b", or any other stage or category. Margin reports descriptors and
  measurements; a human assigns stage.
- "ENE present", "HPV-positive", "malignant", "benign", "recurrence".
- "Diagnostic quality", "validated", "FDA-cleared", "clinical decision support".
- "Dice 0.94" attached to any head/neck structure - that is the whole-body TotalSegmentator
  average and is not a per-structure H&N claim.
- Anything phrased as the software's conclusion rather than the software's measurement.

**Phrasing patterns that are defensible:**

| Instead of | Write |
|---|---|
| "Carotid encased - unresectable" | "Maximum circumferential contact **272 degrees** (slice 84, longest contiguous arc 268 degrees, clock 2:30-11:00). Published criterion: >270 degrees suggests unresectability; true wall invasion found in ~71% of such cases. **Measured from the accepted tumour and vessel contours - verify on the image.**" |
| "Tumour volume 34 cc (high risk)" | "Segmented volume **34.2 cc** from the accepted contour. Published prognostic threshold for primary GTV is 30 cc (local control 100% vs 59.4% below vs above)." |
| "Airway stenosis grade II" | "Minimum CSA **41 mm2** at 18 mm below the glottis; mid-trachea reference **142 mm2**; **71% reduction**, which falls in the Myer-Cotton III band. Stenotic segment length 14 mm." |
| "Depth of invasion 6 mm" | "Radiologic DOI **6.0 mm**. CT systematically overestimates histologic DOI, especially below 5 mm; published shifted imaging cut-points are ~6.2 mm and ~11.4 mm to match pathologic 5 mm and 10 mm." |
| "Level IIa node" | "Centroid falls within the **level IIa** mask (auto-segmented, model HNLNL v1, 20-level nnU-Net). Boundary confidence: **clear** (>5 mm from every boundary) / **verify** (near a boundary). Nodal-level autosegmentation has not been validated on post-operative necks." |
| "Prevertebral invasion" | "Retropharyngeal fat plane **preserved** (minimum measured thickness 2.4 mm over the tumour-vertebral interface). Imaging has high negative predictive value for prevertebral involvement and poor positive predictive value; a preserved plane argues against fixation, an effaced plane does not establish it." |
| "Aberrant right subclavian detected" | "**Geometric flag:** a contrast vessel is seen crossing retro-oesophageally from left to right at the arch. If confirmed, ARSA predicts a non-recurrent laryngeal nerve in ~87% of cases (NRLN injury ~12.9% vs 1.2%). **Rule-based detection, not a validated classifier - confirm on the images.**" |
| "Auto-segmentation complete" | "Auto-contours generated by **TotalSegmentator v2.18.0, task `headneck_bones_vessels`** in 4 min 12 s. Draft only - review and accept before any measurement is recorded." |

**Three constants in every AI-derived readout:** the *model name and version*, the *state* (draft
vs accepted), and the *published criterion* the number is being compared against, with its source.
A number with no criterion beside it invites the reader to invent one.

---

## 6. Verified code candidates

### 6.1 The 14 that were verified against their primary sources

Licence, activity, CPU feasibility, Windows-user-level installability and Python support were each
checked against the repository, PyPI/npm metadata or the GitHub API. All 14 exist; all 14 are
**adopt**.

| # | Name | Licence | Last activity | CPU | Windows user-level | Python | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | **Cornerstone3D** (core, tools, adapters, dicom-image-loader) <https://github.com/cornerstonejs/cornerstone3D> | MIT (deps: vtk.js BSD-3, codecs permissive; `@icr/polyseg-wasm` is separate) | 2026-09-17; multiple releases/week; v5.10.6 | yes | yes | n/a (TS/npm). App consumption fine on Node 20; **building the monorepo needs Node 24 + pnpm 11.5.2** | **adopt** |
| 2 | **OHIF Viewers** <https://github.com/OHIF/Viewers> | MIT | pushed 2026-09-17; v3.12.17 (2026-09-10); 4,332 stars | slow-but-ok | yes | n/a (TS). v3.12.x is the Yarn/Node-20 line; v3.13+/master needs Node 24 + pnpm | **adopt** (as source of patterns; pin `v3.12.17` if cloned) |
| 3 | **OHIF Hanging Protocol module** <https://docs.ohif.org/platform/extensions/modules/hpmodule/> | MIT | docs updated 2026-09-17 | yes | yes | n/a | **adopt** - copy the schema, do **not** install OHIF |
| 4 | **OHIF v3.10 in-browser AI segmentation** (`@cornerstonejs/ai`, `labelmap-interpolation`) <https://ohif.org/newsletters/2025-04-09-ohif%20viewer%20v3.10%20with%20local%20ai%20enhanced%20segmentation%20and%20more--release-note3p10> | MIT throughout; SAM weights Apache-2.0 | packages at 5.10.6 (Sept 2026) | slow-but-ok | yes | n/a | **adopt** - requires Cornerstone3D v5.x (exact peer pins); vendor the ~178 MB vit_b ONNX yourself |
| 5 | **vtk-js** <https://github.com/Kitware/vtk-js> and its marching-cubes/STLWriter examples | BSD-3-Clause | 2026-09-16, v37.0.4 | yes | yes | n/a | **adopt** - already present via `@cornerstonejs/core` (36.4.1); dedupe or you ship two copies |
| 6 | **3D Slicer** <https://www.slicer.org/> | BSD-style custom (commercial use permitted) | 5.12.4 built 2026-09-09 | yes | **likely** (installer emits `RequestExecutionLevel user`; fully relocatable, extractable with 7-Zip if CyberArk blocks the .exe) | ships its own CPython 3.12.10 - does not touch your venvs | **adopt** as bench/oracle, not as the product |
| 7 | **SlicerBoneReconstructionPlanner** <https://github.com/SlicerIGT/SlicerBoneReconstructionPlanner> | BSD-3-Clause (optional SlicerVESPA binaries derive from GPLv3 CGAL, not redistributed) | commits 2026-09-11/12; 531 commits | yes | likely (via Slicer) | n/a - Slicer extension, not importable from a venv | **adopt** - port the VTK geometry; skip its optional AI segmentation (pip-installs torch into Slicer's Python) |
| 8 | **SlicerExtension-VMTK** <https://github.com/vmtk/SlicerExtension-VMTK> (+ upstream `vmtk`) | Apache-2.0 (extension); vmtk core BSD-3 | extension 2026-09-14; vmtk 1.5.1 released 2026-09-17 | yes | yes | **`vmtk` requires >=3.12** and ships cp312/cp313/cp314 wheels - **3.11 is NOT supported**. Verified: `vmtk-1.5.1-cp313-cp313-win_amd64.whl` | **adopt** - isolate the venv (pins `vtk==9.6.2`); pin `>=1.5.1`; skip `vmtkmeshgenerator` (TetGen licence) |
| 9 | **SlicerDentalSegmentator** <https://github.com/gaudot/SlicerDentalSegmentator> | code Apache-2.0; **weights CC-BY-4.0** (Zenodo 10829675, verified) | repo push 2026-05-22; weights v1 2024-03-18 (~27.7k downloads) | slow-but-ok | yes | nnU-Net is pure-python; every compiled dep has a cp313 Windows wheel | **adopt** - but **pin `nnunetv2==2.5.1`**; 2.8.1 has been reported to fail on Win11 CPU with "old nnU-Net plans format" then dead workers |
| 10 | **highdicom** <https://github.com/ImagingDataCommons/highdicom> | MIT | push 2026-09-15; PyPI 0.28.1 (2026-07-28) | yes | yes | `>=3.10`, classifiers through 3.14. **Verified resolving on this box's 3.13.12** | **adopt** - pin pydicom 3.x; always pass `--only-binary :all:` so pip never source-builds `pyjpegls` |
| 11 | **dcmqi** <https://github.com/QIICR/dcmqi> | BSD-3-Clause (PyPI wrapper declares MIT - both permissive) | commit 2026-09-14; v1.5.7 (2026-08-11) | yes | yes | wheel metadata says >=3.10 with classifiers to 3.12, but the Windows wheel is `py3-none-win_amd64` (bundled binaries, no C extension) - **installs on 3.13** | **adopt** - call `itkimage2segimage` by subprocess; needs the source series + a hand-authored JSON descriptor |
| 12 | **rt-utils** <https://github.com/qurit/rt-utils> | MIT | last commit 2026-08-15; **PyPI stuck at 1.2.7 (Jan 2023)** | yes | yes | declares >=3.8; **verified resolving on 3.13.12** | **adopt** - prefer `git+https://.../rt-utils@main` for the orientation/PixelSpacing fix and `contour_mode='voxel_edge'` |
| 13 | **Orthanc** (standalone Windows build) <https://orthanc.uclouvain.be/book/users/quick-start-windows.html> | **GPLv3 core, AGPLv3 DICOMweb plugin** - the licensing FAQ explicitly permits proprietary software to call it over REST/DICOM even with AGPL plugins installed | core 1.13.0 (2026-08-15) | yes | yes - **use the standalone build, not the .exe installer** (which registers a service and needs admin) | n/a (C++ binary). Avoid the Orthanc Python plugin: built against one CPython minor version, and AGPL | **adopt** - separate localhost process; bind 127.0.0.1, `RemoteAccessAllowed false`; never vendor or link |
| 14 | **3D Slicer as platform / ecosystem citation** <https://www.slicer.org/> | see #6 | see #6 | yes | likely | see #6 | **adopt** - prototype items 5-10 in Slicer Python, capture reference values, then port to FastAPI |

### 6.2 Unverified adopt/evaluate items from the topic sweeps

These carry an adopt or evaluate priority in the topic files but were **not** put through the same
primary-source verification. Treat every licence and version claim here as provisional.

**Unverified - adopt priority** (verify before they enter the dependency list):

| Name | Licence as claimed | Why adopt | Link |
|---|---|---|---|
| TotalSegmentator | Apache-2.0 for open subtasks; free NC key for the asterisked ones | The anatomical backbone for nearly every feature. **README task list and licence split were spot-checked this session** and confirmed, including `craniofacial_structures` and `teeth` | <https://github.com/wasserth/TotalSegmentator> |
| nnU-Net v2 | Apache-2.0 | One pinned runtime serving TotalSegmentator, DentalSegmentator and HNLNL. Resolution on 3.13 verified this session | <https://github.com/MIC-DKFZ/nnUNet> |
| HNLNL trained models | **CC0-1.0 - repo page verified this session**; release binaries not individually checked | The only open 20-level cervical nodal model | <https://github.com/putzfn/HNLNL_autosegmentation_trained_models> |
| DentalSegmentator weights | **CC-BY-4.0 - Zenodo record verified this session** | Mandible + IAC at 92-94% Dice | <https://zenodo.org/records/10829675> |
| itk-elastix | Apache-2.0 | Registration engine. **cp311-abi3 win_amd64 wheel and 3.13 resolution verified this session** | <https://github.com/InsightSoftwareConsortium/ITKElastix> |
| torch (CPU wheels) | BSD-3-Clause | **Verified: `torch-2.14.0+cpu` resolves from the CPU index on this box's 3.13** | <https://pypi.org/project/torch/> |
| QIICR SUV plugin logic | BSD-style (Slicer) | Port the decay/units logic rather than reinventing it | <https://github.com/QIICR/Slicer-PETDICOMExtension/blob/master/DICOMPETSUVPlugin/DICOMPETSUVPlugin.py> |
| Cornerstone3D `VolumeViewport` fusion API | MIT | PET/CT fusion viewport | <https://www.cornerstonejs.org/docs/api/core/classes/volumeviewport/> |
| CT-FM | MIT | The only CPU-plausible CT foundation encoder | <https://github.com/project-lighter/CT-FM> |

**Unverified - evaluate priority:**

| Name | Licence as claimed | Main unknown | Link |
|---|---|---|---|
| nnInteractive | code Apache-2.0; **checkpoint CC BY-NC-SA 4.0** | Real CPU latency on a cropped neck ROI - maintainers say CPU is impractical | <https://github.com/MIC-DKFZ/nnInteractive> |
| SAM-Med3D | Apache-2.0 | Checkpoints on Google Drive / Baidu - proxy will likely block | <https://github.com/openmedlab/SAM-Med3D> |
| MedSAM / MedSAM2 | code Apache-2.0; MedSAM2 checkpoint terms unverified | CPU inference documented as impractical even for SAM2.1-Tiny; needs ONNX + int8 | <https://github.com/bowang-lab/MedSAM> |
| SegVol | **not confirmed** | Licence, from a primary source | <https://github.com/BAAI-DCAI/SegVol> |
| VISTA3D | code Apache-2.0; **weights NVIDIA OneWay NC** | Nothing - this is effectively a skip | <https://github.com/Project-MONAI/VISTA/blob/main/vista3d/README.md> |
| MONAI model-zoo `wholeBody_ct_segmentation` | Apache-2.0 | Whether the 3.0 mm bundle is good enough without H&N-specific labels | <https://github.com/Project-MONAI/model-zoo/tree/dev/models/wholeBody_ct_segmentation> |
| MONAI Label | Apache-2.0 | CPU-only inference is not explicitly supported; 3.13 unverified | <https://github.com/Project-MONAI/MONAILabel> |
| ANTsPy | Apache-2.0 | **Python 3.13 wheel availability - explicitly not verified** | <https://github.com/ANTsX/ANTsPy> |
| uniGradICON | Apache-2.0 | Neck is off-distribution; CPU cost unmeasured | <https://github.com/uncbiag/uniGradICON> |
| AutoSeg4ETICA | Apache-2.0 | n=30 training scans - domain shift on contrast neck CT | <https://github.com/YuliangXiaoYLX/AutoSeg4ETICA> |
| NaviAirway | **not confirmed** | Repository LICENSE | <https://github.com/AntonotnaWang/NaviAirway> |
| VMTK upstream (`vmtk/vmtk`) | BSD-3-Clause | Resolved by verification #8 above - 1.5.1 has cp313 wheels; the sweep's "conda-only" claim is **stale** | <https://github.com/vmtk/vmtk> |
| OsteoOpt | **PolyForm Noncommercial 1.0.0** | Nothing - borrow metric definitions only; the Java/MATLAB/Python-3.8 stack is unvendorable | <https://github.com/hamidreza-aftabi/OsteoOpt> |
| SlicerOrbitSurgerySim | **not stated** | Repository LICENSE | <https://arxiv.org/abs/2512.19534> |
| cs3d-viewer | **not verified** | Repository LICENSE; individual's project | <https://github.com/vishnusureshperumbavoor/cs3d-viewer> |
| SlicerJupyter | BSD-style | Headless/offscreen rendering on Windows without admin | <https://github.com/Slicer/SlicerJupyter> |
| MITK + mitk-python | BSD-3-Clause | Whether `mitk-python` publishes a 3.13 Windows wheel at all | <https://www.mitk.org/> |
| NiiVue | BSD-style (**stated, not confirmed**) | Licence confirmation | <https://github.com/niivue/niivue> |
| RADMAP | **unknown** (preprint) | Whether a repository exists | <https://www.medrxiv.org/content/10.1101/2025.11.23.25340237.full.pdf> |
| ORCA | **not confirmed** | Repository LICENSE | <https://arxiv.org/abs/2608.00345v1> |
| MedGemma 1.5 4B | **HAI-DEF terms**, gated | Whether the proxy permits gated HF downloads at all | <https://huggingface.co/google/medgemma-1.5-4b-it> |
| MedImageInsight | **unknown (HTTP 401)** | Licence - the deciding factor | <https://arxiv.org/abs/2410.06542v1> |
| Merlin | MIT | Parameter count, input resolution, any CPU path | <https://arxiv.org/abs/2406.06512v2> |
| VoxelFM | **unconfirmed** | Whether weights are downloadable at all | <https://arxiv.org/abs/2604.04133v1> |
| OraSeg | **non-commercial only** | Whether a pure-CPU PyTorch fallback exists (Mamba kernels often assume CUDA) | <https://pmc.ncbi.nlm.nih.gov/articles/PMC12464119/> |
| pyradiomics | BSD-3-Clause | **Resolved: verified broken.** Newest Windows wheel is cp38; do not depend on it | <https://pmc.ncbi.nlm.nih.gov/articles/PMC13413217/> |

---

## 7. Open questions and gaps

Merged and deduplicated from the gap lists of all nine sweeps, ordered by how much they block work.

### P0 - blocks a decision that is imminent

1. **No CPU wall-clock benchmark exists for any of these models on Intel-iGPU-class hardware.**
   Not one model card or paper reports CPU latency or peak RAM for a full CT volume. Every
   feasibility judgement in this document is inferred from parameter counts. **Measure
   TotalSegmentator (per task), DentalSegmentator, HNLNL and an itk-elastix rigid+B-spline pair on
   a real 512x512x180 neck CT on this box and record the numbers in the repo.** Everything about
   the UX - background job vs interactive, which tasks run on study open - depends on this.
2. **The Robbins-to-Gregoire label mapping table does not exist and must be hand-authored.** The 20
   HNLNL labels use Gregoire/DAHANCA nomenclature, which adds levels and renames boundaries
   relative to surgical Robbins levels. The surgeon-author has to write and sign off this table
   before any level label reaches a report.
3. **HNLNL behaviour on diagnostic contrast neck CT, on post-operative necks and on
   post-radiation necks is unvalidated.** Trained on 35 arms-down RT planning CTs. No public
   dataset with Robbins-level contours exists to validate against, so this is a manual,
   case-by-case exercise against the author's own reads.
4. **Intel UHD 770 WebGL limits are unmeasured.** Read `gl.MAX_3D_TEXTURE_SIZE` and
   `gl.MAX_TEXTURE_SIZE`, and check whether WebGPU is enabled in the enterprise browser build.
   Decisive for items 2, 3 and 6.
5. **Whether TCIA controlled-access applications are permissible under Kaiser Permanente policy,
   and whether KP has its own governance requirements for clinician-developed clinical software.**
   The latter is the binding constraint in practice regardless of FDA status, and it was not
   investigated at all.

### P1 - shapes what gets built next

6. **No public weights exist for any CT-only or PET/CT H&N GTV model.** Every challenge winner
   published methods, not checkpoints. Margin either retrains (no GPU), uses interactive
   segmentation, or ships no auto-GTV. Currently: no auto-GTV.
7. **No public weights or code for any ENE classifier** (JCO 2020, Sci Rep 2018, Radiology 2025/26).
   A radiologic-ENE feature is not implementable locally today.
8. **No model detects lymph node necrosis, matting, or the specific CT signs a surgeon actually
   uses.** Published node models segment nodes or predict ENE as a black box.
9. **Individual pathological cervical node instance segmentation has no permissively licensed
   released model.** Levels are solved openly; node picking stays prompt-based or manual.
10. **Deep-vs-superficial parotid lobe division is addressed by no published model**, and no paper
    validates a geometric facial-nerve-plane approximation on CT. Margin's approach is novel and
    therefore must be labelled as such.
11. **The thyroid cartilage T3-vs-T4a split is explicitly unsolved.** Detection works; grading
    extent does not.
12. **No dedicated skull-base foramina atlas with a permissive licence was located.** The ROI atlas
    for perineural spread must be built in-house or derived by registration from a craniofacial atlas.
13. **No DICOM RTSTRUCT/SEG round-trip investigation was done.** Margin will need this to export
    masks anywhere. `highdicom`, `dcmqi` and `rt-utils` are all verified installable - the gap is
    that nobody has tested the round trip.
14. **Per-structure Dice for the TotalSegmentator H&N subtasks was not found** (hyoid, cricoid,
    IJV, constrictors, styloid). The 0.943 figure is a whole-body v1 average. Margin needs its own
    HaN-Seg/SegRap-based evaluation before showing any confidence number.
15. **No validation literature exists for Margin's distinctive analytics at all** - carotid
    encasement degree measurement, airway minimum-CSA quantification, mandibular canal localisation
    accuracy, or automated Robbins assignment in post-operative necks. Nor is there any prospective
    study of AI segmentation for H&N *surgical* planning as opposed to radiotherapy contouring.

### P2 - licence and provenance loose ends

16. **HNLNL release binaries** - CC0-1.0 confirmed at the repository level only; confirm the assets
    carry the same terms before bundling them into a distributable build.
17. **AeroPath's data licence is stated inconsistently** - CC BY 4.0 on Zenodo, MIT on GitHub.
18. **HECKTOR 2022 and 2025 licence terms are not published on the challenge landing pages**; they
    are only in the participation agreement, after registration.
19. **SegVol's licence and MedSAM2's checkpoint licence are unconfirmed** from primary sources.
20. **MedImageInsight's licence is unknown** (HF card gated, HTTP 401); MedGemma's HAI-DEF terms
    were not read.
21. **Repository licences unverified** for SlicerOrbitSurgerySim, cs3d-viewer, NaviAirway, ORCA,
    RADMAP and NiiVue.
22. **HaN-Seg is CC BY-NC-ND**, which permits internal validation but blocks distributing anything
    derived from it. Any future Margin model trained on public H&N data needs a licence audit
    before it leaves the device.

### P3 - environment and infrastructure unknowns

23. **Proxy behaviour is untested for gated Hugging Face downloads and for Google Drive / Baidu.**
    PyPI, `download.pytorch.org` and Zenodo/GitHub Releases were confirmed working this session;
    the other three are the likeliest blocks and gate SAM-Med3D, SegRap and MedGemma.
24. **Whether 3D Slicer, Weasis and MITK Workbench install without admin** - all appear to offer
    portable/archive distributions and the Slicer NSIS config emits `RequestExecutionLevel user`,
    but this was never tested on the actual workstation.
25. **`idc-index` Python version support against 3.13**, and whether the proxy permits the AWS/GCS
    endpoints `s5cmd` targets.
26. **ANTsPy 3.13 wheel availability** - explicitly unverified.
27. **Whether a maintained pyradiomics fork with modern wheels exists.** Unresolved; irrelevant if
    SUVmax/MTV/TLG are implemented directly, which is the recommendation.
28. **No maintained pip-installable PET SUV library exists.** The QIICR code is the reference
    implementation but must be ported; budget real effort for DICOM units and decay-correction edge
    cases across scanner vendors.
29. **No ONNX/OpenVINO export recipe has been published for the TotalSegmentator head/neck
    weights.** FLARE 2024 proves the approach for abdominal nnU-Net; the H&N port is unvalidated
    work for Margin.
30. **No canonical end-to-end PET/CT fusion example with SUV window presets** exists in the
    Cornerstone3D docs - expect nontrivial front-end work.
31. **No literature on audit-logging design, provenance or version control for offline/air-gapped
    clinical imaging software.** The closest analogues both assume networked multi-user deployments.

### P4 - research coverage the sweeps could not reach

32. **Web-search budget was exhausted in three of the sweeps** (datasets, foundation models,
    validation/regulatory), so those findings come only from direct fetches of already-known URLs.
    Under-covered as a result: StructSeg 2019, SegRap 2025, newer airway or nodal-level releases,
    Papers-with-Code/grand-challenge sweeps, FDA clearance requirements for VSP/mandible
    reconstruction software specifically, and RSNA 3D Printing SIG QA guidelines.
33. **The CLAIM checklist and its 2024 update** (the imaging-specific counterpart to TRIPOD+AI)
    was deliberately omitted rather than cited from an unverified URL. It should be added.
34. **Two documents could not be read and should be re-fetched**: the RCR 2024 auto-contouring
    guidance (PDF text extraction failed) and the Communications Medicine 2025 evaluation framework
    (publisher auth redirect; try PMC).
35. **Two VSP papers could not be verified**: Li et al. 2026 "An Automated Framework for Mandibular
    Reconstruction" (Head & Neck, HTTP 403) and the Maisi et al. BoneReconstructionPlanner
    validation paper (DOI resolved from the extension README, not the publisher).
36. **No public search was done** for scapula or iliac-crest donor-site planning code, nor for
    occlusion-driven / jaw-in-a-day planning geometry beyond two case-level papers.
37. **No H&N-specific OHIF extension, Slicer extension or hanging protocol was found.** If one
    exists, it did not surface.

---

## 8. Sources

Every URL cited above, grouped by the sweep that found it, deduplicated across sweeps
(19 URLs appeared in more than one sweep and are listed once, under the first group that
found them). No source outside this list is cited anywhere in this document.

### Virtual surgical planning and reconstruction

- <https://arxiv.org/abs/2512.19534>
- <https://doi.org/10.1016/j.stlm.2023.100109>
- <https://github.com/DCBIA-OrthoLab/SlicerCMF>
- <https://github.com/Kitware/vtk-js>
- <https://github.com/SlicerIGT/SlicerBoneReconstructionPlanner>
- <https://github.com/gaudot/SlicerDentalSegmentator>
- <https://github.com/hamidreza-aftabi/OsteoOpt>
- <https://github.com/vishnusureshperumbavoor/cs3d-viewer>
- <https://onlinelibrary.wiley.com/doi/10.1002/hed.70215>
- <https://onlinelibrary.wiley.com/doi/full/10.1002/hed.27352>
- <https://onlinelibrary.wiley.com/doi/full/10.1002/hed.27642>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC11613268/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC11717937/>
- <https://pubmed.ncbi.nlm.nih.gov/36728691/>
- <https://pubmed.ncbi.nlm.nih.gov/40132366/>
- <https://pubmed.ncbi.nlm.nih.gov/40271475/>
- <https://pubmed.ncbi.nlm.nih.gov/42305074/>
- <https://www.nature.com/articles/s41597-025-06048-8>
- <https://www.nature.com/articles/s41598-025-29130-y>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11719637/>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12094958/>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8560731/>
- <https://www.sciencedirect.com/science/article/abs/pii/S0901502724000079>
- <https://www.sciencedirect.com/science/article/pii/S2666964122000157>

### Viewers, DICOM servers and platforms

- <https://discourse.vtk.org/t/vtk-webgpu-roadmap/13749>
- <https://docs.ohif.org/platform/extensions/modules/hpmodule/>
- <https://doi.org/10.1016/j.mri.2012.05.001>
- <https://doi.org/10.1158/0008-5472.CAN-17-0334>
- <https://github.com/ImagingDataCommons/highdicom>
- <https://github.com/OHIF/Viewers/issues/3082>
- <https://github.com/OHIF/Viewers>
- <https://github.com/Project-MONAI/MONAILabel>
- <https://github.com/QIICR/dcmqi>
- <https://github.com/Slicer/SlicerJupyter>
- <https://github.com/cornerstonejs/cornerstone3D/issues/1360>
- <https://github.com/cornerstonejs/cornerstone3D>
- <https://github.com/dcm4che/dcm4chee-arc-light>
- <https://github.com/kaapana/kaapana>
- <https://github.com/niivue/niivue>
- <https://github.com/qurit/rt-utils>
- <https://github.com/vmtk/SlicerExtension-VMTK>
- <https://kitware.github.io/vtk-js/examples/ImageMarchingCubes.html>
- <https://link.springer.com/article/10.1007/s10278-022-00683-y>
- <https://ohif.org/newsletters/2025-04-09-ohif%20viewer%20v3.10%20with%20local%20ai%20enhanced%20segmentation%20and%20more--release-note3p10>
- <https://orthanc.uclouvain.be/book/users/quick-start-windows.html>
- <https://weasis.org/en/>
- <https://www.mitk.org/>
- <https://www.sciencedirect.com/science/article/abs/pii/S1361841524001324>
- <https://www.slicer.org/>

### Clinical validation, regulatory status and deployment

- <https://gravitas.acr.org/PPTS/DownloadPreviewDocument?DocId=217>
- <https://health.ec.europa.eu/system/files/2023-01/mdcg_2023-1_en.pdf>
- <https://mvision.ai/mvision-ais-secures-fda-510k-clearance-for-contour-advanced-ct-and-mr-models/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC10080800/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC11019967/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC12711475/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC9859989/>
- <https://pubmed.ncbi.nlm.nih.gov/35305941/>
- <https://pubmed.ncbi.nlm.nih.gov/36639172/>
- <https://pubmed.ncbi.nlm.nih.gov/37646527/>
- <https://pubmed.ncbi.nlm.nih.gov/37797883/>
- <https://pubmed.ncbi.nlm.nih.gov/39961614/>
- <https://pubmed.ncbi.nlm.nih.gov/40419731/>
- <https://pubmed.ncbi.nlm.nih.gov/40627370/>
- <https://pubmed.ncbi.nlm.nih.gov/41026592/>
- <https://pubmed.ncbi.nlm.nih.gov/41528225/>
- <https://www.fda.gov/medical-devices/medical-devices-news-and-events/cdrh-issues-guiding-principles-predetermined-change-control-plans-machine-learning-enabled-medical>
- <https://www.fda.gov/regulatory-information/search-fda-guidance-documents/clinical-decision-support-software>
- <https://www.jacr.org/article/S1546-1440(26)00231-0/fulltext>
- <https://www.jmir.org/2021/7/e26151>
- <https://www.nature.com/articles/s41592-023-02151-z>
- <https://www.nature.com/articles/s43856-025-01048-6>
- <https://www.nice.org.uk/guidance/hte11>
- <https://www.prnewswire.com/news-releases/mim-software-inc-receives-fda-510k-clearance-for-additional-ai-contours--local-deployment-301414467.html>
- <https://www.rcr.ac.uk/media/rqjlnlny/rcr-auto-contouring-in-radiotherapy-2024.pdf>
- <https://www.thegreenjournal.com/article/S0167-8140(24)00615-7/fulltext>

### CT foundation models and vision-language models

- <https://arxiv.org/abs/2308.02463v5>
- <https://arxiv.org/abs/2403.17834v5>
- <https://arxiv.org/abs/2405.03595v2>
- <https://arxiv.org/abs/2406.04449v2>
- <https://arxiv.org/abs/2406.06512v2>
- <https://arxiv.org/abs/2410.06542v1>
- <https://arxiv.org/abs/2503.06794v4>
- <https://arxiv.org/abs/2507.05201v4>
- <https://arxiv.org/abs/2511.17803v1>
- <https://arxiv.org/abs/2604.04133v1>
- <https://arxiv.org/abs/2605.08787v2>
- <https://arxiv.org/abs/2607.20993v1>
- <https://arxiv.org/abs/2607.22771v2>
- <https://arxiv.org/abs/2607.26276v1>
- <https://arxiv.org/abs/2607.27154v2>
- <https://arxiv.org/abs/2608.00071v1>
- <https://arxiv.org/abs/2608.00345v1>
- <https://arxiv.org/abs/2608.05960v1>
- <https://arxiv.org/abs/2608.08713v1>
- <https://arxiv.org/abs/2609.15635v1>
- <https://doi.org/10.1109/TMI.2025.3558775>
- <https://github.com/project-lighter/CT-FM>
- <https://huggingface.co/google/medgemma-1.5-4b-it>
- <https://huggingface.co/microsoft/BiomedCLIP-PubMedBERT_256-vit_base_patch16_224>

### Public datasets and benchmarks

- <https://github.com/raidionics/AeroPath>
- <https://hecktor.grand-challenge.org/>
- <https://hecktor25.grand-challenge.org/>
- <https://portal.imaging.datacommons.cancer.gov/explore/>
- <https://pubmed.ncbi.nlm.nih.gov/37195050/>
- <https://segrap2023.grand-challenge.org/>
- <https://toothfairy3.grand-challenge.org/>
- <https://topcow23.grand-challenge.org/>
- <https://vessel-wall-segmentation-2022.grand-challenge.org/>
- <https://www.cancerimagingarchive.net/collection/cptac-hnscc/>
- <https://www.cancerimagingarchive.net/collection/head-neck-pet-ct/>
- <https://www.cancerimagingarchive.net/collection/head-neck-radiomics-hn1/>
- <https://www.cancerimagingarchive.net/collection/hnc-imrt-70-33/>
- <https://www.cancerimagingarchive.net/collection/hnscc/>
- <https://www.cancerimagingarchive.net/collection/qin-headneck/>
- <https://www.cancerimagingarchive.net/collection/radcure/>
- <https://www.imagenglab.com/newsite/pddca/>
- <https://www.osirix-viewer.com/resources/dicom-image-library/>
- <https://zenodo.org/records/10047292>
- <https://zenodo.org/records/11199559>
- <https://zenodo.org/records/7442914>

### Organ-at-risk and normal-anatomy segmentation

- <https://arxiv.org/abs/2312.09576>
- <https://github.com/BAAI-DCAI/SegVol>
- <https://github.com/MIC-DKFZ/nnInteractive>
- <https://github.com/MIC-DKFZ/nnUNet>
- <https://github.com/Project-MONAI/VISTA/blob/main/vista3d/README.md>
- <https://github.com/Project-MONAI/model-zoo/tree/dev/models/wholeBody_ct_segmentation>
- <https://github.com/Project-MONAI/tutorials/blob/main/auto3dseg/README.md>
- <https://github.com/bowang-lab/MedSAM>
- <https://github.com/openmedlab/SAM-Med3D>
- <https://github.com/wasserth/TotalSegmentator>
- <https://link.springer.com/chapter/10.1007/978-3-031-96202-8_9>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC9978473/>
- <https://pubs.rsna.org/doi/full/10.1148/ryai.230024>
- <https://raw.githubusercontent.com/wasserth/TotalSegmentator/master/README.md>
- <https://www.nature.com/articles/s41598-024-84804-3>
- <https://www.sciencedirect.com/science/article/pii/S0167814024006807>
- <https://www.sciencedirect.com/science/article/pii/S0300571224002999>

### Primary tumour, nodes, ENE, HPV and depth of invasion

- <https://arxiv.org/abs/2606.20143>
- <https://arxiv.org/pdf/2011.08555>
- <https://arxiv.org/pdf/2201.00895>
- <https://arxiv.org/pdf/2201.04138>
- <https://arxiv.org/pdf/2209.10809>
- <https://ascopubs.org/doi/abs/10.1200/JCO.19.02031?af=R>
- <https://github.com/putzfn/HNLNL_autosegmentation_trained_models>
- <https://hecktor25.grand-challenge.org/tasks-and-evaluation/>
- <https://link.springer.com/chapter/10.1007/978-3-032-25766-6_2>
- <https://onlinelibrary.wiley.com/doi/10.1002/hed.70315>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC11612088/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC12059277/>
- <https://pubs.rsna.org/doi/10.1148/radiol.250332>
- <https://www.dahanca.dk/uploads/TilFagfolk/Guideline/GUID_Atlas_neck_CTV_2014.pdf>
- <https://www.nature.com/articles/s41598-018-32441-y>
- <https://www.nature.com/articles/s41598-023-48944-2>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10362784/>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10526893/>
- <https://www.redjournal.org/article/S0360-3016(11)01655-5/fulltext>
- <https://www.sciencedirect.com/science/article/pii/S0720048X20306707>

### Vessels, airway and bone

- <https://arxiv.org/pdf/2311.01138>
- <https://atm22.grand-challenge.org/>
- <https://github.com/AntonotnaWang/NaviAirway>
- <https://github.com/YuliangXiaoYLX/AutoSeg4ETICA>
- <https://github.com/vmtk/vmtk>
- <https://onlinelibrary.wiley.com/doi/10.1002/ca.70072>
- <https://onlinelibrary.wiley.com/doi/10.1155/2013/968758>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC12464119/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC5257243/>
- <https://pubmed.ncbi.nlm.nih.gov/28828115/>
- <https://pubmed.ncbi.nlm.nih.gov/38878813/>
- <https://pypi.org/project/torch/>
- <https://www.ajnr.org/content/27/10/2024>
- <https://www.ejradiology.com/article/S0720-048X(25)00092-0/fulltext>
- <https://www.nature.com/articles/s41746-025-02260-3>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9582344/>
- <https://www.sciencedirect.com/science/article/abs/pii/S0748798321001128>
- <https://www.sciencedirect.com/science/article/pii/S1361841526001647>
- <https://zenodo.org/records/10829675>

### Registration, longitudinal comparison and PET

- <https://github.com/ANTsX/ANTsPy>
- <https://github.com/InsightSoftwareConsortium/ITKElastix>
- <https://github.com/QIICR/Slicer-PETDICOMExtension/blob/master/DICOMPETSUVPlugin/DICOMPETSUVPlugin.py>
- <https://github.com/QIICR/Slicer-SUVFactorCalculator>
- <https://github.com/junyuchen245/TransMorph_Transformer_for_Medical_Image_Registration>
- <https://github.com/uncbiag/uniGradICON>
- <https://github.com/voxelmorph/voxelmorph/wiki>
- <https://link.springer.com/article/10.1007/s00405-019-05323-w>
- <https://link.springer.com/article/10.1007/s40336-021-00429-w>
- <https://ohif.org/release-notes/3p7/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC11261256/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC13413217/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC13454081/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC7067662/>
- <https://proceedings.scipy.org/articles/gerudo-f2bc6f59-00d>
- <https://pubmed.ncbi.nlm.nih.gov/40719095/>
- <https://pypi.org/project/SimpleITK-Elastix/>
- <https://www.cornerstonejs.org/docs/api/core/classes/volumeviewport/>
- <https://www.lifexsoft.org/index.php/resources/overview>
- <https://www.nature.com/articles/s42256-024-00912-9>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12450971/>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12805746/>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12872724/>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4302687/>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4587740/>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5393623/>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6036371/>
- <https://www.sciencedirect.com/science/article/abs/pii/S0360301624001901>
- <https://www.sciencedirect.com/science/article/pii/S2090074013000765>

### Niche H&N tasks: perineural spread, cartilage, mandible, prevertebral, ARSA, parathyroid, airway, parotid

- <https://ajronline.org/doi/10.2214/ajr.177.1.1770237>
- <https://jnm.snmjournals.org/content/60/3/304>
- <https://link.springer.com/article/10.1007/s44443-026-00640-7>
- <https://link.springer.com/article/10.1186/s40644-020-00359-2>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC11359603/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC12469078/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC12654700/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC13264006/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC13509628/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC5915826/>
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC8010531/>
- <https://pubmed.ncbi.nlm.nih.gov/25416240/>
- <https://pubmed.ncbi.nlm.nih.gov/32621638/>
- <https://pubmed.ncbi.nlm.nih.gov/41270058/>
- <https://www.ajronline.org/doi/10.2214/ajr.170.5.9574622>
- <https://www.medrxiv.org/content/10.1101/2025.11.23.25340237.full.pdf>
- <https://www.nature.com/articles/s41597-025-05757-4>
- <https://www.nature.com/articles/s41598-024-65060-x>
- <https://www.nature.com/articles/s41598-025-23809-y>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10459295/>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11564286/>
- <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9955422/>
- <https://www.sciencedirect.com/science/article/pii/S245210942200269X>

**Total: 228 unique sources.**

Additional primary sources opened directly while writing this document, to resolve
contradictions in the inputs (all already listed above): the TotalSegmentator README,
the HNLNL repository page, the DentalSegmentator Zenodo record, the HECKTOR 2025 arXiv
abstract, the vmtk PyPI page and the itk-elastix PyPI page.
