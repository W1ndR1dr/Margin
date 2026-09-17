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

## Segmentation, volumetrics and the airway analyser (v0.2)

Two new modules sit on top of `analysis.load_series_volume`, so every call
reuses the same cached HU volume:

| File | Role |
| --- | --- |
| `hnrad/segmentation.py` | Label store, region grow, HU threshold + body mask, volumetrics, STL / raw-mask export, label-to-label distance. |
| `hnrad/airway.py` | Airway lumen, centreline, perpendicular cross-section profile, stenosis metrics and the Myer-Cotton grade. |

The routes are documented verbatim in `CONTRACT.md` under **Analysis API
v0.2**; what follows is how they work.

**Index conventions.** `ijk` is `(i = column, j = row, k = slice)`; the numpy
arrays are `(k, j, i)`. Everything numeric happens in a *local frame* where
`x = i·dx`, `y = j·dy`, `z = k·dz`, which maps to patient LPS with the same
expression the isosurface exporter uses:

```
P = origin + x·row_dir + y·col_dir + z·slice_dir
```

`row_dir` / `col_dir` / `slice_dir` are orthonormal for any regular axial or
oblique series, so distances and areas are identical in both frames and only
the reported points need converting. The inverse (for `seed_lps`) is a
least-squares solve against the same basis.

**Label store.** `segmentation.LABELS` is an `OrderedDict` LRU of at most 20
`Label` records (`series_uid`, the `uint8` mask, and the stats + request that
made it), guarded by a lock and keyed by uuid4. It is process memory: a
backend restart — including an auto-reload — empties it, which is why every
label route answers 404 rather than resurrecting anything.

**Region grow.** `SimpleITK ConnectedThreshold` with face (6-) connectivity.
The candidate set is computed in numpy first — the HU band, intersected with
the `max_radius_mm` sphere and with any restriction mask — and everything
afterwards runs inside *that set's bounding box*. On the 512x512x180 phantom
this is the difference between 8 s and 1 s: ConnectedThreshold, the closing and
the largest-component pass all see a few million voxels instead of 47 million.
Voxels outside the candidate set are replaced with `lower_hu - 10000` so the
grow physically cannot walk through them.

**Body mask.** The largest 6-connected component of `HU > -500`, then
`binary_fill_holes` **slice by slice**. The per-slice fill is the point: the
airway column is open at the top and bottom of the scan, so a 3D fill would
leave the lumen outside the body and `inside_body` would then throw the airway
away along with the room air. Cached per series (LRU of 2) because it costs
~1.5 s on a 512x512x180 series and both `/threshold` and `/airway` want it.

**Volumetrics.** `volume_ml = n_voxels · dx·dy·dz / 1000`. `diameters_mm` are
the PCA extents (eigenvectors of the covariance of the voxel centres, the span
of the projection along each, plus one voxel width measured along that same
direction so a single voxel is voxel-sized rather than zero), largest first.
`longest_axis_mm` is the true maximum caliper diameter: the convex hull of the
voxel cloud, then the widest vertex pair (both subsampled if the label is
large).

**Mask export.** gzip of the raw `(z, y, x)` `uint8` bytes with the geometry in
`X-Shape` / `X-Spacing` / `X-Origin` / `X-Direction`. `Content-Encoding` is
deliberately *not* gzip, so nothing in the chain silently decompresses the body
and the frontend gets exactly the bytes it asked for. Note that only
`Content-Disposition` is in the CORS `expose_headers` list — that is harmless
today because the browser reaches the backend through the Vite proxy
(same-origin), but a direct cross-origin fetch would not see the `X-*` headers.

**Distance.** `SignedMaurerDistanceMap` of label B (`useImageSpacing`, inside
negative) sampled at label A's surface voxels gives the minimum; the reported
point on B is the nearest B-surface voxel to that point on A. Overlapping
labels report a negative distance.

**Airway.** Lumen grow inside the body mask, then a slice-wise centroid walk
away from the seed — taking the component that contains the previous centroid,
else the nearest one, stopping on a jump over 20 mm — smoothed with a 2 mm
Gaussian along z. The walk runs inside the lumen's bounding box, which is what
keeps it under 0.2 s instead of 3 s. At each sample a 60x60 mm patch is
resampled at 0.3 mm perpendicular to the tangent (`ResampleImageFilter` with a
direction matrix built from the tangent and two vectors spanning its normal
plane), the component containing the centre pixel is kept, and its area and PCA
diameters are recorded. Reference CSA, stenosis percentage and length, distance
from the glottis and the Myer-Cotton grade follow TOOLS-SPEC section 4.

Timings on the synthetic 512x512x180 neck phantom (0.45 x 0.45 x 1.0 mm),
logged at INFO on stderr:

```
body mask 1.4-2.0 s (cached)   lumen grow 1.0-1.3 s
centreline 0.1 s               180 perpendicular sections 1.4 s
POST /api/analysis/airway      ~5.8 s cold, ~2.1-2.8 s warm
POST /api/analysis/region-grow 0.2-0.5 s (40 mm cap)
POST /api/analysis/threshold   0.4 s (bone) - 3 s (all air, no body mask)
GET  .../mesh                  1.2 s, 70k triangles for the airway cast
GET  .../mask                  0.2 s, 47 MB -> 61 kB gzip
```

### Tests

`tests/test_segmentation.py` and `tests/test_airway.py` own a purpose-made
64 x 64 x 40 DICOM series (a 21 mm soft-tissue cylinder, two bright spheres of
radius 5 mm and 4 mm with centres 18 mm apart, and a 6 mm air tube narrowing to
2.5 mm over slices 18-21) written into **its own data store**. The `HNRAD_*`
environment variables are re-pointed per test with `monkeypatch`, so this store
and the one in `conftest.py` never see each other whatever order pytest picks.

Every number is checked against the analytic value: the region-grown sphere
volume to within 5 %, the body-masked air threshold against the integral of the
tube, the sphere-to-sphere distance against `18 - 5 - 4 = 9 mm` to within a
voxel, and the airway stenosis against `1 - (2.5/6)^2 = 82.6 %` to within 8
points with the minimum at the right slice.
