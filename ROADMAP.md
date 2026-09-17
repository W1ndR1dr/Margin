# HNRad — Head & Neck Surgical Radiology Assistant

Local-only radiology workstation for head and neck cancer surgery. DICOM never
leaves the device. Runs on a locked-down Windows 11 box with no admin rights:
Python 3.13 (user install), Node 20 (user install), Intel UHD 770 (WebGL).

## Clinical questions the tool must help answer

**Primary / T-stage** — 3D extent and volume; depth of invasion; cortical vs
medullary mandible invasion; inferior alveolar canal; thyroid cartilage inner vs
outer cortex; paraglottic / pre-epiglottic space; subglottic extent; prevertebral
fat plane; carotid contact in degrees; skull base foramina and perineural spread
(V2/V3); extrinsic tongue muscles.

**Nodes / neck dissection** — Robbins level; short axis; necrosis; radiologic
ENE; retropharyngeal nodes; relation to IJ, carotid, vagus, phrenic, brachial
plexus; contralateral and level V disease; post-dissection anatomy.

**Resectability / vascular safety** — retropharyngeal or medialized ICA before
TORS / tonsil surgery; lingual artery course; aberrant right subclavian
(non-recurrent laryngeal nerve); high-riding innominate before trach; IJ patency;
recipient vessels for free flap.

**Salivary / parapharyngeal** — deep vs superficial parotid lobe
(retromandibular vein plane); prestyloid vs poststyloid; ICA displacement;
stylomastoid foramen widening.

**Thyroid / parathyroid / airway** — tracheal and esophageal invasion; TE groove;
substernal extent vs arch; 4D-CT parathyroid candidates; narrowest airway CSA,
stenosis length, distance from glottis; trismus / retrognathia.

**Reconstruction** — mandible defect length and HCL class; fibula segments;
plate pre-bend model (STL); maxillectomy class; soft tissue defect volume;
peroneal runoff.

**Surveillance** — registered prior vs current; NI-RADS; recurrence vs flap /
fibrosis / ORN; PET SUVmax and MTV; unknown-primary hotspot mapping.

**Communication** — tumor board key images and 3D snapshots; patient-facing 3D;
STL export for printing.

## Feature roadmap (priority order)

1. [x] Local DICOM library (folder import, SQLite index, serve to viewer)      — v0.1
2. [x] Fast MPR viewer, neck window presets, linked crosshairs, cine          — v0.1
3. [x] 3D volume rendering with H&N presets (bone, CTA/soft tissue, airway)   — v0.1
4. [x] Measurement toolkit (length, bidirectional, angle, probe, ROI)         — v0.1
5. [ ] Carotid encasement tool (degrees of circumferential contact)          — v0.2
6. [ ] Segmentation: threshold / region grow, brush, volumetrics, STL export  — v0.2
7. [ ] Neck level mapper (landmark-driven Robbins level assignment)           — v0.3
8. [~] Airway patency for anaesthesia planning (min lumen at tumour level,
        distance from incisors/glottis, difficult-airway flag). Myer–Cotton
        grading removed from the UI (Brian: "parlor trick", 2026-09-17)      — v0.3
9. [ ] Mandible planner (canal, osteotomies, defect length, fibula segments)  — v0.4
10. [ ] Vascular safety flags (retropharyngeal ICA, aberrant subclavian)      — v0.4
11. [ ] Compare mode (rigid registration prior vs current, delta volume)      — v0.5
12. [ ] PET/CT fusion, SUV, MTV                                               — v0.5
13. [ ] AI organ segmentation (TotalSegmentator, CPU)                         — v0.6
14. [ ] Reporting / tumor board export / de-identified sharing                — v0.6
15. [ ] Click-prompted tumour / node contouring (nnInteractive, VISTA-3D, SAM)  — v0.6
16. [ ] Margin MCP server: Claude drives segment / measure / report            — v0.7
17. [ ] In-app Claude panel: Agent SDK + Margin MCP tools; only structure names,
        measurements and derived numbers are sent, shown verbatim to the user   — v0.7
18. [ ] Learn-from-corrections loop (CT foundation embeddings + probes)        — v0.8

Note (2026-09-17): personal, non-commercial tool, so non-commercial weights (VISTA-3D,
nnInteractive, MedSAM2) are in scope. See RESEARCH.md section 0.

## Stack decision (2026-09-17)

Web stack, not Rust/C++/C#: the heavy lifting is GPU volume rendering (WebGL via
VTK.js/Cornerstone3D) and C++-backed Python numerics (SimpleITK, numpy,
scikit-image). Rust/C++/Tauri need the MSVC linker, which requires admin to
install. React + TypeScript for the interface (same as OHIF), Cornerstone3D for
the viewports, FastAPI + pydicom for the local library.

## AI-native UX target (Brian, 2026-09-17: "AI native and modern, not old school")

The viewer must know the anatomy before the surgeon asks. Build toward this, not
toward more traditional viewer chrome:

- Segmentation runs automatically on import, in the background; structures are
  present when a study is opened (TotalSegmentator H&N tasks + nodal levels).
- The cursor knows where it is: status bar shows the structure under the cursor
  ("Right internal carotid", "Level IIa"); measurements are auto-labelled by the
  structures they touch.
- "Ask Margin": conversational panel (Agent SDK + Margin MCP tools). Natural
  language runs tools and draws results on the image with numbers.
- Findings card on open: airway narrowest point, carotid contact per side,
  node counts by level, retropharyngeal carotid (<5 mm to pharynx), aberrant
  subclavian flag. Each item jumps to its slice; each number is drawn on the image.
- Snap-to-anatomy tools: tumour-to-carotid distance is one click on the tumour;
  node short axis snaps to the node boundary.
- Click-to-contour tumour / node (nnInteractive, SAM) with editable result and
  volume against prognostic thresholds.
- Compare mode reads the prior: register, then "what changed" as a list with
  volume deltas and new/resolved nodes.
- Library import: native folder picker (index in place) and drag-and-drop
  (stream to local backend, copy into store) with progress. (queued)

## Priority order (Brian, 2026-09-17)

1. Tumour and node: click-to-contour, volume vs prognostic thresholds, node
   short axis / necrosis / level, carotid contact sweep across all slices.
2. Bone and skull base: mandible cortical vs medullary invasion flag, tumour
   to inferior alveolar canal distance, thyroid cartilage inner vs outer cortex.
3. Vascular safety: retropharyngeal ICA distance (TORS), aberrant subclavian
   (thyroid), IJV patency and recipient vessels (free flap).
4. Compare (registered prior vs current, volume deltas) and PET (SUV, MTV).
5. Report and tumour board export.
Airway stenosis grading is out of scope; airway patency stays as a findings-card flag.

## Perineural spread screening (added 2026-09-17)

Macroscopic perineural tumour spread only (microscopic PNI is not an imaging
finding). Findings-card flag built from geometry, after registration lands:
- Register a foramina-labelled skull template to the patient's skull mask to
  localise foramen ovale / rotundum, stylomastoid foramen, greater palatine
  canal, pterygopalatine fossa.
- Per-foramen cross-sectional area and side-to-side asymmetry; fat-pad mean HU
  asymmetry (pterygopalatine fossa, foramen ovale, stylomastoid); masticator
  muscle volume and fat-fraction asymmetry from the headneck_muscles masks;
  mandibular canal widening near the tumour.
- MR (T1 post-contrast) nerve enlargement/enhancement when an MR series exists.
Output: "possible Vn perineural spread, recommend MRI" with each number drawn
on the image. Never a diagnosis.

## Facial trauma workspace (added 2026-09-17; Brian: "CT for fractures + 3D recons of bone to eval fracture patterns")

No panoramic reformat. Build on the skull / mandible / teeth masks:
- Bone recon with per-fragment colouring (bone mask split at fracture lines
  into connected fragments), skin off, teeth coloured, preset views incl.
  head-of-bed surgeon's view.
- Mirror overlay: mirror the uninjured side across the midsagittal plane,
  register onto the injured side, displacement heatmap + numbers (ZMC
  rotation/posterior displacement, condylar angulation/override, rim step).
- Orbital volume difference (enophthalmos risk > ~1.5-2 mL) and floor /
  medial wall defect area for implant sizing.
- Fracture line detection (cortical breach detector) labelled by mandible
  region (symphysis, parasymphysis, body, angle, ramus, condyle, subcondylar)
  and midface pattern (Le Fort I-III, ZMC, NOE, frontal sinus) from buttress
  crossings; tooth-in-line-of-fracture flag; dental arch relationship.
- Plate and screw planning on the surface (shares the VSP osteotomy tooling).
Separate "Trauma" findings card; every line drawn on the 3D surface.
