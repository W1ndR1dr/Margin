# HNRad architecture and API contract (v0.1)

## Layout
```
hnrad/
  backend/            Python 3.13 venv at backend/.venv  (FastAPI + pydicom + SimpleITK + scikit-image)
    hnrad/            package: __init__.py, app.py, db.py, indexer.py, phantom.py, analysis.py, config.py
    run.ps1           starts uvicorn on 127.0.0.1:8765 (reload on)
  frontend/           Vite + React 18 + TypeScript + Cornerstone3D 5.x   (dev server 127.0.0.1:5173)
    src/
  tools/
  ROADMAP.md, CONTRACT.md, README.md
```
Data store (never inside OneDrive):
- Studies root: `%LOCALAPPDATA%\HNRad\studies\`  (import folders are indexed in place; default import root)
- Database:     `%LOCALAPPDATA%\HNRad\db\hnrad.sqlite`

Both servers bind 127.0.0.1 only. Vite proxies `/api/*` to the backend, so the
browser only ever talks to http://127.0.0.1:5173. CORS is therefore not needed,
but the backend may still allow origin http://127.0.0.1:5173.

## REST API (JSON unless noted, prefix /api)

```
GET  /api/health
     -> {status:"ok", version:"0.1.0", db_path, studies_root}

POST /api/import   body {path?: string}
     -> {patients, studies, series, instances, skipped, seconds}
     Recursively indexes DICOM files under path (default = studies root). Idempotent
     (SOPInstanceUID is the primary key). Non-DICOM files are skipped quietly.
     Reads headers only (stop_before_pixels) for speed. Also accepts DICOMDIR-less
     folders with files lacking extensions.

GET  /api/patients
     -> [{patient_id, name, sex, birth_date, study_count}]

GET  /api/studies?patient_id=<optional>
     -> [{study_uid, patient_id, patient_name, study_date, study_time, description,
          accession, modalities:[...], series_count, instance_count}]

GET  /api/studies/{study_uid}/series
     -> [{series_uid, study_uid, series_number, modality, description, body_part,
          instance_count, rows, cols, pixel_spacing:[row_mm, col_mm], slice_thickness,
          spacing_between_slices, orientation:[6 floats] | null, is_multiframe,
          is_3d}]                      is_3d = >=3 instances sharing one orientation

GET  /api/series/{series_uid}
     -> series row above plus
        instances: [{sop_uid, instance_number, ipp:[x,y,z], slice_pos}]
        sorted ascending by slice_pos = dot(IPP, normal) where normal = rowDir x colDir.

GET  /api/instances/{sop_uid}
     -> raw DICOM Part-10 file bytes, Content-Type application/dicom,
        Cache-Control: max-age=31536000 (UIDs are immutable).
        Frontend imageId = `wadouri:/api/instances/{sop_uid}`

GET  /api/series/{series_uid}/thumbnail
     -> PNG, 128x128, middle slice, W350/L40 soft-tissue window.

POST /api/analysis/isosurface
     body {series_uid, lower_hu:number, upper_hu?:number, step?:1|2, smooth_iters?:number}
     -> binary STL (Content-Type application/sla,
        Content-Disposition attachment; filename="<series>_<lower>HU.stl")
        marching-cubes surface in patient (LPS mm) coordinates. Bone / airway export.

POST /api/analysis/roi-stats
     body {series_uid, sop_uid, polygon:[[col,row],...]}     (pixel coords, >=3 points)
     -> {mean_hu, std_hu, min_hu, max_hu, area_mm2, n_voxels}
```
Errors: `{detail: string}` with 404 (unknown UID / path) or 400 (bad input).
HU = stored_value * RescaleSlope + RescaleIntercept.

## Frontend behavior (v0.1)
- Left panel: patient / study / series browser with thumbnails. "Import folder"
  button prompts for a path (default = studies root) and calls POST /api/import,
  then refreshes.
- Main: 2x2 grid = axial, sagittal, coronal MPR + 3D volume render, all from one
  Cornerstone3D streaming volume. Linked crosshairs (Crosshairs tool) across the
  three MPR views. Double-click a viewport (or press F) to maximize / restore.
- Top toolbar: tools — WindowLevel, Pan, Zoom, StackScroll, Crosshairs, Length,
  Bidirectional, Angle, Probe, EllipticalROI, RectangleROI, PlanarFreehandROI.
  Window presets — Soft tissue neck W350/L40, Bone W2000/L400, Lung W1500/L-600,
  Brain W80/L40, Stroke W40/L40. 3D presets — CT-Bone, CT-Soft-Tissue (CTA-ish),
  CT-Airway (inverted, air visible). Reset view. Screenshot (PNG download of the
  active viewport).
- Right panel: measurement list (live-updating, click to jump, delete), series
  info, HU + patient coordinates under cursor, orientation of active view.
- Keyboard: 1..9 select tools in toolbar order, arrow keys / wheel scroll slices,
  R reset, F maximize, Esc back to WindowLevel.
- Visual: dark, dense, radiology-grade. Viewports edge to edge, thin chrome,
  monospace overlays (patient, series, slice index, W/L) in the corners.

## Phantom
`python -m hnrad.phantom --out <dir>` writes a synthetic contrast-enhanced neck CT
as a proper DICOM series (512x512, 180 slices, 0.7 mm in-plane, 1.0 mm thick,
int16 HU with RescaleIntercept -1024 or 0 as chosen consistently, proper
ImagePositionPatient / ImageOrientationPatient / FrameOfReference, random but
stable UIDs from a fixed seed, PatientName "PHANTOM^NECK", PatientID "PHANTOM001",
StudyDescription "CT NECK W CONTRAST (SYNTHETIC)"). Must contain, in HU-realistic
values: skin/fat/muscle, cervical vertebral column with spinal canal, mandible arch
and hyoid superiorly, thyroid cartilage shell, an air-filled airway with a focal
narrowing, bilateral bright ICA and IJ tubes (~250 HU), a right tonsillar "tumor"
blob (~70 HU) abutting the right ICA over ~120 degrees of its circumference, and a
necrotic level II node (rim ~90 HU, center ~25 HU). Deterministic.

## Analysis API v0.2

Segmentation, volumetrics and airway analysis. All bodies are JSON, all errors
are `{detail: string}` with **404** (unknown `series_uid` / `label_id`) or
**400** (bad input: seed outside the volume, seed HU outside the window,
`upper_hu <= lower_hu`, an empty result, ...). FastAPI's own 422 still covers
malformed request bodies.

### Conventions

- `ijk` is **`[i, j, k]` = `[column, row, slice]`**; slice `k` indexes the
  series sorted ascending by `slice_pos` (the same order `GET /api/series/{uid}`
  returns). Voxel arrays are `(z, y, x)` = `(k, j, i)`.
- `*_lps` are patient **LPS millimetres**:
  `P = IPP(slice 0) + i·dx·rowDir + j·dy·colDir + k·dz·sliceDir`.
- `bbox_ijk` is `[i_min, j_min, k_min, i_max, j_max, k_max]`, **inclusive**.
- `diameters_mm` are the three PCA extents of the label in millimetres, largest
  first; each is the span of the projected voxel centres plus one voxel width
  along that direction. `longest_axis_mm` is the maximum caliper (Feret)
  diameter over the label's convex hull.
- `volume_ml = n_voxels · dx·dy·dz / 1000`.
- `took_ms` is the server-side wall time that produced the object.

### Labels

A label is a `uint8` mask kept **in memory only**, keyed by a uuid4 string, in
an LRU of 20. Labels do not survive a backend restart (`--reload` counts), and
the oldest is evicted silently once the store is full; a client that gets a 404
should simply re-run the segmentation.

```
POST /api/analysis/region-grow
     body {series_uid, seed_ijk:[i,j,k] | seed_lps:[x,y,z], lower_hu, upper_hu,
           max_radius_mm?: 40, closing_mm?: 0, keep_largest?: true}
     -> LabelStats (below)
     SimpleITK ConnectedThreshold (6-connected) from the seed over the cached
     HU volume, restricted to a sphere of max_radius_mm around the seed so it
     cannot leak into the whole body (null / 0 = no cap). Optional binary
     closing with a ball of closing_mm, then optionally keep only the largest
     component. Exactly one of seed_ijk / seed_lps is required.

POST /api/analysis/threshold
     body {series_uid, lower_hu, upper_hu, inside_body?: true,
           keep_largest?: false, min_component_ml?: 0.05}
     -> LabelStats
     Global HU band. inside_body restricts the result to the body mask: the
     largest 6-connected component of HU > -500, hole-filled slice by slice, so
     an airway threshold (< -400 HU) keeps the lumen and drops the room air
     around the patient. Components smaller than min_component_ml are removed
     (0 disables).

LabelStats = {label_id, n_voxels, volume_ml, bbox_ijk, centroid_lps, mean_hu,
              std_hu, longest_axis_mm, diameters_mm:[a,b,c], took_ms}

GET  /api/analysis/label/{label_id}/stats
     -> LabelStats again (the values recorded when the label was made).

GET  /api/analysis/label/{label_id}/mesh?smooth_iters=10&step=1
     -> binary STL of the label surface, same writer and same LPS millimetre
        frame as POST /api/analysis/isosurface.
        Content-Type application/sla,
        Content-Disposition attachment; filename="label_<label_id>.stl"

GET  /api/analysis/label/{label_id}/mask
     -> Content-Type application/gzip: gzip of the raw uint8 (z, y, x) array,
        one byte per voxel, C order. Headers give the geometry so the frontend
        can build a Cornerstone labelmap:
          X-Shape      "nz,ny,nx"
          X-Spacing    "dz,dy,dx"  (mm, matching the array axes)
          X-Origin     "x,y,z"     LPS of voxel (i=0, j=0, k=0)
          X-Direction  9 floats, row major: rowDir (the +i axis), then colDir
                       (+j), then sliceDir (+k)
          X-Label-Id, X-Series-Uid
        Content-Encoding is deliberately not set, so no proxy or client
        transparently decompresses the body.

DELETE /api/analysis/label/{label_id}
     -> {deleted, labels}          labels = how many remain in the store

POST /api/analysis/distance
     body {label_a, label_b}       both must belong to the same series (400)
     -> {min_distance_mm, point_a_lps, point_b_lps}
     SignedMaurerDistanceMap of label B sampled at label A's surface voxels;
     point_b is the nearest surface voxel of B to point_a. Negative when the
     two labels overlap.
```

### Airway

```
POST /api/analysis/airway
     body {series_uid, seed_ijk | seed_lps  (a point inside the tracheal lumen),
           lower_hu?: -1024, upper_hu?: -400, glottis_slice?: int (k of the
           true vocal folds), reference?: 'auto'|'manual', ref_range_k?: [k0,k1]}
     -> {label_id,                    the airway lumen, stored like any label
         centerline_lps: [[x,y,z],...],
         arclength_mm:   [...],       0 at the most inferior sample
         csa_mm2:        [...],
         eq_diameter_mm: [...],       2·sqrt(CSA/pi)
         min_diameter_mm:[...],       PCA extents of the section
         max_diameter_mm:[...],
         csa_ref_mm2, min_csa_mm2, min_csa_index, min_csa_lps,
         stenosis_pct, stenosis_length_mm,
         distance_from_glottis_mm,    null when glottis_slice is omitted
         myer_cotton_grade,           'I'|'II'|'III'|'IV', null if no reference
         took_ms}
```

All the per-sample arrays are the same length and share one index, ordered
**inferior to superior** (sample 0 is the most caudal); `min_csa_index` indexes
them. Algorithm (TOOLS-SPEC section 4):

1. Region grow the lumen from the seed inside the body mask, then close 1 mm.
2. Centreline by slice-wise centroid tracking: start from the lumen component
   containing the seed and walk superiorly and inferiorly one slice at a time,
   following the component that contains the previous centroid, else the one
   whose centroid is nearest (a jump over 20 mm ends the walk). Smoothed with a
   Gaussian of sigma 2 mm along z; tangents by finite differences.
3. At every sample a 60 x 60 mm plane perpendicular to the tangent is resampled
   at 0.3 mm (SimpleITK ResampleImageFilter, direction matrix built from the
   tangent), thresholded, and the component containing the centreline point is
   measured -> area and PCA diameters.
4. `csa_ref_mm2`: `auto` = the 75th percentile of CSA over the non-stenotic
   samples below (inferior to) the minimum; `manual` = the median of CSA over
   the samples whose slice index falls in `ref_range_k` (400 if `ref_range_k`
   is missing or selects nothing).
5. `stenosis_pct = 100·(1 − min_csa / csa_ref)`, clamped to 0..100.
   `stenosis_length_mm` = the arc length of the contiguous run around the
   minimum where CSA < 0.7·csa_ref.
   `distance_from_glottis_mm` = arc length from the sample nearest
   `glottis_slice` to the minimum.
   Myer-Cotton: I <= 50 %, II 51-70 %, III 71-99 %, IV 100 % (no lumen).

Budget: under 10 s for a 512 x 512 x 180 series on CPU (~4-6 s cold, ~2-3 s
once the body mask is cached). Every route logs its timings to stderr.

## AI API v0.3

Learned segmentation. Two models, both run **out of process**: the FastAPI app
(Python 3.13) never imports torch, nnU-Net or TotalSegmentator — it launches
`backend/ai/run_*.py` with the interpreter at
`%LOCALAPPDATA%\HNRad\venv-ai\Scripts\python.exe` and reads a
one-JSON-object-per-line protocol off its stdout (`backend/ai/README.md`).
A crash, an OOM or a torch upgrade in the inference venv therefore cannot take
the DICOM library or the viewer offline.

Errors are `{detail: string}` as everywhere else: **404** for an unknown
`series_uid` / `job_id`, **400** for an unknown model or task.

### Conventions

- Jobs run **one at a time** on a single background worker thread. `POST`
  returns immediately; the client polls.
- `progress` is 0–1. The app owns the ends (0.03 after the NIfTI export, 1.0
  when the labels are registered); everything between comes from the runner.
- `created_at` / `started_at` / `finished_at` are **unix epoch seconds**
  (float, UTC); the last two are `null` until they happen.
- `log_tail` is the last 80 lines of the runner's merged stdout+stderr plus the
  app's own notes. It is for a status panel, not for parsing.
- A structure's `color` is `[r, g, b]`, 0–255, and is **stable** for a given
  structure name across runs, processes and machines (see *Colours*).

### Models

```
GET  /api/ai/models
     -> {runtime: {venv_python, venv_present, totalseg_home, cache_root,
                   threads, totalsegmentator_version},
         models: [
           {model:'totalseg', title, available, license, default_roi_subset:[...],
            tasks: [{task, weights_present, missing_weights:[...], n_classes,
                     classes:{"1":"spleen", ...}, dataset_ids:[...],
                     crop_from, crop_dataset_ids:[...],
                     fast_allowed, fast_weights_present, license}]},
           {model:'hnlnl', title, available, weights_present, weights_dir,
            license, source, citation, note, n_classes, classes, tasks:[]}
         ]}
```

Class lists come from `backend/ai/class_map.json`, which `backend/ai/dump_classes.py`
dumps from the **installed** TotalSegmentator — never copied from a README.
`weights_present` accounts for the crop model a task depends on: every head/neck
subtask runs `total` first to find its crop box (and `teeth` runs
`craniofacial_structures`), so a subtask with its own weights but no `total`
weights reports `weights_present: false` and lists `Dataset291_*` in
`missing_weights`.

Tasks offered, all **Apache-2.0 code and weights**, no licence key:
`total` (117 classes), `headneck_bones_vessels` (12), `head_glands_cavities` (19),
`headneck_muscles` (23), `craniofacial_structures` (7), `teeth` (77).
TotalSegmentator tasks whose weights need a free non-commercial key
(`heartchambers_highres`, `tissue_types`, `brain_structures`, `face`,
`coronary_arteries`, `appendicular_bones`, `thigh_shoulder_muscles`,
`aortic_sinuses`, …) are **not offered**; none are needed for head and neck.

### Segment

```
POST /api/ai/segment
     body {series_uid,
           model?: 'totalseg' | 'hnlnl'      (default 'totalseg'),
           tasks?: [...],                     (totalseg only; default
                                               ['headneck_bones_vessels'])
           roi_subset?: [...],                (applies to the `total` task only)
           fast?: false}
     -> {job_id, status:'queued', model, tasks, roi_subset, fast}
```

- `roi_subset` restricts the 117-class `total` model. Requesting `total`
  **without** one substitutes `hnrad.ai.DEFAULT_ROI_SUBSET` (thyroid, trachea,
  oesophagus, skull, brain, spinal cord, both common carotids, subclavians,
  brachiocephalic trunk and veins, clavicles, C1–C7): the unrestricted forward
  pass wants ~20 GB, which 32 GB should not be asked for.
- `fast` only affects the `total` task (3 mm weights instead of 1.5 mm); every
  subtask sets `disallow_fast` upstream, so passing it with only subtasks
  selected changes nothing but the cache key. For `hnlnl` it means a
  non-overlapping sliding window (step 1.0 instead of 0.5).
- `tasks` on the `hnlnl` model is a 400.

### Jobs

```
GET    /api/ai/jobs            -> [job, ...]        newest first
GET    /api/ai/jobs/{job_id}   -> job
DELETE /api/ai/jobs/{job_id}   -> {job_id, status, cancelled}

job = {job_id, series_uid, model, tasks, roi_subset, fast,
       status: 'queued'|'running'|'done'|'error',
       progress, message, cached,
       created_at, started_at, finished_at,
       log_tail: [...],
       structures?: [{name, label_id, label_value, n_voxels, volume_ml,
                      color:[r,g,b]}],
       error?}
```

`DELETE` on a `queued` or `running` job cancels it: the subprocess is
terminated and the job ends as `status:'error'` with `error:'cancelled'` —
there is deliberately no fifth status. `DELETE` on a `done` or `error` job
removes it from the list. Either way an unknown `job_id` is a 404.

### Labels: AI output *is* an analysis label

When a job finishes, every non-empty structure is registered in the same
in-memory label store as `POST /api/analysis/region-grow`, so
`GET /api/analysis/label/{id}/stats`, `/mask`, `/mesh`,
`DELETE /api/analysis/label/{id}` and `POST /api/analysis/distance` work on AI
masks **unchanged**. The `label_id` in `structures[]` is exactly the `label_id`
those endpoints take.

Registration is **lazy**. A `headneck_muscles` + `total` run yields ~40
structures; at 512×512×180 that is ~2 GB of `uint8` masks and the label LRU
holds 20. So a job hands out a stable `label_id` per structure immediately and
materialises the mask from the cached multi-label NIfTI the first time one is
asked for (well under a second). The practical consequence inverts the v0.2
rule: an **AI** `label_id` keeps working after the LRU evicts it, for as long
as the disk cache survives. It 404s only once the cache directory is deleted.

`n_voxels` and `volume_ml` in `structures[]` are what the runner measured; the
full `LabelStats` (bbox, centroid, PCA diameters, HU statistics) is computed on
demand by `/stats`.

### Cache

```
%LOCALAPPDATA%\HNRad\ai-cache\<series_uid>\<model>\seg-<variant>.nii.gz
%LOCALAPPDATA%\HNRad\ai-cache\<series_uid>\<model>\result-<variant>.json
```

`<variant>` is a 12-hex-character hash of `{tasks, roi_subset, fast}`, so
different request shapes coexist and never collide. A repeat request is served
from disk: the job still goes `queued → running → done`, but with
`cached: true` and no subprocess, typically in under a second. Deleting the
directory is the supported way to force a recompute.

The series is handed to the model as `.nii.gz` written by SimpleITK from the
cached HU volume, on the series' own grid. SimpleITK holds geometry in LPS and
performs the LPS→RAS flip on write, so the file's `srow` equals

```
P_lps = origin + i·dx·row_dir + j·dy·col_dir + k·dz·slice_dir   (i=col, j=row, k=slice)
P_ras = diag(-1, -1, +1) · P_lps
```

which is the expression `segmentation.ijk_to_lps` already uses — an AI mask and
a region-grown mask land on identical millimetres. A runner **must** write its
segmentation on that same grid; a shape mismatch is reported as a stale cache
rather than silently resampled.

### Colours

`color` is assigned by structure *name*, deterministically (SHA-256 of the
name, never `hash()`), so it is identical across runs, processes and machines:

| family | colour | matches |
|---|---|---|
| arteries | red | carotid, `*_artery`, aorta, brachiocephalic trunk, alveolar/incisive canals |
| veins | blue | jugular, `*_vein`, vena |
| airway and air-filled spaces | cyan | trachea, `larynx_air`, nasal cavity, sinuses, pharynx, auditory canal |
| cartilage | light grey | thyroid / cricoid / arytenoid cartilage |
| bone | off-white | vertebrae, skull, mandible, hyoid, clavicle, zygoma, styloid, hard palate |
| teeth | warm white | incisors, canines, premolars, molars, pulp, crowns, implants |
| glands | yellow | thyroid, parotid, submandibular, sublingual, lacrimal |
| muscles | rose | SCM, constrictors, trapezius, platysma, scalenes, prevertebral |
| neural / orbit | pale violet | spinal cord, brain, optic nerve, globe, lens |
| nodal levels | one hue per level | the 20 HNLNL levels, evenly spaced around the wheel |

A left/right pair gets the *same* colour — it is the same structure. Anything
unrecognised falls back to a muted deterministic colour rather than a random one.

### HNLNL: 20 cervical nodal levels

`model: 'hnlnl'` runs the CC0 model from
<https://github.com/putzfn/HNLNL_autosegmentation_trained_models>
(Putz F et al., *Deep learning for automatic head and neck lymph node level
delineation provides expert-level accuracy*, Front Oncol 2023, PMID 36874135).
Label values 1–20 map to `level_Ia`, `level_Ib_left/right`,
`level_II_left/right`, `level_III_left/right`, `level_IVa_left/right`,
`level_IVb_left/right`, `level_V_left/right`, `level_VIa`, `level_VIb`,
`level_VIIa`, `level_VIIb_left/right`, `level_VIII_left/right`. The full table,
its provenance and the evidence for the id alignment are in
`backend/ai/README.md`.

Three caveats belong in the contract, because they change how the output may be
used:

1. The published weights are **nnU-Net v1**, which neither `nnunetv2` nor any
   Python 3.13 environment can load. `backend/ai/run_hnlnl.py` re-implements
   nnU-Net v1 inference in torch from the shipped `plans.pkl`; the rebuilt
   network loads the released checkpoint `strict=True`, 98/98 tensors.
2. Margin runs a **single fold**, the 3d_fullres model **alone** (the paper
   ensembles it with a 2d model), **without** mirror TTA and **without** the
   repository's slice-plane-adjustment postprocessing. All four make the
   contours worse than the published Dice. They are a starting contour to
   correct, never a measurement.
3. Laterality (`_left` / `_right`) is **not documented** upstream and is
   unverified against a case of known laterality.

### Budget

Segmentation is a background job with a progress bar and a per-series cached
result — never a click-and-wait. Geometry over the resulting masks (the v0.2
Analysis API) stays the interactive layer, in milliseconds. Measured CPU wall
times on the reference box are minutes, not seconds; see `RESEARCH.md` §2.5.
