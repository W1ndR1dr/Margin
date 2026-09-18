# Margin (code name HNRad)

Local-only radiology assistant for head and neck cancer surgery. Imports DICOM from
PACS exports, CDs or folders, keeps everything on this machine, and gives you a fast
MPR + 3D viewer with head-and-neck-specific surgical planning tools.

See ROADMAP.md for the clinical brainstorm and feature priorities, CONTRACT.md for the
architecture and API.

## Run

Backend (FastAPI on 127.0.0.1:8765):

```powershell
C:\Users\o948145\hnrad\backend\run.ps1
```

Frontend (Vite dev server on 127.0.0.1:5173):

```powershell
Set-Location C:\Users\o948145\hnrad\frontend; npm run dev
```

Then open http://127.0.0.1:5173.

## Data

- Put DICOM folders under `%LOCALAPPDATA%\HNRad\studies\` and click **Import** in the app
  (or POST /api/import with any other local path). Files are indexed in place.
- Index database: `%LOCALAPPDATA%\HNRad\db\hnrad.sqlite`.
- Synthetic test scan (no PHI):

```powershell
Set-Location C:\Users\o948145\hnrad\backend; .venv\Scripts\python.exe -m hnrad.phantom --out "$env:LOCALAPPDATA\HNRad\studies\PHANTOM_NECK"
```

## Interface

The v2 shell (UI-OVERHAUL.md) lives in `frontend/src`:

- `src/ui/` is the design system — Button, Toggle, Segmented, Slider, Tabs, Chip,
  Pill, Tile, Drawer, Modal, Palette, Toast, Tooltip, Scrubber, Field, MarginMark.
  Every control in the app comes from here; there are no native browser controls.
- `src/styles/tokens.css` is the only place colours, type and geometry are defined.

### Icons

Icons are **Phosphor** (MIT) and **Health Icons** (CC0), bundled offline. The app
never fetches an icon: `npm run icons` reads `frontend/scripts/icon-manifest.mjs`
and writes `src/ui/iconData.ts` with just the glyphs Margin uses (~110 of
Phosphor's 9161), inlined. `npm run build` runs it first. To add an icon, add a
name to the manifest and re-run.

### Fonts — the one external request

`index.html` links Instrument Sans and JetBrains Mono from Google Fonts. This is
the **only** network request Margin makes and it happens at page load, not at
runtime. It is to be self-hosted under `frontend/public/fonts/` before v1 so the
app is fully offline; everything else already is.

## Verifying the UI

Never screenshot the desktop (CLAUDE.md). Two sanctioned ways to look at the
interface, both against `127.0.0.1:5173`:

```powershell
# the app's own browser tab, or:
npm install --no-save puppeteer-core@23      # once, dev only
node tools/capture_ui.mjs                    # phantom screens -> tools/ui_v2_*.png
node tools/capture_ui.mjs --hanseg           # plus the HaN-Seg CT and MR
```

`capture_ui.mjs` drives the running dev server with the system Chrome: it opens a
series, segments, runs the carotid tool for real and writes app-only PNGs.
Anything derived from HaN-Seg pixels is written with `hanseg` in the filename,
which `.gitignore` excludes (CC BY-NC-ND, NoDerivatives).

In development `window.__margin` exposes the store, the viewer and the tools for
the console and for that script. It is stripped from production builds.

## Privacy

Both servers bind to 127.0.0.1 only. No data leaves the device. Do not place patient
data in OneDrive-synced folders or in this git repository.
