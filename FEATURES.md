# Margin — full feature brainstorm (2026-09-17)

Status: ✅ built · 🔧 in progress · 📐 designed · 💡 idea. Priority tags from
Brian: [P1] tumour/node, [P2] bone/skull base, [P3] vascular safety,
[P4] compare/PET, [P5] report. Trauma: build all. MRI: first class.

## 1. Library, data, integration
- ✅ Local DICOM library, folder import in place, SQLite index, thumbnails
- 📐 Drag-and-drop import (stream to local backend), native Browse folder picker
- 💡 PACS query/retrieve from inside Margin (C-FIND/C-MOVE via pynetdicom,
  read-only, local AE) so a case pulls in one click; DICOMDIR CD/USB import
- 💡 Auto de-identification on import (option) and de-identified export
- 💡 Patient timeline: every study on one strip (CT, MR, PET, US, photos)
- 💡 Tumour board tags, clinic-list batch: "process Thursday's list overnight"
- 💡 Search by finding ("carotid contact > 180", "level IV positive")
- 💡 Watch folder: anything dropped in is indexed and segmented automatically
- 💡 Clinical photos and endoscopy stills attached to the study (tumour board)
- 💡 Ultrasound clips import; neck US measurements and TI-RADS calculator
- 💡 Storage manager, backups, audit log of every AI result and export

## 2. Viewer (Read workspace)
- ✅ MPR + 3D, presets, crosshairs, cine, measurements, snapshot, hotkeys
- 📐 v2 shell: primary view + context strip, Findings first, Ask Margin, no
  generic elements, Phosphor + Health Icons (UI-OVERHAUL.md)
- 🔧 MRI first class: sequence browser (T1/T1C-FS/T2/DWI/ADC), auto windowing,
  acquired-plane primary, linked scrolling across sequences, ADC readout,
  subtraction (T1C − T1), MR presets
- 💡 Hanging protocols by question: "neck CT", "MR skull base", "PET/CT",
  "trauma", "thyroid 4D"
- 💡 MIP / MinIP / thick slab (vessels, airway); curved planar reformat along
  a vessel (carotid, lingual, facial artery) — not panorex
- 💡 Fusion: CT+MR, PET+CT, PET+MR with registration and a blend slider
- 💡 Endoscopic / TORS view: virtual camera in the oral cavity looking at the
  tongue base with ICA and lingual artery drawn through the tissue
- 💡 Skin-ghost 3D for patient-facing explanation; lighting presets
- 💡 Multi-monitor layout; tablet review over LAN (read-only)

## 3. Measurement and geometry tools
- ✅ Length, bidirectional, angle, ROI, probe; carotid contact degrees (one slice)
- 🔧 Structures: threshold / region grow / AI masks, volumes, STL, distances
- 📐 Carotid contact sweep across all touching slices, max angle, contact
  length, fat-plane preservation count, eccentricity [P1]
- 💡 Anatomy-snapped tools: tumour→carotid, tumour→canal, tumour→skull base
  in one click because the structures are known [P1/P2]
- 💡 Node tools: short axis auto-snap, necrosis (rim/centre HU), matting,
  ENE signs (irregular border, fat infiltration) as a checklist with numbers [P1]
- 💡 Depth of invasion caliper on MR/CT with the "overestimates histology" caveat [P1]
- 💡 Tumour volume vs prognostic thresholds (GTVp < 30 cc etc.) [P1]
- 💡 Cartilage invasion assessment: thyroid cartilage inner vs outer cortex,
  sclerosis/erosion/lysis flags, T3 vs T4a language with caveats [P2]
- 💡 Prevertebral fat plane profile along the tumour [P3]
- 💡 Retropharyngeal ICA distance to pharyngeal wall per side (TORS) [P3]
- 💡 Aberrant right subclavian / non-recurrent laryngeal nerve flag [P3]
- 💡 High-riding innominate, tracheal deviation, skin-to-trachea depth (trach)
- 💡 Airway patency at the tumour level for anaesthesia (min lumen, distance
  from incisors/glottis) — no stenosis grading
- 💡 Substernal goitre extent vs arch/innominate; tracheal compression %

## 4. AI perception layer
- ✅ TotalSegmentator H&N tasks (bones, vessels, cartilage, glands, muscles,
  mandible, teeth, canals), 20-level nodal model, job API, lazy labels
- 🔧 Validation on HaN-Seg (Dice, surface distance) and speed report
- 💡 Segment on import, in the background; readiness shown in the Library
- 💡 Click-to-contour tumour and nodes (nnInteractive / SAM-Med3D / VISTA-3D),
  editable, volumes, on CT and MR [P1]
- 💡 Speed: downsample to ~1 mm before inference, single-process subtasks,
  OpenVINO on the Intel iGPU
- 💡 Uncertainty display: low-confidence structures hatched, never silent
- 💡 Learn-from-corrections: every edited contour saved as training data;
  CT-foundation-embedding probes trained on Brian's cases
- 💡 Autoresearch loop (Karpathy-style): agent iterates post-processing and
  probe training overnight against the HaN-Seg/HECKTOR harness

## 5. Oncology findings card (per site)
- 💡 Oral cavity: DOI, mandible cortical/medullary/canal, extrinsic tongue muscles
- 💡 Oropharynx: carotid, prevertebral, parapharyngeal, skull base, RP nodes
- 💡 Larynx/hypopharynx: cartilage, paraglottic/pre-epiglottic, subglottic
  extent, oesophagus, airway patency
- 💡 Nasopharynx/sinonasal/skull base: foramina, orbit, dura, PPF, ITF, clivus
- 💡 Salivary/parapharyngeal: deep vs superficial lobe (retromandibular vein
  plane), pre/post-styloid, ICA displacement, stylomastoid foramen
- 💡 Thyroid/parathyroid: trachea/oesophagus/TE groove invasion, ARSA,
  4D-CT parathyroid candidate finder (arterial enhancement, washout, ectopic sites)
- 💡 Perineural spread screening: foramen asymmetry, fat-pad loss,
  denervation atrophy, MR nerve enhancement (ROADMAP)
- 💡 Nodal summary by level with dissection suggestion; contralateral risk
- 💡 Resectability summary with the criteria applied and their sources
- 💡 AJCC 8 T/N descriptor draft with explicit "imaging-only" caveats

## 6. Reconstruction and VSP (Plan workspace)
- 💡 Mandible: osteotomy planes, resected segment, defect length, HCL/Brown
  class, STL of resected and remaining bone
- 💡 Fibula: import leg CTA, segment fibula, auto-fit segments to the arc,
  wedge angles, segment lengths, peroneal runoff check, skin paddle perforators
- 💡 Maxilla/orbit: Brown class, orbital floor, obturator vs flap planning
- 💡 Soft-tissue defect volume estimate → flap choice aid (RFFF vs ALT vs scapula)
- 💡 ALT / other perforator mapping from CTA (perforator location relative to
  ASIS–patella line); DCIA, scapular tip options
- 💡 Recipient vessel map: facial, superior thyroid, transverse cervical;
  IJ/EJ patency; prior neck dissection and radiation fields
- 💡 Dental status and implant planning from the teeth masks
- 💡 Hand-off of STLs to 3D Slicer Bone Reconstruction Planner for printable
  cutting guides; print-ready mandible model export

## 7. Facial trauma workspace (build all)
- 💡 Bone recon with per-fragment colouring; skin off; teeth coloured; preset
  views incl. head-of-bed
- 💡 Mirror overlay of the uninjured side with displacement heatmap and
  numbers (ZMC rotation, condylar angulation/override, rim step)
- 💡 Orbital volume difference; floor/medial wall defect area for implants
- 💡 Fracture line detection labelled by mandible region and midface pattern
  (Le Fort I–III, ZMC, NOE, frontal sinus, panfacial)
- 💡 Tooth-in-line-of-fracture; occlusion/dental arch relationship
- 💡 Plate and screw planning on the surface; plate length/bend preview
- 💡 Trauma findings card and a one-page trauma summary for the OR

## 8. Surveillance (Compare workspace) [P4]
- 💡 Registered prior vs current, synced scroll and W/L, "what changed" list
- 💡 Volume trend per structure; new/resolved nodes; flap volume over time
- 💡 NI-RADS structured entry with linked management
- 💡 PET: SUVmax/mean, MTV, TLG in a mask; PET-guided unknown-primary checklist
  with site-specific false-positive priors
- 💡 ADC values and recurrence-vs-post-treatment support panel (features shown,
  literature cited, no verdict until locally validated)
- 💡 ORN monitoring of the mandible over time

## 9. Communication and teaching [P5]
- 💡 Report drafting (structured, copy-as-text for Epic), DICOM SR export
- 💡 Tumour board export: key images, 3D snapshots, findings table → PPTX
- 💡 Patient-facing 3D: de-identified mesh viewer / print, "here is your tumour"
- 💡 Resident teaching mode: hide findings, ask the resident to assign levels
  and stage, then reveal; case library with teaching points
- 💡 Annotation sharing within the team (de-identified bundles)

## 10. Ask Margin and agents
- ✅ MCP server (17 tools): Claude Code drives Margin
- 📐 In-app Ask Margin panel (Agent SDK), evidence tiles, "sent to Claude"
  disclosure, pixels never leave
- 💡 Question-driven hanging: "show me the carotid" rearranges the view
- 💡 Batch agent over a clinic list; overnight preprocessing
- 💡 Guideline lookup grounded in NCCN/AJCC text with citations (local copy)

## 11. Platform
- ✅ Local only, 127.0.0.1, no telemetry; git repo with no data
- 💡 DICOM SEG / RTSTRUCT / SR export (highdicom, dcmqi, rt-utils)
- 💡 Desktop wrapper (Electron) with a taskbar icon; auto-start of the backend
- 💡 OpenVINO acceleration; model weight manager; offline update bundle
- 💡 Audit log and versioned AI results; reproducibility record per finding
- 💡 Research export: cohort tables, features, outcome tracking
