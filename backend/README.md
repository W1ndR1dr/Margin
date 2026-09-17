# HNRad backend

Local-only FastAPI service behind the HNRad viewer. It indexes DICOM folders
into SQLite, serves the original Part-10 bytes to Cornerstone3D, and does the
numeric work (thumbnails, ROI statistics, marching-cubes STL export).

Nothing leaves the machine: uvicorn binds `127.0.0.1` only, and the data store
lives outside OneDrive.

## Layout

| File | Role |
| --- | --- |
| `hnrad/config.py` | Paths and constants. Honours `HNRAD_DATA_ROOT`, `HNRAD_STUDIES_ROOT`, `HNRAD_DB_PATH`. |
| `hnrad/db.py` | SQLite schema (WAL), upserts and the listing queries. |
| `hnrad/indexer.py` | Recursive walk, cheap DICOM probe, header-only parse, idempotent upsert, slice geometry. |
| `hnrad/analysis.py` | Series volume loading + LRU cache, thumbnails, marching cubes -> binary STL, ROI statistics. |
| `hnrad/app.py` | FastAPI routes, CORS, stderr logging with timings. |
| `hnrad/phantom.py` | Synthetic neck CT generator (owned elsewhere). |

## Data store

```
%LOCALAPPDATA%\HNRad\studies\        default import root, indexed in place
%LOCALAPPDATA%\HNRad\db\hnrad.sqlite SQLite index (WAL)
```

Files are indexed **in place** — importing never copies or moves DICOM data.
The database stores absolute `file_path` values, which is also why path
traversal is impossible on `/api/instances/{sop_uid}`: the path never comes from
the request.

## Running

```powershell
.\run.ps1                 # 127.0.0.1:8765, auto-reload
.\run.ps1 -NoReload       # single process, no watcher
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/api/health
```

Interactive API docs: <http://127.0.0.1:8765/api/docs>

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

The suite builds its own 6-slice 32x32 CT series with pydicom in a temporary
directory (it does not depend on `phantom.py`), points the service at an
isolated data store via the `HNRAD_*` environment variables, and then exercises
the whole API surface.

## Implementation notes

**Indexing.** Every file under the import root is visited. A name check drops
obvious non-DICOM extensions and `DICOMDIR`; what survives gets a 132-byte magic
probe (`DICM` at offset 128, or a leading group 0x0002/0x0008 tag for
preamble-less files) before pydicom is asked to parse anything. Parsing is
`dcmread(stop_before_pixels=True, force=True)`. Files with no extension are
handled the same as any other. Missing tags become `NULL`; a file with no
SOPInstanceUID gets a UID synthesised from a hash of its path so nothing is
silently lost. Re-importing is idempotent — SOPInstanceUID is the primary key
and the upserts keep existing non-NULL values.

**Slice ordering.** `slice_pos = dot(IPP, normal)` where
`normal = rowDir x colDir` from ImageOrientationPatient. When orientation is
missing the InstanceNumber is used instead.

**Volumes.** `analysis.load_series_volume` stacks a series into one
`float32` `(nz, ny, nx)` HU array sorted by `slice_pos`, deriving `dz` from the
actual slice positions (median spacing) and falling back to
SpacingBetweenSlices / SliceThickness. An LRU cache holds two series, so
repeated analysis calls on the same series do not re-read the files.

**Isosurface.** `skimage.measure.marching_cubes` runs with
`spacing=(dz, dy, dx)` — note the axis order — so vertex columns come back as
`(z_mm, row_mm, col_mm)`. With no `upper_hu` the threshold is applied directly
to the HU field (smoother); with an upper bound a binary band mask is meshed at
level 0.5. Optional uniform Laplacian smoothing averages each vertex with its
1-ring neighbours. Vertices are then mapped to patient LPS millimetres:

```
P = IPP(first slice) + rowDir * col_mm + colDir * row_mm + sliceDir * z_mm
```

and written as a binary STL: 80-byte header, `uint32` triangle count, then
50-byte records (normal + three vertices as `float32`, plus a `uint16`
attribute word).

**ROI statistics.** The polygon (`[[col, row], ...]`, pixel coordinates) is
rasterised with `skimage.draw.polygon` against that instance's HU array;
`area_mm2 = n_voxels * row_spacing * col_spacing`.

**Errors.** `{"detail": "..."}` with 404 for unknown UIDs or paths and 400 for
bad analysis input; FastAPI's own 422 covers malformed request bodies.
