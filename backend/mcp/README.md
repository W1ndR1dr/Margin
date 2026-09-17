# Margin MCP server

Lets Claude (Claude Code or Claude Desktop) drive the local Margin / HNRad
backend: browse the DICOM library, segment, measure, profile the airway and
export STLs — all over stdio to a process on this machine, which in turn talks
HTTP to `http://127.0.0.1:8765`. **No pixel data and no PHI ever leaves the
box**; the MCP server makes no outbound network calls of any kind.

Roadmap item 16 ("Margin MCP server: Claude drives segment / measure / report").

```
Claude  <--stdio/MCP-->  hnrad.mcp_server  <--HTTP-->  FastAPI backend (127.0.0.1:8765)
                                                             |
                                                       SQLite index + DICOM
                                                       (%LOCALAPPDATA%\HNRad)
```

## Prerequisites

1. The backend is running:

   ```powershell
   C:\Users\o948145\hnrad\backend\run.ps1
   # sanity check
   curl.exe http://127.0.0.1:8765/api/health
   ```

2. The venv has the MCP SDK (already installed):

   ```powershell
   C:\Users\o948145\hnrad\backend\.venv\Scripts\python.exe -m pip install mcp httpx
   ```

   Built against `mcp` 2.2.0, where the old `FastMCP` class is called
   `MCPServer` (`from mcp.server.mcpserver import MCPServer`). Code written for
   `mcp<2` will not import.

## Register with Claude Code

Run this once, from anywhere. `PYTHONPATH` is what makes `hnrad` importable no
matter which directory Claude happens to launch the server from:

```powershell
claude mcp add margin --scope user `
  --env PYTHONPATH=C:\Users\o948145\hnrad\backend `
  --env MARGIN_API=http://127.0.0.1:8765 `
  -- C:\Users\o948145\hnrad\backend\.venv\Scripts\python.exe -m hnrad.mcp_server
```

One line, for pasting into cmd or a non-PowerShell shell:

```
claude mcp add margin --scope user --env PYTHONPATH=C:\Users\o948145\hnrad\backend --env MARGIN_API=http://127.0.0.1:8765 -- C:\Users\o948145\hnrad\backend\.venv\Scripts\python.exe -m hnrad.mcp_server
```

Via the PowerShell launcher instead (it sets the working directory and the env
vars itself — use this if you prefer one entry point, and note it needs script
execution to be permitted):

```powershell
claude mcp add margin --scope user -- powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\o948145\hnrad\backend\mcp\run-mcp.ps1
```

Check it, then restart the session:

```powershell
claude mcp list
claude mcp get margin
# inside Claude Code:  /mcp
```

Remove it with `claude mcp remove margin --scope user`.

## Register with Claude Desktop

Merge `mcpServers` from [`claude_desktop_config.json`](./claude_desktop_config.json)
in this folder into `%APPDATA%\Claude\claude_desktop_config.json` and restart
Claude Desktop:

```json
{
  "mcpServers": {
    "margin": {
      "command": "C:\\Users\\o948145\\hnrad\\backend\\.venv\\Scripts\\python.exe",
      "args": ["-m", "hnrad.mcp_server"],
      "cwd": "C:\\Users\\o948145\\hnrad\\backend",
      "env": {
        "MARGIN_API": "http://127.0.0.1:8765",
        "MARGIN_MCP_LOG": "INFO",
        "PYTHONUNBUFFERED": "1"
      }
    }
  }
}
```

## Example prompts

Things a head & neck surgeon can actually type once the server is connected:

1. **"Profile the airway on the phantom and tell me the Myer–Cotton grade."**
   → `list_studies` → `list_series` → `airway_profile(seed_ijk=[256,195,20],
   glottis_slice=66)` → reads back the `narrative` and the 12-point CSA table.
2. **"What studies do I have locally, and how many slices is the neck CT?"**
   → `list_studies`, `list_series`, `get_series` (summarised geometry, no
   180-instance dump).
3. **"Segment the bone on that series and give me the volume, then export an STL
   I can send to the printer."** → `threshold(300, 3000)` → `export_label_stl`
   into `%LOCALAPPDATA%\HNRad\exports`.
4. **"Grow the airway lumen from ijk 256,195,20 and tell me how close it gets to
   the tumour I segmented."** → `region_grow(-1024, -400)` +
   `label_distance(label_a, label_b)` — a negative distance means the two
   overlap, i.e. contact/invasion.
5. **"Draw an ROI over the necrotic node on slice 92 and give me mean HU."**
   → `get_series(include_instances=true)` for the SOP UID → `roi_stats` with the
   polygon in `[col, row]` pixel coordinates.

Two more that exercise the AI routes once the parallel `/api/ai/*` work lands:
*"Which AI segmentation models can Margin run?"* (`ai_models`) and *"Run
TotalSegmentator on this series, trachea and thyroid only, and tell me when it's
done"* (`ai_segment` → `ai_job`).

## Tools

| Tool | What it does |
| --- | --- |
| `health` | Backend status, version, index path, studies root |
| `list_patients` | Patients in the local index |
| `list_studies` | Studies, optionally filtered by `patient_id` |
| `list_series` | Series of one study (`is_3d` marks what can be analysed) |
| `get_series` | Geometry + counts + first/last slice_pos; `include_instances=true` for the full per-slice list |
| `import_folder` | Index a folder of DICOM in place (idempotent) |
| `region_grow` | Seeded 3D grow inside an HU band → LabelStats |
| `threshold` | Global HU band, optionally inside the body mask → LabelStats |
| `label_stats` | Re-read a label's statistics |
| `label_distance` | Min 3D distance between two labels (negative = overlap) |
| `delete_label` | Drop a label from the in-memory store |
| `export_label_stl` | Binary STL into the exports folder; returns path + triangle count |
| `airway_profile` | Centreline, CSA, stenosis %, Myer–Cotton grade + `narrative` |
| `roi_stats` | HU statistics inside a polygon on one slice |
| `ai_models` / `ai_segment` / `ai_job` | Local AI segmentation (`/api/ai/*`) |

Resources: `margin://studies` (all studies as JSON) and `margin://contract`
(the full `CONTRACT.md`, so the model can look up conventions itself).

### Conventions the tools use

* **HU** everywhere for intensity; volumes in **mL**, areas **mm²**, lengths **mm**.
* `ijk` = `[column, row, slice]`; **k = 0 is the most inferior slice**, ordered
  by `slice_pos` exactly as `get_series` returns.
* `*_lps` are patient **LPS millimetres** (+x Left, +y Posterior, +z Superior).
* Labels live in RAM on the backend in an LRU of 20 and **do not survive a
  backend restart** — `run.ps1` uses `--reload`, so editing a backend file
  invalidates every `label_id`. A 404 just means "re-run the segmentation".

### Output size

Every tool returns compact JSON and no array longer than ~50 items unless you
ask for it. `get_series` hides the instance list behind `include_instances`, and
`airway_profile` replaces the six 180-sample arrays with min/max spans, a
12-point CSA-vs-arclength table and a paste-ready sentence such as:

> Minimum cross-sectional area 50.9 mm² (equivalent diameter 8.1 mm) at 6 mm
> below the glottis; 81% area reduction over 12 mm; Myer–Cotton grade III

### Safety rails

* `export_label_stl` refuses any path outside `%LOCALAPPDATA%\HNRad\exports`
  (a bare filename like `airway.stl` is the easy path), and refuses before it
  makes the HTTP call.
* Backend errors become readable strings that keep FastAPI's `detail`, e.g.
  `POST /api/analysis/threshold failed: HTTP 404 -- unknown series_uid 1.2.3`.
* Timeouts: 15 s metadata, 30 s analysis, 120 s airway and import.
* `/api/ai/*` returning 404 becomes "AI routes not available in this backend
  version" rather than a confusing HTTP error.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `MARGIN_API` | `http://127.0.0.1:8765` | Backend base URL |
| `MARGIN_MCP_LOG` | `INFO` | Log level (stderr only — stdout is the MCP channel) |
| `HNRAD_DATA_ROOT` | `%LOCALAPPDATA%\HNRad` | Parent of the `exports` folder |
| `HNRAD_CONTRACT` | `<repo>\CONTRACT.md` | Source of the `margin://contract` resource |

## Troubleshooting

* **"Cannot reach the Margin backend"** — start `backend\run.ps1` and check
  `GET /api/health`.
* **`ModuleNotFoundError: No module named 'hnrad'`** — the launcher's working
  directory is not `backend\`; set `PYTHONPATH` as in the command above.
* **Server connects but lists no tools** — check the stderr log; under stdio
  nothing may print to stdout, so a stray `print()` in a backend import would
  corrupt the protocol.
* **Every `label_id` 404s** — the backend reloaded. Re-run the segmentation.

## Tests

```powershell
# from the repo root
C:\Users\o948145\hnrad\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_mcp.py

# or, like the rest of the suite, from backend\
cd C:\Users\o948145\hnrad\backend
.\.venv\Scripts\python.exe -m pytest -q          # whole suite
.\.venv\Scripts\python.exe -m pytest -q tests/test_mcp.py -s   # -s shows the live output
```

`tests/test_mcp.py` mocks the backend with `httpx.MockTransport` for the unit
tests and additionally runs a live smoke test (studies → bone threshold →
airway profile) when a backend answers on `MARGIN_API`; those live tests skip
themselves when it does not.
