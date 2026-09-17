# HNRad

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

## Privacy

Both servers bind to 127.0.0.1 only. No data leaves the device. Do not place patient
data in OneDrive-synced folders or in this git repository.
