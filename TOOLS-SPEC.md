# HNRad clinical tools — algorithm specs (v0.2–v0.3)

All coordinates are DICOM LPS millimetres unless stated. HU = Hounsfield units.
Every tool must (a) be usable in under 30 seconds by a surgeon, (b) show its
inputs on the image so the result can be sanity-checked, (c) export its result
into the measurement list and the report.

## 1. Carotid encasement (degrees of circumferential contact)

Clinical use: T4b / resectability. >270° = encasement, 180–270° = high risk,
<180° = usually resectable.

Input: on one axial slice the user places a **CircleROI on the carotid lumen**
(centre c, radius r) and traces the **tumor with PlanarFreehandROI** (closed
polygon P). Optional: contact tolerance t (default 1.5 mm).

Algorithm (frontend, TypeScript, pure function with unit tests):
1. Sample the vessel circumference at N=360 points q_k = c + r·(cos θ_k, sin θ_k).
2. For each q_k compute signed distance to polygon P: negative if inside P,
   else min distance to any edge.
3. q_k is "in contact" if distance ≤ t.
4. Contact angle = 360 · (#contact) / N. Also report the longest contiguous arc
   (handles tumour touching in two separate places) and the clock-face range.
5. Draw the contact arc on the vessel in warning colour; label "132° contact".
6. Optionally repeat automatically on adjacent slices by propagating the circle
   (Hough-like refit: threshold >150 HU within a 3 mm search window) and the
   polygon is re-traced by the user; report max angle across slices.

Output: {angle_deg, longest_arc_deg, clock_from, clock_to, slice, series_uid,
vessel_center, vessel_radius_mm}. Category label: <180 "abutment",
180–270 "partial encasement", >270 "encasement".

## 2. Tumor segmentation and volumetrics

Tools: Cornerstone3D segmentation with Brush (sphere / circle), Threshold brush
(only paint voxels within [lo, hi] HU), Scissors (rect / circle / freehand),
Interpolation between key slices (Cornerstone contour interpolation), Region
grow from a seed (backend: SimpleITK ConnectedThreshold with HU window and
a 40 mm radius cap so it cannot leak into the whole body).

Volumetrics: volume_ml = n_voxels · dx·dy·dz / 1000. Report also longest axis
(PCA on voxel coordinates → 2·max singular extent), the 3 orthogonal maximal
diameters, mean/SD HU, centroid, and the min distance to a second labelled
structure (e.g. carotid segment, mandible) via distance transform on the
second label (SimpleITK SignedMaurerDistanceMap) sampled at the tumour surface.

Exports: label map as DICOM SEG (pydicom highdicom optional; else NIfTI), mesh
as STL (marching cubes on the label, smoothing 10 iters), volume history per
patient for surveillance plotting.

Presets: **Bone** (>250 HU), **Airway** (<-400 HU inside the body mask),
**Contrast vessels** (150–500 HU excluding bone by connectivity), **Enhancing
tumour** (40–120 HU, seed required).

## 3. Neck level mapper (Robbins 2008 / AJCC radiologic boundaries)

Landmarks the user clicks once per scan (or accepts auto-detected candidates):
- Hyoid body inferior edge (z_hyoid)
- Cricoid cartilage inferior edge (z_cricoid)
- Skull base / jugular foramen (z_skullbase) — optional, default top of scan
- Clavicle / sternal notch (z_clavicle) — optional, default bottom of scan
- Per side: posterior border of SCM (polyline, one point per ~15 slices),
  posterior border of submandibular gland (point), internal jugular vein
  centre (point per ~15 slices), anterior belly of digastric (point),
  posterior belly of digastric / lateral edge (for IIa/IIb: the IJV posterior edge)
- Common carotid medial edge (for level VI: between carotids)

Classification of a clicked node with centroid (x, y, z):
1. z ≥ z_hyoid and anterior to the posterior border of submandibular gland
   → Level I. Medial to anterior digastric bellies → Ia, else Ib.
2. z ≥ z_hyoid and posterior to submandibular gland, anterior to SCM posterior
   border → Level II. Posterior to the IJV posterior edge (with a fat plane) → IIb
   else IIa.
3. z_cricoid ≤ z < z_hyoid, anterior to SCM posterior border, lateral to
   carotid → Level III.
4. z < z_cricoid, same lateral constraints → Level IV.
5. Posterior to SCM posterior border (any z below skull base, above clavicle)
   → Level V; Va above the cricoid plane, Vb below.
6. Between the carotids, below hyoid, above sternal notch → Level VI.
7. Below sternal notch → Level VII.
8. Retropharyngeal (posterior to pharyngeal wall, medial to ICA, anterior to
   prevertebral muscles) → "RP" (flag: not addressed by standard neck dissection).

Side determined by sign of x relative to the midline (mean of the two carotid
centres). Output: level string, confidence ("clear" if >5 mm from every boundary
else "boundary — verify"), and a per-level tally for the neck dissection plan.
Draw the level boundaries as translucent bands on the sagittal/coronal views.

## 4. Airway analyzer

1. Airway mask: region grow from a seed placed in the trachea, HU < -400,
   connectivity 6, capped to the body mask; close 1 mm to remove wall pixels.
2. Centreline: SimpleITK BinaryThinning on a 1 mm isotropic resample, or
   iterative slice-centroid tracking with smoothing (simpler, adequate for the
   trachea/larynx). Parameterise by arc length s.
3. At each s, cut a plane perpendicular to the centreline, intersect with the
   mask (resample a 60×60 mm patch at 0.3 mm), compute cross-sectional area
   (CSA), min/max diameter (PCA of the boundary), and equivalent diameter.
4. Reference CSA = median CSA over the normal segment the user brackets (or
   the 75th percentile of the trachea below the stenosis).
5. Stenosis % = 100 · (1 − CSA_min / CSA_ref) (Myer–Cotton grades: I <50,
   II 51–70, III 71–99, IV no lumen). Stenosis length = arc length where
   CSA < 0.7 · CSA_ref. Distance from glottis = arc length from the user-marked
   true vocal fold level to CSA_min.
6. Output a CSA-vs-length chart in the right panel, click on the chart jumps
   the MPR to that level and shows the perpendicular section. 3D: render the
   airway cast with the stenotic segment coloured.
7. Fly-through: camera along the centreline in the 3D viewport (virtual
   laryngoscopy), speed slider, screenshot key frames.

## 5. Vascular safety flags (v0.4 preview)

Run automatically after contrast-vessel segmentation:
- **Retropharyngeal ICA**: min distance from ICA centreline to the pharyngeal
  mucosal surface (airway mask boundary) between hyoid and skull base; flag if
  < 2.5 mm ("medialised") or if ICA lies medial to the posterior tonsillar
  pillar plane at any level.
- **Aberrant right subclavian**: at the arch level (if imaged), detect a
  contrast vessel crossing behind the oesophagus/trachea from left to right;
  flag "non-recurrent laryngeal nerve possible".
- **High innominate**: innominate artery crossing anterior to the trachea at or
  above the sternal notch plane; flag for tracheostomy.
- **IJV thrombosis / absence**: IJ segment with < 100 HU mean over > 2 cm.
