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

### MR T1 conversion (added 2026-09-17)

`nrrd_to_dicom.py` also converts each case's `*_IMG_MR_T1.nrrd` into a DICOM MR
series under `...\public\HaN-Seg\<case>\MR\`:

| Attribute | Value |
|---|---|
| Modality / SOPClassUID | `MR` / `1.2.840.10008.5.1.4.1.1.4` |
| SeriesDescription | `HaN-Seg MR T1` |
| SeriesNumber | `2` (the CT is `1`) |
| StudyInstanceUID | **the same UID as the case's CT** — one study, two series |
| FrameOfReferenceUID | **its own**, deterministically derived; *not* the CT's — see below |
| PixelData | `uint16` when the volume is non-negative and fits (all 42 cases), `int16` when it is signed and fits, otherwise `uint16` with `RescaleIntercept = floor(min)` |
| RescaleIntercept / Slope | `0` / `1` for all 42 cases, so stored values **are** the NRRD values |
| PhotometricInterpretation | `MONOCHROME2` |
| ScanningSequence / SequenceVariant | `RM` (research mode) / `NONE` |
| MRAcquisitionType | `2D` |
| TE / TR / TI / flip angle / field strength | **absent** |
| Geometry | identical rules to the CT (IOP from the direction cosines, per-slice IPP, PixelSpacing `(dy, dx)`, SliceThickness and SpacingBetweenSlices = `spacing_z`) |

**Why no TE/TR.** HaN-Seg ships NRRD, which carries no MR acquisition
metadata at all. `ScanningSequence` and `SequenceVariant` are Type 1 in the MR
Image module and must have *some* value, so they get `RM` / `NONE`, which is
the honest "not a named sequence". Everything that is genuinely unknown is left
absent rather than invented. The backend's `sequence_kind` still resolves to
`T1` — from the SeriesDescription, which is the one thing the dataset does tell
us.

**GDCM overwrites SpacingBetweenSlices.** SimpleITK's `ImageFileWriter` uses
GDCM, and GDCM writes `(0018,0088)` itself for an *MR Image* SOP instance —
`1` for a 2D slice, silently discarding the value in the metadata dictionary.
`SliceThickness` survives, so the discrepancy is easy to miss: the volume
geometry the backend derives from `ImagePositionPatient` stays right, but
`is_thick` and any client reading `(0018,0088)` are wrong.
`fix_mr_spacing()` patches it back with pydicom after the write, and
`verify_mr()` now asserts both tags equal `spacing_z`. The CT path is not
affected.

#### The MR is *not* in the CT frame of reference — measured, not assumed

The HaN-Seg paper describes CT and T1 MR acquired for one radiotherapy planning
episode, which makes it tempting to give both series the same
`FrameOfReferenceUID`. `mr_alignment()` checks instead of assuming: it maps
every voxel of the CT-space OAR contours (mandible, brainstem, both parotids)
into the MR grid under the **identity** transform and counts how many land
inside the MR field of view. The per-case result is stored in `manifest.json`
under `mr_alignment`.

Across all 42 cases:

| contour voxels inside the MR FOV under identity | cases |
|---|---|
| < 0.1 % | 22 |
| 0.1 – 50 % | 3 |
| 50 – 90 % | 10 |
| 90 – 100 % | 7 |

mean 36.1 %, median 0 %. The stored origins differ by up to **1096 mm in z**
(case_02), and 10 cases have literally zero bounding-box overlap in z. So the
released NRRD volumes are in their original, unregistered scanner coordinates,
and **every** MR series is written with its own `FrameOfReferenceUID`.

High containment does not mean alignment, either — it only means the MR's
bounding box happens to contain the contours. Registering CT to MR with
`POST /api/registration` (rigid, 2 mm, no mask) moves the MR by **111–606 mm**
even on the cases with 90–100 % containment. Three worked examples, with the
fraction of each CT-space contour that falls on MR tissue before and after:

| case | wall | translation | rotation | NMI | head-outline Dice | brainstem | parotid L / R | mandible |
|---|---|---|---|---|---|---|---|---|
| case_01 | 34.3 s | 606.1 mm | 0.55° | n/a → 1.206 | n/a → 0.833 | 0 → 100 % | 0 → 99.7 / 99.7 % | 0 → 44.7 % |
| case_30 | 21.6 s | 113.2 mm | 1.64° | 1.022 → 1.171 | 0.339 → 0.815 | 0 → 97.8 % | 22.4 → 97.8 % / 0.3 → 98.7 % | 53.9 → 62.1 % |
| case_12 | 22.6 s | 111.0 mm | 0.30° | 1.008 → 1.180 | 0.244 → 0.687 | 0 → 97.2 % | 4.2 → 99.4 % / 0.6 → 99.5 % | 36.6 → 33.6 % |

(`n/a` where the two series do not overlap at all under their stored geometry,
so "before" is undefined.) The mandible stays low on purpose: cortical bone is
a signal void on T1, so "falls on MR tissue" undercounts it by construction,
and the mandible body extends below the inferior edge of the MR field of view.

**Mask choice matters more than the mode.** On case_01, `mask: "body"` gave
NMI 1.205 / Dice 0.933 but on case_12 the same setting converged to a
100 mm superior slip (NMI 1.018, brainstem coverage 0 %), while `mask: null`
succeeded on all three. Use `mask: null` for CT↔MR, keep `bone` for CT↔CT, and
read `quality.nmi_after` every time — 1.17–1.21 is a good fit here and 1.02 is
a failed one, with no other externally visible difference.

#### MR re-run

```powershell
$py = "C:\Users\o948145\hnrad\backend\.venv\Scripts\python.exe"
& $py tools\datasets\nrrd_to_dicom.py --modality mr              # convert + verify + measure
& $py tools\datasets\nrrd_to_dicom.py --modality mr --verify-only
& $py tools\datasets\nrrd_to_dicom.py --modality both --force    # rewrite everything
& $py tools\datasets\nrrd_to_dicom.py --modality mr --no-alignment
```

Run of record (2026-09-17): 42/42 MR series written and verified OK, 3613
slices, pixels bit-identical to the source NRRD in every case, all with
`RescaleIntercept 0 / Slope 1`. `POST /api/import` over
`...\studies\public\HaN-Seg` then reports 42 patients / 42 studies / **84
series** / 11 194 instances, and `GET /api/studies` shows all 42 studies with
modalities `["CT", "MR"]`, each MR classified `sequence_kind: "T1"`,
`acquired_plane: "AX"`, `is_thick: true` for the 32 cases at 3–6 mm and
`false` for the 10 at 1.7 mm.

#### ⚠️ Do not commit `thumb_hanseg_mr.png`

`tools/datasets/thumb_hanseg_mr.png` is a 7x4 montage of the first 28 MR
thumbnails straight out of `GET /api/series/{uid}/thumbnail`, kept as local
evidence that the modality-aware window works (a fixed W350/L40 renders every
one of them black). It renders HaN-Seg pixel data, so the `NoDerivatives`
clause applies exactly as it does to `thumb_hanseg.png`. `.gitignore` already
covers it via `tools/datasets/thumb_*.png`.

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

---

## B2. ACRIN-HNSCC-FDG-PET-CT — ⛔ ALSO GATED (images), NOT DOWNLOADED

This collection **is** listed by `getCollectionValues` and `getPatient` returns
**258 real patients** over the anonymous v1 API — so it initially looks like an
open alternative. **It is not.** A full scan of all 258 patients (run
2026-09-17) gives this modality census:

```
Modality census across 258 patients: {'RTSTRUCT': 2085}
```

**Zero CT. Zero PT.** 2085 RTSTRUCT series totalling ~36.5 MB is the entire
public surface. Only the derived contour objects are public; the FDG-PET and CT
images they were drawn on are withheld.

Asking for a referenced image series directly by its UID — the UID read out of
a public RTSTRUCT's `RTReferencedSeriesSequence` — is refused verbatim:

```
GET .../v1/getImage?SeriesInstanceUID=1.3.6.1.4.1.14519.5.2.1.7009.2405.720247470283241548082769013459
HTTP 400
Image with given SeriesInstanceUID,1.3.6.1.4.1.14519.5.2.1.7009.2405.720247470283241548082769013459, is not in public domain.
```

The collection page
(<https://www.cancerimagingarchive.net/collection/acrin-hnscc-fdg-pet-ct/>)
carries the same clause as HNSCC:

> "Some data in this collection contains images that could potentially be used
> to reconstruct a human face. The process for requesting access to these is
> outlined in the NIH Controlled Data Access Policy page."

So all three head & neck CT collections — HNSCC, Head-Neck-PET-CT and
ACRIN-HNSCC-FDG-PET-CT — are behind the **same** dbGaP / NCI Data Commons gate
described in section B. **No CT or PET was downloaded, and no
`thumb_acrin_ct.png` / `thumb_acrin_pt.png` exist.** Nothing can be reported
about the PET series' units, decay-correction or SUV scaling tags, because no
PET file is retrievable.

### License and citation (for the RTSTRUCTs, which *are* open)

The API reports, on all 2085 series (`LicenseName` / `LicenseURI`):

> **Creative Commons Attribution 4.0 International License** —
> <https://creativecommons.org/licenses/by/4.0/>

Required data citation:

> Kinahan P, Muzi M, Bialecki B, Coombs L. *Data from the ACRIN 6685 Trial
> HNSCC-FDG-PET/CT* [Data set]. The Cancer Imaging Archive, 2019.
> doi:10.7937/K9/TCIA.2016.JQEJZZNG

Note CC BY 4.0 is **more permissive than HaN-Seg** (no NC, no ND) — but it
applies only to the contour objects that are actually served.

### Selection table

**Not produced — there was nothing to select.** The selection pass ran over all
258 patients and found zero CT series, so the table has no rows. The scan
itself is the result:

| Collection | Patients | CT series | PT series | RTSTRUCT series | Public bytes |
|---|---:|---:|---:|---:|---:|
| ACRIN-HNSCC-FDG-PET-CT | 258 | **0** | **0** | 2085 | ~36.5 MB |

### Why the orphan RTSTRUCTs were not imported

They are contours with no underlying images. Each references a
`SeriesInstanceUID` that returns *"is not in public domain"*, so hnrad would
index 2085 series that carry no pixel data, produce no thumbnail and report
`is_3d: false`. That is noise in the study browser with no diagnostic value, so
they were deliberately left alone. Say the word if you want them anyway:

```powershell
& $py C:\Users\o948145\hnrad\tools\datasets\fetch_tcia.py `
    --collection ACRIN-HNSCC-FDG-PET-CT --fallback "" --out-name TCIA-ACRIN-HNSCC
```

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
