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
           true vocal folds), reference?: 'auto'|'manual', ref_range_k?: [k0,k1],
           cap_at_glottis?: false}
     -> {label_id,                    the airway lumen, stored like any label
         centerline_lps: [[x,y,z],...],
         sample_k:       [...],       slice index k of every sample
         arclength_mm:   [...],       0 at the most inferior sample
         csa_mm2:        [...],
         eq_diameter_mm: [...],       2·sqrt(CSA/pi)
         min_diameter_mm:[...],       PCA extents of the section
         max_diameter_mm:[...],
         csa_ref_mm2, min_csa_mm2, min_csa_index, min_csa_lps,
         reference,                   'auto'|'manual', the mode that was applied
         ref_range_k,                 the sorted [k0,k1] used, null for auto
         ref_method,                  e.g. 'auto (below the stenosis)',
                                      'auto (whole airway)', 'manual k 12..40'
         capped_at_glottis,           true when samples above the glottis were dropped
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
   whose centroid is nearest. The walk in a direction ends when
   * there is no lumen component of at least 1 mm2 left, or
   * every candidate component is bigger than 300 mm2 **and** bigger than four
     times the running median of the sections accepted so far in that
     direction (seeded with the seed slice) -- the lumen has merged with
     something that is not the airway, typically a lung apex below the
     thoracic inlet, or
   * the chosen centroid is more than 20 mm from the previous one. The jump
     limit applies to every step, including one into the component the
     previous centroid lands in, so a merged trachea-and-lung component cannot
     walk the centreline out into the lung.

   Smoothed with a Gaussian of sigma 2 mm along z; tangents by finite
   differences.
   With `cap_at_glottis` and a `glottis_slice`, every sample superior to that
   slice is dropped first (400 if fewer than 3 remain), so the profile, the
   minimum and the grade describe the laryngotracheal airway and not the
   pharynx and nasal cavity the walk otherwise climbs into on a real neck CT.
   The lumen label is stored whole regardless.
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

## MR and registration API v0.4

MR becomes a first-class modality: the index records what kind of sequence a
series is, the viewer is told what window to open it with, and two series that
do **not** share a frame of reference can be brought into one.

Errors are `{detail: string}` as everywhere else: **404** for an unknown
`series_uid` / `registration_id` / `label_id`, **400** for bad input (an unknown
mode or mask, a label from the wrong series, a `k` past the end of the volume,
a point transform on a B-spline registration).

### Series metadata

`GET /api/studies/{uid}/series` and `GET /api/series/{uid}` gain these fields.
Every one may be `null`; nothing that existed in v0.1 changed shape.

```
frame_of_reference_uid   string    (0020,0052), previously indexed but not exposed
sequence_kind            string    MR only; one of
                                   T1 T1C T1C_FS T2 T2_FS STIR FLAIR
                                   DWI ADC SWI MRA PD LOCALIZER OTHER
acquired_plane           string    AX | COR | SAG | OBL, from ImageOrientationPatient
is_thick                 bool      through-plane spacing > 2.5 mm
scanning_sequence        string    (0018,0020)  e.g. "SE\IR"
sequence_variant         string    (0018,0021)
echo_time                number    (0018,0081)  ms
repetition_time          number    (0018,0080)  ms
inversion_time           number    (0018,0082)  ms
flip_angle               number    (0018,1314)  degrees
magnetic_field_strength  number    (0018,0087)  tesla
contrast_agent           string    (0018,0010)  ContrastBolusAgent, verbatim
has_contrast             bool      CT and MR: agent present, or the description
                                   says post / +C / Gd / CE (and does not say pre)
kernel                   string    CT (0018,1210) ConvolutionKernel
window                   object    the cached auto window, or null:
                                   {lower, upper, method}
```

`sequence_kind` is deliberately `null` on a CT or a PT rather than `OTHER`: it
is an MR concept, and filling it for every CT in the library would make the
column meaningless.

**`sequence_kind` rule set** (`hnrad.mr.classify_sequence`; the table in
`backend/tests/test_mr.py` is the executable copy). Rules are ordered and the
first match wins. The description wins over the physics wherever it is
explicit, because a protocol name is more reliable than a TE threshold.

1. `ImageType` contains LOCALIZER, or the description says localizer / scout /
   survey / 3-plane / loc → **LOCALIZER**
2. description says ADC / eADC / apparent diffusion → **ADC**
   (before DWI: "DWI ADC map" is both)
3. description says DWI / DTI / diffusion / trace / resolve / b*nnn*, **or**
   `ScanningSequence` contains `EP` and the description does not name a
   non-diffusion echo-planar use (perfusion, BOLD, fMRI, DSC, DCE) → **DWI**
4. description says SWI / SWAN / susceptibility / venoBOLD → **SWI**
5. description says MRA / MRV / TOF / time-of-flight / angio → **MRA**
6. description says FLAIR / dark-fluid, **or** `IR` with `TI > 1400 ms` and
   `TE >= 60 ms` → **FLAIR**
7. description says STIR / short-tau, **or** `IR` with `80 <= TI <= 400 ms`
   → **STIR**
8. base weighting — from the description when it names T1 (t1, MPRAGE, BRAVO,
   SPGR, FLASH, VIBE, THRIVE, LAVA, TFE), T2 (t2, HASTE, CISS, FIESTA, DRIVE,
   SPACE, CUBE) or PD; otherwise from the physics:
   `TE < 30` and `TR < 900` → T1; `TE < 30` and `TR >= 1500` → PD;
   `TE >= 60` → T2; a spoiled gradient echo (`GR` + SP/SS/MP) with `TR < 100`
   and a flip angle `>= 10` → T1
9. a T1 with contrast → **T1C**; with contrast **and** fat saturation →
   **T1C_FS**
10. a T2 with fat saturation → **T2_FS**
11. nothing matched → **OTHER**

Fat saturation is read from the description (fs, fatsat, fat sat, fat supp,
SPAIR, SPIR, Dixon, mDixon, CHESS, IDEAL), from `ScanOptions` and from
`ImageType`. Contrast is `ContrastBolusAgent` being present and not
none/no/0, or the description saying post / postcontrast / +C / C+ / Gd / gad /
CE / KM / w/c; `pre` or `non-contrast` in the description vetoes the
description-derived form but never a populated `ContrastBolusAgent`.

`acquired_plane` is the dominant component of `rowDir x colDir` in LPS — `z`
axial, `y` coronal, `x` sagittal — and is `OBL` when the largest direction
cosine is below 0.9 (more than ~26 degrees off every axis).

`POST /api/import` fills all of it. Re-importing an already-indexed library
updates the columns in place and creates no duplicate rows: `SOPInstanceUID` is
still the primary key and the series upsert still coalesces.

### Database migration

The columns above are added to `series` by an **additive** migration
(`hnrad.db.migrate`, driven by `hnrad.db.SERIES_V04_COLUMNS`): one
`ALTER TABLE series ADD COLUMN` per missing column, which sqlite performs
without rewriting the table. It runs inside `init_db`, so opening an existing
library upgrades it. Nothing is ever dropped or renamed, existing rows are
untouched (the new columns start `NULL`), running it twice adds nothing, and a
v0.1 backend keeps working against a v0.4 database.

### Windowing

CT thumbnails keep the fixed W350/L40 soft-tissue neck window. **MR, PT and
anything else whose values are not Hounsfield units** get a robust percentile
window instead — a fixed HU window renders an MR as a black square, and MR
values are arbitrary scanner units (the HaN-Seg T1 volumes range from 0–5000 on
some scanners and 32768–37795 on others).

```
GET /api/series/{series_uid}/window?refresh=false
     -> {lower, upper, method, cached, computed_at?, n_slices_sampled?}
```

`method` is `"ct-fixed-w350-l40"` for CT, or
`"percentile-1-99-nonzero"` — the 1st and 99th percentile of the **non-zero**
voxels, over up to 16 evenly spaced slices read off disk and then pixel-strided
to at most 2 000 000 samples. Non-zero matters: the air around the patient is
exactly 0 on most MR reconstructions and would otherwise drag the lower
percentile onto the background. Degenerate inputs fall back to `"min-max"`,
`"degenerate"` or `"empty"`, always with `upper > lower`.

The result is cached in the series row and returned with `cached: true`
thereafter; `?refresh=true` recomputes it. `GET /api/series/{uid}/thumbnail`
uses the cached window when there is one and otherwise windows the middle slice
the same way, so a thumbnail never needs the client to know the modality.

### Registration

Engine: **itk-elastix** 0.25.4 (Apache-2.0, `cp311-abi3` wheel, verified on
this box's CPython 3.13). Mutual information, multi-resolution, CPU only. If
`itk` cannot be imported the module falls back to SimpleITK's
`ImageRegistrationMethod` with Mattes MI, which covers `rigid` and `affine` but
not `bspline`; `quality.engine` always says which one ran.

```
POST /api/registration
     body {fixed_series_uid, moving_series_uid,
           mode?: 'rigid'|'affine'|'bspline'   (default 'rigid'),
           mask?: 'bone'|'body'|null           (default null),
           resample_mm?: 2.0,                  (0.25 .. 10)
           force?: false}
     -> {registration_id, fixed_series_uid, moving_series_uid, mode, mask,
         resample_mm, engine, transform_4x4 | null, quality, took_ms,
         created_at, parameter_file, result_file, cached}

GET  /api/registration/{registration_id}
     -> the same object, cached: true
```

- `transform_4x4` is a row-major 4x4 that maps **fixed LPS millimetres ->
  moving LPS millimetres** (elastix's own direction, and the one a resampler
  wants: the moving image is sampled at `T(p)` for each fixed voxel centre
  `p`). It is `null` for `mode: 'bspline'`, which is not a linear map;
  `POST /api/registration/{id}/resample` warps a B-spline through transformix
  instead, and the quality report scores it from the image elastix resampled
  onto the fixed grid.
- `mode: 'bspline'` runs a **rigid stage and then the B-spline** in one elastix
  call (RESEARCH.md item 11: bone-weighted rigid init, then a constrained
  B-spline), so `parameter_file` holds two parameter maps.
- `mask` restricts the similarity metric. `bone` is HU >= 200 on a CT and
  falls back to the body on a non-CT image, which has no bone signal; `body`
  is HU > -500 on a CT and an Otsu threshold elsewhere, largest component,
  holes filled slice by slice. The fixed mask is additionally confined to the
  part of the fixed image the moving image can actually reach (its footprint
  after pre-alignment, dilated by 30 mm).
- Both volumes are resampled to an isotropic `resample_mm` grid before the fit.
  The transform is in millimetres and does not depend on that choice.
- Initialisation is **not** elastix's geometric centre: the moving image is
  pre-shifted so its body centroid meets the fixed body centroid, then a
  translation-only elastix stage runs, and only then the requested mode. Both
  shifts are folded back into `transform_4x4`. This is what makes two series
  hundreds of millimetres apart in their stored frames registerable at all.
- `registration_id` is a deterministic 16-hex digest of
  `(fixed, moving, mode, mask, resample_mm)`, so an identical request returns
  `cached: true` without recomputing. `force: true` recomputes.

`quality`:

```
metric                  "normalized_mutual_information"
nmi_before, nmi_after   Studholme NMI on the registration grid; 1.0 = independent
nmi_gain                nmi_after - nmi_before
final_metric            = nmi_after
msd_bone_before/after   mean squared difference over fixed voxels >= 200 HU;
                        null unless BOTH series are CT
dice_body_before/after  Dice of the two body outlines
dice_body_scope         "inside the moving field of view"
overlap_voxels_before/after
engine                  "itk-elastix" | "simpleitk"
timings_ms              {load, prepare, optimise}
```

A value is `null` where it is undefined — `nmi_before` is `null` when the two
series do not overlap at all under their stored geometry, which is the normal
case for an unregistered CT/MR pair.

**`nmi_after` is the go/no-go indicator, and it is not optional.** NMI is 1.0
for statistically independent images. On the HaN-Seg CT/MR pairs a good rigid
fit scores 1.17–1.21 and a failed one 1.02, with no other externally visible
difference. A registered contour or a fused image is an editable suggestion
with a quality score, never a measurement (RESEARCH.md item 11).

Persistence: `%LOCALAPPDATA%\HNRad\registrations\<fixed>_<moving>.json` and
`.txt` (the elastix parameter maps), plus `<fixed>_<moving>.<mode>.json` /
`.txt` so different modes of one pair coexist. `GET /api/registration/{id}`
finds a registration from an earlier process by scanning that folder, so a
backend restart does not lose one.

### Applying a registration

```
POST /api/registration/{registration_id}/resample
     body {label_id}            warp a label from the MOVING series into the
                                FIXED frame
     -> {label_id,              a NEW label on the fixed series
         registration_id, source_label_id, series_uid, ...LabelStats}

     body {series: 'moving'}    resample the moving VOLUME into the fixed frame
     -> {registration_id, series:'moving', series_uid, shape:[nz,ny,nx], took_ms}
```

The warped mask is registered in the same in-memory label store as
`POST /api/analysis/region-grow`, so `/stats`, `/mask`, `/mesh`, `DELETE` and
`POST /api/analysis/distance` all work on it unchanged. A `label_id` belonging
to a series other than `moving_series_uid` is a 400. Nearest-neighbour
interpolation, thresholded at 0.5, so a warped mask stays binary.

```
GET  /api/registration/{registration_id}/moving-slice?k=<int>&size=512
     -> PNG of slice k of the resampled moving volume, windowed by the moving
        series' modality.  k indexes the FIXED series, so the same k in
        GET /api/series/{fixed_uid} is the slice it overlays.
        Headers X-Window-Lower / X-Window-Upper.
        400 when k is past the end of the fixed volume.
```

```
POST /api/registration/{registration_id}/transform-points
     body {points_lps: [[x,y,z], ...],
           direction?: 'fixed_to_moving' | 'moving_to_fixed'}
     -> {registration_id, direction, points_lps: [[x,y,z], ...]}
```

400 on a B-spline registration (no closed-form point map), on a direction other
than the two above, and on anything that is not a list of 3-vectors.

### Budget

Rigid, 2 mm, a 1024x1024x202 CT against a 512x512x144 MR: **17–35 s wall** on
this box's CPU including reading both series off disk (10–13 s of that is the
elastix optimisation). Affine is comparable; B-spline on a full neck pair is
minutes and belongs in a background job. The volume LRU holds two series, which
is exactly a registration pair.

Accuracy, measured on a synthetic phantom translated by a known
`[4, -3, 2] mm` (`backend/tests/test_registration.py`), as the worst error over
probe points spanning the volume:

| mode | mask | max point error |
|---|---|---|
| rigid | none | 0.008 mm |
| rigid | bone | 0.19 mm |
| rigid | body | 0.25 mm |
| affine | none | 0.05 mm |

A metric mask throws away most of the image, so it costs an order of magnitude
of precision on a phantom while buying robustness on a real pair. The tests
hold rigid to 0.5 mm in every configuration.
