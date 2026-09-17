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
