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
