# Margin — rules for every agent working in this repo

- NEVER capture the desktop or the primary screen (no mcp__computer-use screenshots,
  no full-screen captures). Brian's screen may show patient data (Teams tumour board,
  Epic, PACS). Verify UI only via the app's own browser tab (built-in browser pane or
  headless Chrome pointed at 127.0.0.1:5173) and save only those renders.
- Patient data and licensed datasets (HaN-Seg CC BY-NC-ND, HECKTOR) never enter git:
  no DICOM, no NIfTI/NRRD, no thumbnails or overlays derived from them. Phantom output is fine.
- Both servers bind 127.0.0.1 only. No telemetry, no CDN at runtime.
- Do not git commit from subagents; the orchestrator commits.
