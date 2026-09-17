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
8. [ ] Airway analyzer (centerline, min CSA, stenosis %, fly-through)         — v0.3
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
