"""Convert HaN-Seg CT and MR T1 volumes (NRRD) into DICOM series for hnrad.

For every case found under
    %LOCALAPPDATA%\\HNRad\\datasets\\HaN-Seg\\raw
this writes a DICOM CT series to
    %LOCALAPPDATA%\\HNRad\\studies\\public\\HaN-Seg\\<case>\\CT\\
and a DICOM MR series to
    %LOCALAPPDATA%\\HNRad\\studies\\public\\HaN-Seg\\<case>\\MR\\
and records the case -> {ct_series_uid, mr_series_uid, organ files} mapping in
    %LOCALAPPDATA%\\HNRad\\studies\\public\\HaN-Seg\\manifest.json

The original NRRD label maps / per-organ segmentation files are deliberately
left untouched next to the raw data.  Contours are NOT converted to DICOM RT yet.

MR frame of reference -- measured, not assumed
    The HaN-Seg paper describes CT and MR acquired for one radiotherapy
    planning episode, and it is tempting to give both series the *same*
    FrameOfReferenceUID.  ``mr_alignment()`` checks that numerically instead of
    assuming it, by mapping every CT-space OAR contour voxel into the MR grid
    under the identity transform and counting how many land inside the MR field
    of view.  On this release the answer is **0.00 % for every organ in every
    case** -- the released NRRD volumes sit in their original, unregistered
    scanner coordinates, up to 1.1 m apart in z.  So the MR gets **its own**
    FrameOfReferenceUID, and CT<->MR needs a real registration
    (POST /api/registration).  The measurement is stored per case in the
    manifest under ``mr_alignment`` so the claim can be re-checked.

Output conformance (CT)
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

Output conformance (MR)
    Modality                   MR
    SOPClassUID                1.2.840.10008.5.1.4.1.1.4  (MR Image Storage)
    SeriesDescription          "HaN-Seg MR T1"
    StudyInstanceUID           the *same* UID as the case's CT, so the viewer
                               shows one study with a CT and an MR series
    FrameOfReferenceUID        its own (see above)
    PixelData                  uint16 when the volume is non-negative and fits,
                               int16 when it is signed and fits, otherwise
                               uint16 with RescaleIntercept = floor(min) so the
                               stored values stay exact
    ScanningSequence           RM (research mode) / SequenceVariant NONE:
                               HaN-Seg ships NRRD, which carries **no** MR
                               acquisition metadata, so TE / TR / TI / flip
                               angle / field strength are deliberately absent
                               rather than invented.  ``sequence_kind`` still
                               resolves to T1 from the SeriesDescription.

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
MR_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.4"
STUDY_DESC = "HaN-Seg CT"
MR_SERIES_DESC = "HaN-Seg MR T1"
# Organs used for the CT<->MR frame-of-reference check.
ALIGNMENT_ORGANS = ("Bone_Mandible", "Brainstem", "Parotid_L", "Parotid_R")
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


def find_mr_cases(raw: Path) -> dict[str, Path]:
    """Return {case_name: mr_t1_nrrd_path} for every MR volume under raw."""
    hits: dict[str, Path] = {}
    for p in raw.rglob("*.nrrd"):
        name = p.name.lower()
        if ".seg." in name or "oar" in name:
            continue
        if "_mr" not in name:
            continue
        hits.setdefault(p.parent.name, p)
    return hits


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


def mr_pixel_plan(img: sitk.Image) -> dict:
    """Pick a lossless integer storage for an MR volume.

    Returns ``{pixel_id, intercept, bits, representation}``.  The rule is to
    keep the stored values *identical* to the NRRD wherever that is possible
    (HaN-Seg ships uint16 and int16 volumes, both of which fit), and only to
    fall back to a RescaleIntercept when a volume is signed and too wide for
    int16.
    """
    a = sitk.GetArrayViewFromImage(img)
    lo, hi = float(a.min()), float(a.max())
    if lo >= 0 and hi <= 65535:
        return {"pixel_id": sitk.sitkUInt16, "intercept": 0.0,
                "representation": 0, "range": [lo, hi], "reason": "fits uint16"}
    if lo >= -32768 and hi <= 32767:
        return {"pixel_id": sitk.sitkInt16, "intercept": 0.0,
                "representation": 1, "range": [lo, hi], "reason": "fits int16"}
    intercept = float(np.floor(lo))
    return {"pixel_id": sitk.sitkUInt16, "intercept": intercept,
            "representation": 0, "range": [lo, hi],
            "reason": "shifted by RescaleIntercept to fit uint16"}


def write_mr_series(img: sitk.Image, case: str, out_dir: Path) -> dict:
    """Write ``img`` as a DICOM MR series into ``out_dir``.  Returns UID info."""
    out_dir.mkdir(parents=True, exist_ok=True)

    plan = mr_pixel_plan(img)
    if plan["intercept"]:
        img = sitk.Cast(img, sitk.sitkFloat64) - plan["intercept"]
    img = sitk.Cast(img, plan["pixel_id"])

    sp = img.GetSpacing()
    d = img.GetDirection()
    nz = img.GetSize()[2]

    study_uid = det_uid("HANSEG", case, "STUDY")           # shared with the CT
    series_uid = det_uid("HANSEG", case, "SERIES", "MR")
    # Deliberately NOT the CT frame of reference -- see mr_alignment().
    for_uid = det_uid("HANSEG", case, "FRAMEOFREFERENCE", "MR")

    iop = "\\".join(fmt(v) for v in (d[0], d[3], d[6], d[1], d[4], d[7]))

    shared = {
        "0008|0016": MR_SOP_CLASS,
        "0008|0060": "MR",
        "0008|0008": "DERIVED\\SECONDARY\\AXIAL",
        "0008|0070": "HaN-Seg",
        "0008|1030": STUDY_DESC,
        "0008|103e": MR_SERIES_DESC,
        "0010|0010": f"HANSEG^{case}",
        "0010|0020": f"HANSEG_{case}",
        "0018|0015": "HEAD",
        # Type 1 in the MR Image module, and HaN-Seg gives us nothing real:
        # RM = research mode, which is the honest "not a named sequence".
        "0018|0020": "RM",
        "0018|0021": "NONE",
        "0018|0023": "2D",
        "0018|0050": fmt(sp[2]),
        "0018|0088": fmt(sp[2]),
        "0020|000d": study_uid,
        "0020|000e": series_uid,
        "0020|0052": for_uid,
        "0020|0011": "2",
        "0020|0037": iop,
        "0028|0004": "MONOCHROME2",
        "0028|0030": f"{fmt(sp[1])}\\{fmt(sp[0])}",
        "0028|1052": fmt(plan["intercept"]),
        "0028|1053": "1",
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
        sl.SetMetaData("0008|0018", det_uid("HANSEG", case, "SOP", "MR", str(z)))
        writer.SetFileName(str(out_dir / f"{z + 1:04d}.dcm"))
        writer.Execute(sl)

    fix_mr_spacing(out_dir, float(sp[2]))

    return {"study_uid": study_uid, "mr_series_uid": series_uid,
            "frame_of_reference_uid": for_uid, "n_slices": nz,
            "pixel_plan": {k: v for k, v in plan.items() if k != "pixel_id"}}


def fix_mr_spacing(out_dir: Path, spacing_z: float) -> int:
    """Rewrite SpacingBetweenSlices on an already-written MR series.

    GDCM, which is what SimpleITK's ``ImageFileWriter`` uses underneath, sets
    ``SpacingBetweenSlices`` (0018,0088) itself when it writes an *MR Image*
    SOP instance, and for a 2D slice it writes ``1`` -- silently discarding the
    value we put in the metadata dictionary.  ``SliceThickness`` (0018,0050)
    survives, so the discrepancy is easy to miss: the volume geometry the
    backend derives from ImagePositionPatient is still right, but ``is_thick``
    and any client reading 0018,0088 are wrong.  Patch it back with pydicom
    after the write.  Returns the number of files corrected.
    """
    n = 0
    for f in sorted(out_dir.glob("*.dcm")):
        ds = pydicom.dcmread(str(f))
        if abs(float(getattr(ds, "SpacingBetweenSlices", 0) or 0) - spacing_z) < 1e-6:
            continue
        ds.SpacingBetweenSlices = f"{spacing_z:.9g}"
        ds.save_as(str(f))
        n += 1
    return n


def verify_mr(src: sitk.Image, out_dir: Path, case: str) -> dict:
    """Re-read the written MR series and compare geometry and pixels."""
    files = sitk.ImageSeriesReader_GetGDCMSeriesFileNames(str(out_dir))
    if not files:
        return {"ok": False, "error": "no DICOM files found after write"}
    got = sitk.ReadImage(files)

    plan = mr_pixel_plan(src)
    src_a = sitk.GetArrayFromImage(src).astype(np.float64)
    # SimpleITK applies RescaleSlope/Intercept on read, so the values come back
    # in the original NRRD units whichever storage plan was used.
    got_a = sitk.GetArrayFromImage(got).astype(np.float64)

    def close(a, b, tol=1e-4):
        return all(abs(x - y) <= tol for x, y in zip(a, b))

    d0 = pydicom.dcmread(files[0])
    dl = pydicom.dcmread(files[-1], stop_before_pixels=True)
    series_uids = {pydicom.dcmread(f, stop_before_pixels=True).SeriesInstanceUID
                   for f in files}
    sop_uids = {pydicom.dcmread(f, stop_before_pixels=True).SOPInstanceUID
                for f in files}

    res = {
        "n_files": len(files),
        "spacing_src": [round(v, 6) for v in src.GetSpacing()],
        "spacing_dcm": [round(v, 6) for v in got.GetSpacing()],
        "origin_src": [round(v, 6) for v in src.GetOrigin()],
        "origin_dcm": [round(v, 6) for v in got.GetOrigin()],
        "direction_src": [round(v, 6) for v in src.GetDirection()],
        "direction_dcm": [round(v, 6) for v in got.GetDirection()],
        "value_src": [float(src_a.min()), float(src_a.max())],
        "value_dcm": [float(got_a.min()), float(got_a.max())],
        "pixels_identical": bool(np.array_equal(src_a, got_a)),
        "max_abs_diff": float(np.max(np.abs(src_a - got_a)))
        if src_a.shape == got_a.shape else None,
        "one_series_uid": len(series_uids) == 1,
        "sop_uids_unique": len(sop_uids) == len(files),
        "modality": str(d0.Modality),
        "sop_class": str(d0.SOPClassUID),
        "series_description": str(getattr(d0, "SeriesDescription", "")),
        "study_uid": str(d0.StudyInstanceUID),
        "frame_of_reference_uid": str(d0.FrameOfReferenceUID),
        "photometric": str(d0.PhotometricInterpretation),
        "bits_allocated": int(d0.BitsAllocated),
        "pixel_representation": int(d0.PixelRepresentation),
        "rescale_intercept": float(getattr(d0, "RescaleIntercept", 0.0)),
        "slice_thickness": float(getattr(d0, "SliceThickness", 0.0)),
        "spacing_between_slices": float(getattr(d0, "SpacingBetweenSlices", 0.0)),
        "patient_id": str(d0.PatientID),
        "iop": [float(x) for x in d0.ImageOrientationPatient],
        "ipp_first": [float(x) for x in d0.ImagePositionPatient],
        "ipp_last": [float(x) for x in dl.ImagePositionPatient],
        "frame_of_reference_consistent":
            str(d0.FrameOfReferenceUID) == str(dl.FrameOfReferenceUID),
        "pixel_plan": plan["reason"],
    }
    res["ok"] = (
        close(res["spacing_src"], res["spacing_dcm"])
        and close(res["origin_src"], res["origin_dcm"])
        and close(res["direction_src"], res["direction_dcm"])
        and res["pixels_identical"]
        and res["one_series_uid"]
        and res["sop_uids_unique"]
        and res["frame_of_reference_consistent"]
        and res["modality"] == "MR"
        and res["sop_class"] == MR_SOP_CLASS
        and res["series_description"] == MR_SERIES_DESC
        and res["photometric"] == "MONOCHROME2"
        and res["patient_id"] == f"HANSEG_{case}"
        and res["n_files"] == src.GetSize()[2]
        and abs(res["spacing_between_slices"] - src.GetSpacing()[2]) < 1e-4
        and abs(res["slice_thickness"] - src.GetSpacing()[2]) < 1e-4
    )
    return res


def _world_to_index(img: sitk.Image) -> tuple[np.ndarray, np.ndarray]:
    """(A, o) with ``index = A @ (world - o)`` for an image's own grid."""
    d = np.asarray(img.GetDirection(), dtype=np.float64).reshape(3, 3)
    s = np.asarray(img.GetSpacing(), dtype=np.float64)
    o = np.asarray(img.GetOrigin(), dtype=np.float64)
    return np.linalg.inv(d @ np.diag(s)), o


def mr_alignment(ct: sitk.Image, mr: sitk.Image, case_dir: Path, case: str) -> dict:
    """Is the MR in the CT frame?  Measured on the OAR contours themselves.

    Every voxel of each CT-space OAR mask is mapped to LPS and then into the MR
    grid's continuous index space under the **identity** transform.  The
    fraction that lands inside the MR field of view is the number that decides
    whether the two series may share a FrameOfReferenceUID: a genuinely
    co-registered MR contains essentially all of the mandible and brainstem,
    while an unregistered one contains none of it.
    """
    out: dict = {
        "method": "identity-transform containment of CT-space OAR contours"
                  " in the MR field of view",
        "ct_origin": [round(v, 3) for v in ct.GetOrigin()],
        "mr_origin": [round(v, 3) for v in mr.GetOrigin()],
        "origin_delta_mm": [round(float(b - a), 3)
                            for a, b in zip(ct.GetOrigin(), mr.GetOrigin())],
        "organs": {},
    }

    def extent(img):
        size = np.asarray(img.GetSize(), float) - 1.0
        corners = np.asarray([
            img.TransformContinuousIndexToPhysicalPoint((float(i), float(j), float(k)))
            for i in (0, size[0]) for j in (0, size[1]) for k in (0, size[2])])
        return corners.min(axis=0), corners.max(axis=0)

    clo, chi = extent(ct)
    mlo, mhi = extent(mr)
    out["ct_extent_mm"] = [[round(v, 1) for v in clo], [round(v, 1) for v in chi]]
    out["mr_extent_mm"] = [[round(v, 1) for v in mlo], [round(v, 1) for v in mhi]]
    out["bbox_overlap_mm"] = [round(float(max(0.0, min(chi[i], mhi[i])
                                              - max(clo[i], mlo[i]))), 1)
                              for i in range(3)]

    A, o = _world_to_index(mr)
    size = np.asarray(mr.GetSize(), dtype=np.float64) - 1.0
    ct_A = np.asarray(ct.GetDirection(), dtype=np.float64).reshape(3, 3) \
        @ np.diag(np.asarray(ct.GetSpacing(), dtype=np.float64))
    ct_o = np.asarray(ct.GetOrigin(), dtype=np.float64)

    covered_total = 0
    n_total = 0
    for organ in ALIGNMENT_ORGANS:
        p = case_dir / f"{case}_OAR_{organ}.seg.nrrd"
        if not p.exists():
            out["organs"][organ] = None
            continue
        seg = sitk.GetArrayFromImage(sitk.ReadImage(str(p))) > 0
        idx = np.argwhere(seg)                       # (k, j, i)
        if idx.size == 0:
            out["organs"][organ] = {"n_voxels": 0, "fraction_inside_mr": None}
            continue
        ijk = idx[:, ::-1].astype(np.float64)        # -> (i, j, k)
        world = ijk @ ct_A.T + ct_o
        mr_idx = (world - o) @ A.T
        inside = np.all((mr_idx >= 0) & (mr_idx <= size), axis=1)
        frac = float(inside.mean())
        out["organs"][organ] = {"n_voxels": int(idx.shape[0]),
                                "fraction_inside_mr": round(frac, 6)}
        covered_total += int(inside.sum())
        n_total += int(idx.shape[0])

    out["fraction_inside_mr_all_organs"] = (
        round(covered_total / n_total, 6) if n_total else None)
    # Sharing a FrameOfReferenceUID is only defensible when the MR really does
    # contain the CT contours.  0.9 is deliberately strict: a partial overlap
    # is a registration problem, not a shared frame.
    out["same_frame_of_reference"] = bool(
        n_total and (covered_total / n_total) >= 0.9)
    return out


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
    ap.add_argument("--modality", choices=("ct", "mr", "both"), default="both",
                    help="which modality to convert (default: both)")
    ap.add_argument("--no-alignment", action="store_true",
                    help="skip the CT<->MR frame-of-reference measurement")
    args = ap.parse_args()

    raw = datasets_root() / "HaN-Seg" / "raw"
    out_root = studies_public_root() / "HaN-Seg"
    if not raw.exists():
        log(f"ERROR: {raw} does not exist.  Run fetch_hanseg.py first.")
        return 2

    cases = find_cases(raw)
    if args.limit:
        cases = cases[: args.limit]
    mr_paths = find_mr_cases(raw)
    log(f"Found {len(cases)} CT volume(s) and {len(mr_paths)} MR volume(s) under {raw}")
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
    n_mr_ok = n_mr_fail = n_mr_skip = 0
    do_ct = args.modality in ("ct", "both")
    do_mr = args.modality in ("mr", "both")

    for i, (case, ct_path) in enumerate(cases, 1):
        out_dir = out_root / case / "CT"
        src = sitk.ReadImage(str(ct_path))
        nz = src.GetSize()[2]
        existing = len(list(out_dir.glob("*.dcm"))) if out_dir.exists() else 0

        if not do_ct:
            if existing != nz:
                log(f"[{i}/{len(cases)}] {case}: CT not written, --modality mr")
            v = None
        elif args.verify_only or (existing == nz and not args.force):
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

        if do_ct:
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

            d0 = pydicom.dcmread(
                sitk.ImageSeriesReader_GetGDCMSeriesFileNames(str(out_dir))[0],
                stop_before_pixels=True)
            entry = manifest.setdefault(case, {})
            entry.update({
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
            })

        # ---------------------------------------------------------------- MR
        mr_path = mr_paths.get(case)
        if not do_mr:
            pass
        elif mr_path is None:
            log(f"    MR: no *_IMG_MR*.nrrd for {case}")
            n_mr_skip += 1
        else:
            mr_out = out_root / case / "MR"
            mr_src = sitk.ReadImage(str(mr_path))
            mr_nz = mr_src.GetSize()[2]
            mr_existing = len(list(mr_out.glob("*.dcm"))) if mr_out.exists() else 0

            if args.verify_only or (mr_existing == mr_nz and not args.force):
                if mr_existing != mr_nz:
                    log(f"    MR: not written yet, skipping (--verify-only)")
                    n_mr_skip += 1
                    mv = None
                else:
                    log(f"    MR: {mr_existing} slices already present, verifying only")
                    mv = verify_mr(mr_src, mr_out, case)
            else:
                log(f"    MR: {mr_nz} slices, size {mr_src.GetSize()}, spacing "
                    f"{tuple(round(v, 4) for v in mr_src.GetSpacing())} -> {mr_out}")
                write_mr_series(mr_src, case, mr_out)
                mv = verify_mr(mr_src, mr_out, case)

            if mv is not None:
                if mv["ok"]:
                    n_mr_ok += 1
                else:
                    n_mr_fail += 1
                log(f"    MR verify {'OK' if mv['ok'] else 'FAIL'}: "
                    f"spacing {mv['spacing_dcm']} vs {mv['spacing_src']} | "
                    f"values {mv['value_dcm']} vs {mv['value_src']} | "
                    f"identical={mv['pixels_identical']} | {mv['n_files']} files | "
                    f"{mv['pixel_plan']}")
                if not mv["ok"]:
                    log(f"    detail: {json.dumps({k: mv[k] for k in sorted(mv)}, default=str)}")

                align = None
                if not args.no_alignment:
                    align = mr_alignment(src, mr_src, mr_path.parent, case)
                    log(f"    MR alignment: {100.0 * (align['fraction_inside_mr_all_organs'] or 0.0):.2f}%"
                        f" of the CT OAR contours fall inside the MR FOV under identity"
                        f" -> same_frame_of_reference={align['same_frame_of_reference']}")

                m0 = pydicom.dcmread(
                    sitk.ImageSeriesReader_GetGDCMSeriesFileNames(str(mr_out))[0],
                    stop_before_pixels=True)
                entry = manifest.setdefault(case, {})
                entry.update({
                    "mr_series_uid": str(m0.SeriesInstanceUID),
                    "mr_study_uid": str(m0.StudyInstanceUID),
                    "mr_frame_of_reference_uid": mv["frame_of_reference_uid"],
                    "mr_n_slices": mv["n_files"],
                    "mr_dicom_dir": str(mr_out),
                    "mr_source_nrrd": str(mr_path),
                    "mr_verification": mv,
                })
                if align is not None:
                    entry["mr_alignment"] = align

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
                "mr_note": "The MR T1 series carries its OWN FrameOfReferenceUID. "
                           "Measured, not assumed: see cases[*].mr_alignment, which maps "
                           "every CT-space OAR contour voxel into the MR grid under the "
                           "identity transform.  The released HaN-Seg NRRD volumes are in "
                           "unregistered scanner coordinates, so CT<->MR needs "
                           "POST /api/registration.",
                "cases": manifest,
            },
            indent=1,
        ),
        encoding="utf-8",
    )
    log(f"Wrote {mpath}  ({len(manifest)} cases)")
    log(f"CT converted/verified: {n_ok} OK, {n_fail} FAILED, {n_skip} skipped")
    log(f"MR converted/verified: {n_mr_ok} OK, {n_mr_fail} FAILED, {n_mr_skip} skipped")
    return 0 if (n_fail == 0 and n_mr_fail == 0) else 1


if __name__ == "__main__":
    raise SystemExit(main())
