"""Convert HaN-Seg CT volumes (NRRD) into proper DICOM CT series for hnrad.

For every case found under
    %LOCALAPPDATA%\\HNRad\\datasets\\HaN-Seg\\raw
this writes a DICOM CT series to
    %LOCALAPPDATA%\\HNRad\\studies\\public\\HaN-Seg\\<case>\\CT\\
and records the case -> {ct_series_uid, organ files} mapping in
    %LOCALAPPDATA%\\HNRad\\studies\\public\\HaN-Seg\\manifest.json

The original NRRD label maps / per-organ segmentation files are deliberately
left untouched next to the raw data.  Contours are NOT converted to DICOM RT yet.

Output conformance
    Modality                   CT
    SOPClassUID                1.2.840.10008.5.1.4.1.1.2  (CT Image Storage)
    PixelData                  int16, BitsAllocated 16, PixelRepresentation 1
    RescaleIntercept / Slope   0 / 1   (stored values ARE Hounsfield units)
    PhotometricInterpretation  MONOCHROME2
    ImageOrientationPatient    taken from the NRRD direction cosines
    ImagePositionPatient       per slice, from TransformIndexToPhysicalPoint
    PixelSpacing               (row, col) = (spacing_y, spacing_x)
    SliceThickness / SpacingBetweenSlices  = spacing_z
    Study / Series / FrameOfReference UIDs  deterministic per case, so re-runs
                               are idempotent and the backend re-indexes in place
    PatientName                HANSEG^<case>
    PatientID                  HANSEG_<case>
    StudyDescription           HaN-Seg CT

Note on the writer
    SimpleITK's ``ImageSeriesWriter`` cannot emit DICOM -- it raises
    "ImageSeriesWriter does not support writing a DICOM series!".  The supported
    route (and the one SimpleITK's own DicomSeriesFromArray example uses) is
    ``ImageFileWriter`` slice by slice with ``KeepOriginalImageUIDOn()``, which
    is what this script does.  Geometry is verified afterwards by re-reading the
    written series with ``ImageSeriesReader``.

Usage:
    <venv>\\Scripts\\python.exe tools\\datasets\\nrrd_to_dicom.py [--limit N]
                                                                 [--force]
                                                                 [--verify-only]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pydicom
import SimpleITK as sitk
from pydicom.uid import generate_uid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import datasets_root, human, log, studies_public_root  # noqa: E402

CT_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.2"
STUDY_DESC = "HaN-Seg CT"
UID_ROOT = "1.2.826.0.1.3680043.10.1337."  # deterministic, local-only data


def det_uid(*parts: str) -> str:
    """Deterministic UID: the same case always yields the same UID."""
    return generate_uid(prefix=UID_ROOT, entropy_srcs=list(parts))


def find_cases(raw: Path) -> list[tuple[str, Path]]:
    """Return [(case_name, ct_nrrd_path)] for every CT volume under raw."""
    hits: dict[str, Path] = {}
    for p in raw.rglob("*.nrrd"):
        name = p.name.lower()
        if "_ct" not in name and "ct." not in name:
            continue
        if ".seg." in name or "oar" in name:
            continue
        if "_mr" in name:
            continue
        case = p.parent.name
        hits.setdefault(case, p)
    return sorted(hits.items())


def organ_files(ct_path: Path) -> list[str]:
    """Segmentation / label files sitting next to the CT, as relative names."""
    out = []
    for p in sorted(ct_path.parent.iterdir()):
        if p == ct_path or not p.is_file():
            continue
        n = p.name.lower()
        if n.endswith(".nrrd") and (".seg." in n or "oar" in n or "label" in n):
            out.append(p.name)
    return out


def fmt(v: float) -> str:
    return f"{v:.9g}"


def write_series(img: sitk.Image, case: str, out_dir: Path) -> dict:
    """Write ``img`` as a DICOM CT series into ``out_dir``.  Returns UID info."""
    out_dir.mkdir(parents=True, exist_ok=True)

    img = sitk.Cast(img, sitk.sitkInt16)
    sp = img.GetSpacing()
    d = img.GetDirection()
    nz = img.GetSize()[2]

    study_uid = det_uid("HANSEG", case, "STUDY")
    series_uid = det_uid("HANSEG", case, "SERIES", "CT")
    for_uid = det_uid("HANSEG", case, "FRAMEOFREFERENCE")

    # DICOM IOP = first two COLUMNS of the direction matrix (row dir, col dir).
    iop = "\\".join(fmt(v) for v in (d[0], d[3], d[6], d[1], d[4], d[7]))

    shared = {
        "0008|0016": CT_SOP_CLASS,
        "0008|0060": "CT",
        "0008|0008": "DERIVED\\SECONDARY\\AXIAL",
        "0008|0070": "HaN-Seg",
        "0008|1030": STUDY_DESC,
        "0008|103e": "CT (from HaN-Seg NRRD)",
        "0010|0010": f"HANSEG^{case}",
        "0010|0020": f"HANSEG_{case}",
        "0018|0015": "HEAD",
        "0018|0050": fmt(sp[2]),
        "0018|0088": fmt(sp[2]),
        "0020|000d": study_uid,
        "0020|000e": series_uid,
        "0020|0052": for_uid,
        "0020|0011": "1",
        "0020|0037": iop,
        "0028|0004": "MONOCHROME2",
        "0028|0030": f"{fmt(sp[1])}\\{fmt(sp[0])}",  # (row, col) = (dy, dx)
        "0028|1052": "0",   # RescaleIntercept
        "0028|1053": "1",   # RescaleSlope
        "0028|1054": "HU",
    }

    writer = sitk.ImageFileWriter()
    writer.KeepOriginalImageUIDOn()

    for z in range(nz):
        sl = img[:, :, z]
        for k, v in shared.items():
            sl.SetMetaData(k, v)
        ipp = img.TransformIndexToPhysicalPoint((0, 0, z))
        sl.SetMetaData("0020|0032", "\\".join(fmt(v) for v in ipp))
        sl.SetMetaData("0020|0013", str(z + 1))
        sl.SetMetaData("0008|0018", det_uid("HANSEG", case, "SOP", str(z)))
        writer.SetFileName(str(out_dir / f"{z + 1:04d}.dcm"))
        writer.Execute(sl)

    return {"study_uid": study_uid, "ct_series_uid": series_uid, "frame_of_reference_uid": for_uid,
            "n_slices": nz}


def verify(src: sitk.Image, out_dir: Path, case: str) -> dict:
    """Re-read the written series with SimpleITK + pydicom and compare geometry."""
    files = sitk.ImageSeriesReader_GetGDCMSeriesFileNames(str(out_dir))
    if not files:
        return {"ok": False, "error": "no DICOM files found after write"}
    got = sitk.ReadImage(files)

    src_a = sitk.GetArrayFromImage(sitk.Cast(src, sitk.sitkInt16))
    got_a = sitk.GetArrayFromImage(got)

    def close(a, b, tol=1e-4):
        return all(abs(x - y) <= tol for x, y in zip(a, b))

    d0 = pydicom.dcmread(files[0])
    dl = pydicom.dcmread(files[-1])
    series_uids = {pydicom.dcmread(f, stop_before_pixels=True).SeriesInstanceUID for f in files}
    sop_uids = {pydicom.dcmread(f, stop_before_pixels=True).SOPInstanceUID for f in files}

    res = {
        "n_files": len(files),
        "spacing_src": [round(v, 6) for v in src.GetSpacing()],
        "spacing_dcm": [round(v, 6) for v in got.GetSpacing()],
        "origin_src": [round(v, 6) for v in src.GetOrigin()],
        "origin_dcm": [round(v, 6) for v in got.GetOrigin()],
        "direction_src": [round(v, 6) for v in src.GetDirection()],
        "direction_dcm": [round(v, 6) for v in got.GetDirection()],
        "hu_src": [int(src_a.min()), int(src_a.max())],
        "hu_dcm": [int(got_a.min()), int(got_a.max())],
        "pixels_identical": bool(np.array_equal(src_a, got_a)),
        "one_series_uid": len(series_uids) == 1,
        "sop_uids_unique": len(sop_uids) == len(files),
        "modality": str(d0.Modality),
        "photometric": str(d0.PhotometricInterpretation),
        "rescale": [float(d0.RescaleIntercept), float(d0.RescaleSlope)],
        "bits_allocated": int(d0.BitsAllocated),
        "pixel_representation": int(d0.PixelRepresentation),
        "patient_name": str(d0.PatientName),
        "patient_id": str(d0.PatientID),
        "study_description": str(getattr(d0, "StudyDescription", "")),
        "iop": [float(x) for x in d0.ImageOrientationPatient],
        "ipp_first": [float(x) for x in d0.ImagePositionPatient],
        "ipp_last": [float(x) for x in dl.ImagePositionPatient],
        "frame_of_reference_consistent": str(d0.FrameOfReferenceUID) == str(dl.FrameOfReferenceUID),
    }
    res["ok"] = (
        close(res["spacing_src"], res["spacing_dcm"])
        and close(res["origin_src"], res["origin_dcm"])
        and close(res["direction_src"], res["direction_dcm"])
        and res["hu_src"] == res["hu_dcm"]
        and res["pixels_identical"]
        and res["one_series_uid"]
        and res["sop_uids_unique"]
        and res["frame_of_reference_consistent"]
        and res["modality"] == "CT"
        and res["photometric"] == "MONOCHROME2"
        and res["rescale"] == [0.0, 1.0]
        and res["pixel_representation"] == 1
        and res["patient_name"] == f"HANSEG^{case}"
        and res["patient_id"] == f"HANSEG_{case}"
        and res["study_description"] == STUDY_DESC
        and res["n_files"] == src.GetSize()[2]
    )
    return res


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=0, help="convert only the first N cases (0 = all)")
    ap.add_argument("--force", action="store_true", help="re-write series that already exist")
    ap.add_argument("--verify-only", action="store_true", help="only re-verify what is already written")
    args = ap.parse_args()

    raw = datasets_root() / "HaN-Seg" / "raw"
    out_root = studies_public_root() / "HaN-Seg"
    if not raw.exists():
        log(f"ERROR: {raw} does not exist.  Run fetch_hanseg.py first.")
        return 2

    cases = find_cases(raw)
    if args.limit:
        cases = cases[: args.limit]
    log(f"Found {len(cases)} CT volume(s) under {raw}")
    if not cases:
        return 2

    manifest: dict[str, dict] = {}
    mpath = out_root / "manifest.json"
    if mpath.exists():
        try:
            manifest = json.loads(mpath.read_text(encoding="utf-8")).get("cases", {})
        except Exception:
            manifest = {}

    n_ok = n_fail = n_skip = 0
    for i, (case, ct_path) in enumerate(cases, 1):
        out_dir = out_root / case / "CT"
        src = sitk.ReadImage(str(ct_path))
        nz = src.GetSize()[2]
        existing = len(list(out_dir.glob("*.dcm"))) if out_dir.exists() else 0

        if args.verify_only or (existing == nz and not args.force):
            if existing != nz:
                log(f"[{i}/{len(cases)}] {case}: not written yet, skipping (--verify-only)")
                n_skip += 1
                continue
            log(f"[{i}/{len(cases)}] {case}: {existing} slices already present, verifying only")
            info = {"n_slices": nz}
        else:
            log(f"[{i}/{len(cases)}] {case}: {nz} slices, size {src.GetSize()}, spacing "
                f"{tuple(round(v,4) for v in src.GetSpacing())} -> {out_dir}")
            info = write_series(src, case, out_dir)

        v = verify(src, out_dir, case)
        status = "OK" if v["ok"] else "FAIL"
        if v["ok"]:
            n_ok += 1
        else:
            n_fail += 1
        log(f"    verify {status}: spacing {v['spacing_dcm']} vs {v['spacing_src']} | "
            f"origin {v['origin_dcm']} vs {v['origin_src']} | HU {v['hu_dcm']} vs {v['hu_src']} | "
            f"pixels_identical={v['pixels_identical']} | {v['n_files']} files")
        if not v["ok"]:
            log(f"    detail: {json.dumps({k: v[k] for k in sorted(v)}, default=str)}")

        d0 = pydicom.dcmread(sitk.ImageSeriesReader_GetGDCMSeriesFileNames(str(out_dir))[0],
                             stop_before_pixels=True)
        manifest[case] = {
            "ct_series_uid": str(d0.SeriesInstanceUID),
            "study_uid": str(d0.StudyInstanceUID),
            "frame_of_reference_uid": str(d0.FrameOfReferenceUID),
            "patient_id": str(d0.PatientID),
            "n_slices": v["n_files"],
            "dicom_dir": str(out_dir),
            "source_nrrd": str(ct_path),
            "organ_files": organ_files(ct_path),
            "organ_files_dir": str(ct_path.parent),
            "verification": v,
        }

    out_root.mkdir(parents=True, exist_ok=True)
    mpath.write_text(
        json.dumps(
            {
                "dataset": "HaN-Seg",
                "source": "https://zenodo.org/records/7442914",
                "doi": "10.5281/zenodo.7442914",
                "license": "CC BY-NC-ND 4.0 (non-commercial, no derivatives) - validation only",
                "note": "Original NRRD CT/MR and per-organ segmentations remain under "
                        "%LOCALAPPDATA%/HNRad/datasets/HaN-Seg/raw; contours are NOT converted to DICOM RT.",
                "cases": manifest,
            },
            indent=1,
        ),
        encoding="utf-8",
    )
    log(f"Wrote {mpath}  ({len(manifest)} cases)")
    log(f"Converted/verified: {n_ok} OK, {n_fail} FAILED, {n_skip} skipped")
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
