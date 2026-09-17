# Public head & neck CT datasets for Margin (hnrad)

Reproducible fetchers for **public, PHI-free** head & neck CT data used to
validate the hnrad viewer. Everything here is read-only with respect to the
repo: **no data is ever committed to git** — only these scripts and this README.

All scripts use the backend venv:

```
C:\Users\o948145\hnrad\backend\.venv\Scripts\python.exe
```

Extra packages required beyond the backend's own: `requests`, `truststore`
(install once, user-level, no admin needed):

```powershell
C:\Users\o948145\hnrad\backend\.venv\Scripts\python.exe -m pip install requests truststore
```

### Corporate proxy / TLS interception

The KP network terminates TLS with its own CA. The stock `certifi` bundle
therefore rejects every HTTPS connection. `_common.init_tls()` calls
`truststore.inject_into_ssl()`, which makes Python validate against the
**Windows certificate store** (which does contain the proxy CA). Every script
calls it before any network traffic. `curl.exe` (present on Windows 11) also
works, and is the fallback if `truststore` is ever unavailable.

---

## Layout

| Path | Contents |
|---|---|
| `%LOCALAPPDATA%\HNRad\datasets\HaN-Seg\raw` | HaN-Seg archive + extracted NRRD (CT, MR, per-organ segmentations) |
| `%LOCALAPPDATA%\HNRad\studies\public\HaN-Seg\<case>\CT\` | converted DICOM CT series (what the backend indexes) |
| `%LOCALAPPDATA%\HNRad\studies\public\HaN-Seg\manifest.json` | case → `{ct_series_uid, study_uid, organ_files, verification}` |
| `%LOCALAPPDATA%\HNRad\studies\public\TCIA-<COLLECTION>\<PatientID>\<Modality>_<SeriesNumber>\` | TCIA DICOM (see gating note below) |

Never OneDrive. The data store root is `%LOCALAPPDATA%\HNRad`.

---

## Scripts

| Script | Purpose |
|---|---|
| `_common.py` | TLS init, logging, resumable HTTP download, path helpers |
| `fetch_hanseg.py` | Zenodo REST API → download + verify + extract HaN-Seg |
| `nrrd_to_dicom.py` | HaN-Seg CT NRRD → DICOM CT series + `manifest.json` + geometry verification |
| `fetch_tcia.py` | NBIA REST API v1 → select & download a contrast neck CT subset |

All three are **resumable / idempotent**: a file already present with the right
size (and md5, where Zenodo supplies one) is skipped, a partial download is
continued with an HTTP `Range` request, and an already-converted case is
re-verified rather than re-written (`--force` to overwrite).

---

## A. HaN-Seg — downloaded ✅

**HaN-Seg: The head and neck organ-at-risk CT & MR segmentation dataset**

* Zenodo record **7442914**, version **1.0**, published 2023-01-05
* DOI **10.5281/zenodo.7442914** (concept DOI 10.5281/zenodo.7442913)
* Access: **open** — a plain HTTPS URL, no login, no registration, no
  click-through agreement. Only anonymous `GET`s are performed.
* Size: **one file, `HaN-Seg.zip`, 4 938 848 306 bytes ≈ 4.60 GiB / 4.94 GB**
  (md5 `c3d3070de3034933a63031b73b9cf0fc`). Well under the 25 GB budget, so the
  whole archive is taken — CT, MR and segmentations ship as a single zip and
  the MR is **not** separable at the file level.
* Content: 42 cases, each with a head & neck CT, a T1-weighted MR, and 30
  organ-at-risk segmentations.

### License — ⚠️ CC BY-NC-ND 4.0

**Attribution — NonCommercial — NoDerivatives.** Consequences for this project:

* **Non-commercial use only.**
* **No derivatives may be distributed.** The DICOM series produced by
  `nrrd_to_dicom.py` *is* an adapted form of the dataset, so it must stay on
  this machine — do not redistribute it, do not commit it, do not ship it in a
  release or a demo.
* Therefore HaN-Seg is **validation-only** for Margin: use it to check that the
  viewer renders, measures and reconstructs correctly. Do not use it as
  redistributable sample data, and do not train anything intended for
  commercial use on it.

### Citation

> Podobnik G, Strojan P, Peterlin P, Ibragimov B, Vrtovec T. *HaN-Seg: The head
> and neck organ-at-risk CT and MR segmentation dataset.* Medical Physics.
> 2023;50(3):1917–1927. doi:10.1002/mp.16197
>
> Dataset: Podobnik G, Strojan P, Peterlin P, Ibragimov B, Vrtovec T. *HaN-Seg:
> The head and neck organ-at-risk CT & MR segmentation dataset* (1.0) [Data
> set]. Zenodo. doi:10.5281/zenodo.7442914

### Re-run

```powershell
$py = "C:\Users\o948145\hnrad\backend\.venv\Scripts\python.exe"
& $py C:\Users\o948145\hnrad\tools\datasets\fetch_hanseg.py --dry-run   # list files + sizes only
& $py C:\Users\o948145\hnrad\tools\datasets\fetch_hanseg.py             # download, verify md5, extract
& $py C:\Users\o948145\hnrad\tools\datasets\nrrd_to_dicom.py            # NRRD -> DICOM + manifest + verify
& $py C:\Users\o948145\hnrad\tools\datasets\nrrd_to_dicom.py --verify-only
```

### Conversion details

`nrrd_to_dicom.py` writes, per case, a DICOM CT series with:

| Attribute | Value |
|---|---|
| Modality / SOPClassUID | `CT` / `1.2.840.10008.5.1.4.1.1.2` |
| PixelData | `int16`, BitsAllocated 16, PixelRepresentation 1 |
| RescaleIntercept / Slope | `0` / `1` — stored values **are** Hounsfield units |
| PhotometricInterpretation | `MONOCHROME2` |
| ImageOrientationPatient | from the NRRD direction cosines |
| ImagePositionPatient | per slice, `TransformIndexToPhysicalPoint((0,0,z))` |
| PixelSpacing | `(row, col)` = `(spacing_y, spacing_x)` |
| SliceThickness / SpacingBetweenSlices | `spacing_z` |
| Study / Series / FrameOfReference UID | deterministic per case (re-runs are stable) |
| PatientName / PatientID | `HANSEG^<case>` / `HANSEG_<case>` |
| StudyDescription | `HaN-Seg CT` |

**Why not `ImageSeriesWriter`?** SimpleITK 2.5.6's `ImageSeriesWriter` refuses
DICOM outright:

```
sitk::ERROR: ImageSeriesWriter does not support writing a DICOM series!
```

The supported route — and the one SimpleITK's own *DicomSeriesFromArray*
example uses — is `ImageFileWriter` slice by slice with
`KeepOriginalImageUIDOn()`, which is what the script does. Geometry is then
verified by re-reading the written series with `ImageSeriesReader` **and**
`pydicom`, comparing spacing, origin, direction cosines, HU range and the raw
voxel array against the source NRRD. Results are stored per case under
`verification` in `manifest.json`.

**Segmentations are left alone.** The original NRRD label maps and the
per-organ `*.seg.nrrd` files stay next to the raw data; `manifest.json` lists
them per case under `organ_files`. Converting contours to DICOM RTSTRUCT is a
later task.

---

## B. TCIA HNSCC / Head-Neck-PET-CT — ⛔ GATED, NOT DOWNLOADED

`fetch_tcia.py` probes the **unrestricted** NBIA REST API v1
(`https://services.cancerimagingarchive.net/nbia-api/services/v1/`). That API
needs no token and it works fine here — `getCollectionValues` returns 156
collections. **Neither requested collection is among them**, and
`getPatient?Collection=HNSCC` / `getSeries?Collection=HNSCC` return HTTP 200
with a **zero-length body**. Same for `Head-Neck-PET-CT`. (`.../services/v2/`,
the token-authenticated surface, returns HTTP 500 without credentials.)

Both collections are governed by the **NIH Controlled Data Access Policy**.
The collection pages
(<https://www.cancerimagingarchive.net/collection/hnscc/> and
<https://www.cancerimagingarchive.net/collection/head-neck-pet-ct/>) state:

> "Some data in this collection contains images that could potentially be used
> to reconstruct a human face. The process for requesting access to these is
> outlined in the NIH Controlled Data Access Policy page."

That process (<https://www.cancerimagingarchive.net/nih-controlled-data-access-policy/>)
requires **all** of the following — every one of which needs a human, an
account, and an explicit agreement, so the scripts stop rather than attempt it:

1. A **dbGaP data-access request** at
   <https://dbgap.ncbi.nlm.nih.gov/aa/wga.cgi?page=login> (PHS accession
   **phs004225** covers the TCIA "face" datasets). The requester must hold a
   position *"equivalent to a tenure-track professor, or senior scientist"*;
   graduate students and postdocs cannot submit independently.
2. An **NCI Data Commons Framework Services login**, then Profile → create an
   **API key**, saved as a JSON credential file.
3. A per-collection **manifest** from TCIA's Browse Collections page.
4. The **NBIA Data Retriever** desktop client, pointed at that JSON key.

`fetch_tcia.py` detects this and exits with code **3** after printing the above,
having downloaded nothing.

### Once access is granted

The selection logic is already implemented and was dry-run-tested against the
live API. Point the script at the authenticated v2 API and it will: list
patients → list series per patient → score each CT on `SeriesDescription` /
`ProtocolName` / `BodyPartExamined` for **NECK** and **contrast** keywords,
`ImageCount >= 100` and `SliceThickness` in 1–3 mm → prefer studies that also
carry an **RTSTRUCT** and/or **PT** series → take the top 10 patients under a
15 GB cap → download each series zip via `getImage?SeriesInstanceUID=` and
unzip it into
`%LOCALAPPDATA%\HNRad\studies\public\TCIA-<COLLECTION>\<PatientID>\<Modality>_<SeriesNumber>\`.

```powershell
& $py C:\Users\o948145\hnrad\tools\datasets\fetch_tcia.py --dry-run   # selection table only
& $py C:\Users\o948145\hnrad\tools\datasets\fetch_tcia.py --max-patients 10 --max-gb 15
```

### If you want an open alternative

`ACRIN-HNSCC-FDG-PET-CT` **is** in the unrestricted list (confirmed: 
`getPatient` returns real patients over the anonymous v1 API) and is head &
neck squamous cell carcinoma PET/CT. It was **not** downloaded because the
authorization covered only HNSCC and Head-Neck-PET-CT. If you want it, say so
and run:

```powershell
& $py C:\Users\o948145\hnrad\tools\datasets\fetch_tcia.py --collection ACRIN-HNSCC-FDG-PET-CT --fallback ""
```

Its own license and citation requirements must be reviewed on
<https://www.cancerimagingarchive.net/collection/acrin-hnscc-fdg-pet-ct/>
before use.

### TCIA citation (required for any TCIA data)

> Clark K, Vendt B, Smith K, et al. *The Cancer Imaging Archive (TCIA):
> Maintaining and Operating a Public Information Repository.* Journal of Digital
> Imaging. 2013;26(6):1045–1057. doi:10.1007/s10278-013-9622-7

Plus the per-collection DOI shown on that collection's TCIA page, per the
[TCIA Data Usage Policy](https://www.cancerimagingarchive.net/data-usage-policies-and-restrictions/).

---

## C. Importing into hnrad

With the backend running on `127.0.0.1:8765`:

```powershell
curl.exe -s -X POST http://127.0.0.1:8765/api/import `
  -H "Content-Type: application/json" `
  -d "{\"path\": \"$env:LOCALAPPDATA\\HNRad\\studies\\public\"}"

curl.exe -s http://127.0.0.1:8765/api/studies
```

Import is idempotent (keyed on SOPInstanceUID) and indexes folders **in place** —
nothing is copied.

---

## D. Run of record — 2026-09-17

| | |
|---|---|
| HaN-Seg archive | 4 938 848 306 B (4.60 GiB) downloaded, **md5 verified**, 1347 files extracted |
| Cases converted | **42 / 42**, geometry verification **42 OK, 0 FAILED** |
| DICOM written | **7 581 slices, 14 GB** under `studies\public\HaN-Seg` |
| Per case | 1024x1024, 189-205 slices, in-plane 0.5576-0.6826 mm, 2.0 mm slices, HU -1000...3000 |
| OAR files kept as NRRD | 30 per case (one case has 29), untouched next to the raw data |
| `POST /api/import` | `{"patients":42,"studies":42,"series":42,"instances":7581,"skipped":1,"seconds":24.7}` (the 1 skip is `manifest.json`) |
| `GET /api/studies` | 42 `HANSEG_*` studies, all `modalities:["CT"]`; every CT series reports `is_3d: true` |
| Thumbnail | `thumb_hanseg.png` - 128x128 PNG, renders as a real axial neck CT (soft tissue, vertebral body, RT immobilization board) |
| Disk | 264 GB still free |
| TCIA | **nothing downloaded** - gated, see section B. `thumb_tcia.png` therefore does not exist. |

Verification compares, per case, the written DICOM series re-read with both
`SimpleITK.ImageSeriesReader` and `pydicom` against the source NRRD: spacing,
origin, direction cosines, HU min/max, the raw voxel array
(`pixels_identical`), a single SeriesInstanceUID, unique SOPInstanceUIDs, a
consistent FrameOfReferenceUID, and the required header values. All of it is
stored per case under `cases.<case>.verification` in `manifest.json`.

Re-running `nrrd_to_dicom.py` re-verifies without rewriting; re-running
`POST /api/import` returns the identical counts.

### ⚠️ Do not commit `thumb_hanseg.png`

`thumb_hanseg.png` is a rendering of HaN-Seg pixel data, i.e. a **derivative**
of a **CC BY-NC-ND 4.0** work. Committing it to git would redistribute a
derivative and breach the NoDerivatives term. It is written here only as
evidence for this run; add it to `.gitignore` or delete it before committing.
Commit the four `.py` files and this `README.md` only.
