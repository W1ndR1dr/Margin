"""FastAPI application: the local DICOM library and analysis service.

Binds 127.0.0.1 only (see run.ps1).  Implements the REST surface described in
CONTRACT.md verbatim.
"""

from __future__ import annotations

import logging
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from . import __version__, ai, airway, analysis, config, db, segmentation
from .indexer import index_path

# --------------------------------------------------------------------------
# logging: stderr, with timings for import and analysis
# --------------------------------------------------------------------------

_handler = logging.StreamHandler(sys.stderr)
_handler.setFormatter(
    logging.Formatter("%(asctime)s %(levelname)-5s %(name)s: %(message)s",
                      datefmt="%H:%M:%S")
)
_root = logging.getLogger("hnrad")
if not _root.handlers:
    _root.addHandler(_handler)
_root.setLevel(logging.INFO)
log = logging.getLogger("hnrad.app")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    config.ensure_dirs()
    db.init_db()
    log.info("HNRad %s ready - db=%s studies=%s",
             __version__, config.db_path(), config.studies_root())
    yield


app = FastAPI(title="HNRad", version=__version__, docs_url="/api/docs",
              openapi_url="/api/openapi.json", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)



# --------------------------------------------------------------------------
# request / response models
# --------------------------------------------------------------------------

class ImportRequest(BaseModel):
    path: Optional[str] = None


class IsosurfaceRequest(BaseModel):
    series_uid: str
    lower_hu: float
    upper_hu: Optional[float] = None
    step: int = 1
    smooth_iters: int = 0


class RoiStatsRequest(BaseModel):
    series_uid: str
    sop_uid: str
    polygon: list[list[float]] = Field(..., min_length=3)


# --------------------------------------------------------------------------
# library
# --------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "version": __version__,
        "db_path": str(config.db_path()),
        "studies_root": str(config.studies_root()),
    }


@app.post("/api/import")
def api_import(body: Optional[ImportRequest] = None) -> dict[str, Any]:
    raw = (body.path if body is not None else None) or str(config.studies_root())
    root = Path(raw).expanduser()
    if not root.exists():
        raise HTTPException(status_code=404, detail="path not found: {p}".format(p=root))

    started = time.perf_counter()
    try:
        result = index_path(root)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    log.info("POST /api/import %s -> %s in %.3fs",
             root, result, time.perf_counter() - started)
    return result


@app.get("/api/patients")
def api_patients() -> list[dict[str, Any]]:
    db.ensure_db()
    with db.connect() as conn:
        return db.list_patients(conn)


@app.get("/api/studies")
def api_studies(patient_id: Optional[str] = Query(default=None)) -> list[dict[str, Any]]:
    db.ensure_db()
    with db.connect() as conn:
        return db.list_studies(conn, patient_id)


@app.get("/api/studies/{study_uid}/series")
def api_study_series(study_uid: str) -> list[dict[str, Any]]:
    db.ensure_db()
    with db.connect() as conn:
        if not db.study_exists(conn, study_uid):
            raise HTTPException(status_code=404, detail="unknown study_uid")
        return db.list_series(conn, study_uid)


@app.get("/api/series/{series_uid}")
def api_series(series_uid: str) -> dict[str, Any]:
    db.ensure_db()
    with db.connect() as conn:
        series = db.get_series(conn, series_uid)
        if series is None:
            raise HTTPException(status_code=404, detail="unknown series_uid")
        rows = db.get_series_instances(conn, series_uid)

    ordered = analysis.sorted_instances(rows)
    series["instances"] = [
        {
            "sop_uid": r["sop_uid"],
            "instance_number": r["instance_number"],
            "ipp": (
                [float(r["ipp_x"]), float(r["ipp_y"]), float(r["ipp_z"])]
                if r["ipp_x"] is not None else None
            ),
            "slice_pos": float(pos) if pos is not None else None,
        }
        for r, pos in ordered
    ]
    return series


@app.get("/api/instances/{sop_uid}")
def api_instance(sop_uid: str) -> FileResponse:
    db.ensure_db()
    with db.connect() as conn:
        row = db.get_instance(conn, sop_uid)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown sop_uid")
    path = Path(row["file_path"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="file missing on disk")
    return FileResponse(
        str(path),
        media_type="application/dicom",
        # SOPInstanceUIDs are immutable, so the bytes behind one never change.
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.get("/api/series/{series_uid}/thumbnail")
def api_thumbnail(series_uid: str) -> Response:
    db.ensure_db()
    with db.connect() as conn:
        if db.get_series(conn, series_uid) is None:
            raise HTTPException(status_code=404, detail="unknown series_uid")
        rows = db.get_series_instances(conn, series_uid)
    if not rows:
        raise HTTPException(status_code=404, detail="series has no instances")

    ordered = analysis.sorted_instances(rows)
    middle = ordered[len(ordered) // 2][0]
    try:
        png = analysis.render_thumbnail(series_uid, middle)
    except analysis.AnalysisError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# --------------------------------------------------------------------------
# analysis
# --------------------------------------------------------------------------

def _series_rows(series_uid: str) -> list[Any]:
    db.ensure_db()
    with db.connect() as conn:
        if db.get_series(conn, series_uid) is None:
            raise HTTPException(status_code=404, detail="unknown series_uid")
        rows = db.get_series_instances(conn, series_uid)
    if not rows:
        raise HTTPException(status_code=404, detail="series has no instances")
    return list(rows)


@app.post("/api/analysis/isosurface")
def api_isosurface(body: IsosurfaceRequest) -> Response:
    started = time.perf_counter()
    rows = _series_rows(body.series_uid)
    try:
        vol = analysis.load_series_volume(body.series_uid, rows)
        stl = analysis.isosurface_stl(
            vol,
            lower_hu=body.lower_hu,
            upper_hu=body.upper_hu,
            step=body.step,
            smooth_iters=body.smooth_iters,
        )
    except analysis.AnalysisError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    n_tri = (len(stl) - 84) // 50
    log.info(
        "POST /api/analysis/isosurface series=%s lower=%s upper=%s step=%s"
        " smooth=%s -> %d triangles, %d bytes in %.3fs",
        body.series_uid, body.lower_hu, body.upper_hu, body.step,
        body.smooth_iters, n_tri, len(stl), time.perf_counter() - started,
    )
    filename = "{s}_{l:g}HU.stl".format(s=body.series_uid, l=body.lower_hu)
    return Response(
        content=stl,
        media_type="application/sla",
        headers={
            "Content-Disposition": 'attachment; filename="{f}"'.format(f=filename),
            "Content-Length": str(len(stl)),
        },
    )


@app.post("/api/analysis/roi-stats")
def api_roi_stats(body: RoiStatsRequest) -> dict[str, float]:
    started = time.perf_counter()
    db.ensure_db()
    with db.connect() as conn:
        if db.get_series(conn, body.series_uid) is None:
            raise HTTPException(status_code=404, detail="unknown series_uid")
        row = db.get_instance(conn, body.sop_uid)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown sop_uid")
    if row["series_uid"] != body.series_uid:
        raise HTTPException(
            status_code=400, detail="sop_uid does not belong to series_uid"
        )

    try:
        hu, row_mm, col_mm = analysis.load_instance_hu(row)
        stats = analysis.roi_stats(hu, body.polygon, row_mm, col_mm)
    except analysis.AnalysisError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    log.info("POST /api/analysis/roi-stats series=%s sop=%s -> n=%d in %.3fs",
             body.series_uid, body.sop_uid, stats["n_voxels"],
             time.perf_counter() - started)
    return stats


# --------------------------------------------------------------------------
# analysis v0.2: segmentation, volumetrics and the airway analyser
# --------------------------------------------------------------------------

class RegionGrowRequest(BaseModel):
    series_uid: str
    seed_ijk: Optional[list[float]] = None
    seed_lps: Optional[list[float]] = None
    lower_hu: float
    upper_hu: float
    max_radius_mm: Optional[float] = 40.0
    closing_mm: float = 0.0
    keep_largest: bool = True


class ThresholdRequest(BaseModel):
    series_uid: str
    lower_hu: float
    upper_hu: float
    inside_body: bool = True
    keep_largest: bool = False
    min_component_ml: float = 0.05


class DistanceRequest(BaseModel):
    label_a: str
    label_b: str


class AirwayRequest(BaseModel):
    series_uid: str
    seed_ijk: Optional[list[float]] = None
    seed_lps: Optional[list[float]] = None
    lower_hu: float = -1024.0
    upper_hu: float = -400.0
    glottis_slice: Optional[int] = None
    reference: str = "auto"
    ref_range_k: Optional[list[int]] = None


def _series_volume(series_uid: str) -> analysis.SeriesVolume:
    """Cached HU volume for a series (404 unknown series, 400 unreadable)."""
    rows = _series_rows(series_uid)
    try:
        return analysis.load_series_volume(series_uid, rows)
    except analysis.AnalysisError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _label_or_404(label_id: str) -> segmentation.Label:
    label = segmentation.LABELS.get(label_id)
    if label is None:
        # AI structures are handed a label_id when their job finishes but the
        # mask itself only gets built on first use, so a miss here is normal
        # rather than fatal: rebuild it from the cached multi-label NIfTI.
        try:
            label = ai.rehydrate_label(label_id)
        except ai.AiError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    if label is None:
        raise HTTPException(
            status_code=404,
            detail="unknown label_id (labels live in memory and expire)",
        )
    return label


@app.post("/api/analysis/region-grow")
def api_region_grow(body: RegionGrowRequest) -> dict[str, Any]:
    started = time.perf_counter()
    vol = _series_volume(body.series_uid)
    try:
        seed = segmentation.seed_to_ijk(vol, body.seed_ijk, body.seed_lps)
        mask = segmentation.region_grow(
            vol, seed,
            lower_hu=body.lower_hu,
            upper_hu=body.upper_hu,
            max_radius_mm=body.max_radius_mm,
            closing_mm=body.closing_mm,
            keep_largest=body.keep_largest,
        )
        took_ms = (time.perf_counter() - started) * 1000.0
        stats = segmentation.mask_stats(vol, mask, took_ms=took_ms)
    except analysis.AnalysisError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    label = segmentation.LABELS.put(
        body.series_uid, mask,
        {"kind": "region-grow", "stats": stats, "request": body.model_dump()},
    )
    log.info(
        "POST /api/analysis/region-grow series=%s seed=%s hu=[%s,%s] -> %s"
        " n=%d %.3f mL in %.3fs",
        body.series_uid, seed, body.lower_hu, body.upper_hu, label.label_id,
        stats["n_voxels"], stats["volume_ml"], time.perf_counter() - started,
    )
    return {"label_id": label.label_id, **stats}


@app.post("/api/analysis/threshold")
def api_threshold(body: ThresholdRequest) -> dict[str, Any]:
    started = time.perf_counter()
    vol = _series_volume(body.series_uid)
    try:
        mask = segmentation.threshold_mask(
            vol,
            lower_hu=body.lower_hu,
            upper_hu=body.upper_hu,
            inside_body=body.inside_body,
            keep_largest=body.keep_largest,
            min_component_ml=body.min_component_ml,
        )
        took_ms = (time.perf_counter() - started) * 1000.0
        stats = segmentation.mask_stats(vol, mask, took_ms=took_ms)
    except analysis.AnalysisError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    label = segmentation.LABELS.put(
        body.series_uid, mask,
        {"kind": "threshold", "stats": stats, "request": body.model_dump()},
    )
    log.info(
        "POST /api/analysis/threshold series=%s hu=[%s,%s] inside_body=%s -> %s"
        " n=%d %.3f mL in %.3fs",
        body.series_uid, body.lower_hu, body.upper_hu, body.inside_body,
        label.label_id, stats["n_voxels"], stats["volume_ml"],
        time.perf_counter() - started,
    )
    return {"label_id": label.label_id, **stats}


@app.get("/api/analysis/label/{label_id}/stats")
def api_label_stats(label_id: str) -> dict[str, Any]:
    label = _label_or_404(label_id)
    stats = label.meta.get("stats")
    if stats is None:                                    # pragma: no cover
        vol = _series_volume(label.series_uid)
        try:
            stats = segmentation.mask_stats(vol, label.mask)
        except analysis.AnalysisError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        label.meta["stats"] = stats
    return {"label_id": label.label_id, **stats}


@app.get("/api/analysis/label/{label_id}/mesh")
def api_label_mesh(
    label_id: str,
    smooth_iters: int = Query(default=10, ge=0, le=200),
    step: int = Query(default=1, ge=1, le=2),
) -> Response:
    started = time.perf_counter()
    label = _label_or_404(label_id)
    vol = _series_volume(label.series_uid)
    try:
        stl = segmentation.label_mesh_stl(
            vol, label.mask, smooth_iters=smooth_iters, step=step,
            header="HNRad label {i}".format(i=label_id[:24]),
        )
    except analysis.AnalysisError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    n_tri = (len(stl) - 84) // 50
    log.info("GET /api/analysis/label/%s/mesh smooth=%s step=%s ->"
             " %d triangles, %d bytes in %.3fs",
             label_id, smooth_iters, step, n_tri, len(stl),
             time.perf_counter() - started)
    filename = "label_{i}.stl".format(i=label_id)
    return Response(
        content=stl,
        media_type="application/sla",
        headers={
            "Content-Disposition": 'attachment; filename="{f}"'.format(f=filename),
            "Content-Length": str(len(stl)),
        },
    )


@app.get("/api/analysis/label/{label_id}/mask")
def api_label_mask(label_id: str) -> Response:
    started = time.perf_counter()
    label = _label_or_404(label_id)
    vol = _series_volume(label.series_uid)
    blob, headers = segmentation.mask_payload(vol, label.mask)
    headers["Content-Length"] = str(len(blob))
    headers["X-Label-Id"] = label.label_id
    headers["X-Series-Uid"] = label.series_uid
    log.info("GET /api/analysis/label/%s/mask -> %d bytes gzip in %.3fs",
             label_id, len(blob), time.perf_counter() - started)
    return Response(content=blob, media_type="application/gzip", headers=headers)


@app.delete("/api/analysis/label/{label_id}")
def api_label_delete(label_id: str) -> dict[str, Any]:
    if not segmentation.LABELS.delete(label_id):
        raise HTTPException(status_code=404, detail="unknown label_id")
    log.info("DELETE /api/analysis/label/%s", label_id)
    return {"deleted": label_id, "labels": len(segmentation.LABELS)}


@app.post("/api/analysis/distance")
def api_distance(body: DistanceRequest) -> dict[str, Any]:
    started = time.perf_counter()
    a = _label_or_404(body.label_a)
    b = _label_or_404(body.label_b)
    if a.series_uid != b.series_uid:
        raise HTTPException(status_code=400,
                            detail="the two labels belong to different series")
    vol = _series_volume(a.series_uid)
    try:
        out = segmentation.min_distance(vol, a.mask, b.mask)
    except analysis.AnalysisError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    log.info("POST /api/analysis/distance %s -> %s = %.3f mm in %.3fs",
             body.label_a, body.label_b, out["min_distance_mm"],
             time.perf_counter() - started)
    return out


@app.post("/api/analysis/airway")
def api_airway(body: AirwayRequest) -> dict[str, Any]:
    started = time.perf_counter()
    vol = _series_volume(body.series_uid)
    try:
        mask, result = airway.analyze_airway(
            vol,
            seed_ijk=body.seed_ijk,
            seed_lps=body.seed_lps,
            lower_hu=body.lower_hu,
            upper_hu=body.upper_hu,
            glottis_slice=body.glottis_slice,
            reference=body.reference,
            ref_range_k=body.ref_range_k,
        )
        stats = segmentation.mask_stats(vol, mask, took_ms=result["took_ms"])
    except analysis.AnalysisError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    label = segmentation.LABELS.put(
        body.series_uid, mask,
        {"kind": "airway", "stats": stats, "request": body.model_dump()},
    )
    log.info(
        "POST /api/analysis/airway series=%s -> %s ref=%.1f min=%.1f mm2"
        " stenosis=%s%% grade=%s in %.3fs",
        body.series_uid, label.label_id, result["csa_ref_mm2"],
        result["min_csa_mm2"], result["stenosis_pct"],
        result["myer_cotton_grade"], time.perf_counter() - started,
    )
    return {"label_id": label.label_id, **result}


# --------------------------------------------------------------------------
# AI v0.3: TotalSegmentator and the HNLNL nodal-level model as background jobs
#
# Every model runs in a *separate* interpreter (backend/ai/* inside
# %LOCALAPPDATA%\HNRad\venv-ai).  Nothing in this process ever imports torch.
# --------------------------------------------------------------------------

class AiSegmentRequest(BaseModel):
    series_uid: str
    model: str = "totalseg"
    tasks: Optional[list[str]] = None
    roi_subset: Optional[list[str]] = None
    fast: bool = False


def _job_or_404(job_id: str) -> ai.Job:
    job = ai.JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job_id")
    return job


@app.get("/api/ai/models")
def api_ai_models() -> dict[str, Any]:
    """Which models and tasks are actually runnable right now.

    Reports weights presence per task (including the crop model each head/neck
    subtask depends on), the licence of each, and the class list read out of
    the installed TotalSegmentator rather than out of a README.
    """
    return ai.model_catalog()


@app.post("/api/ai/segment")
def api_ai_segment(body: AiSegmentRequest) -> dict[str, Any]:
    started = time.perf_counter()
    _series_rows(body.series_uid)                # 404 early on a bad series
    try:
        job = ai.JOBS.submit(
            series_uid=body.series_uid,
            model=body.model,
            tasks=body.tasks,
            roi_subset=body.roi_subset,
            fast=body.fast,
        )
    except ai.AiError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    log.info("POST /api/ai/segment series=%s model=%s tasks=%s fast=%s -> %s in %.3fs",
             body.series_uid, body.model, body.tasks, body.fast, job.job_id,
             time.perf_counter() - started)
    return {"job_id": job.job_id, "status": job.status,
            "model": job.model, "tasks": list(job.tasks),
            "roi_subset": list(job.roi_subset) if job.roi_subset else None,
            "fast": job.fast}


@app.get("/api/ai/jobs")
def api_ai_jobs() -> list[dict[str, Any]]:
    return [j.public() for j in ai.JOBS.list()]


@app.get("/api/ai/jobs/{job_id}")
def api_ai_job(job_id: str) -> dict[str, Any]:
    return _job_or_404(job_id).public()


@app.delete("/api/ai/jobs/{job_id}")
def api_ai_job_cancel(job_id: str) -> dict[str, Any]:
    job = ai.JOBS.cancel(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown job_id")
    log.info("DELETE /api/ai/jobs/%s -> %s", job_id, job.status)
    return {"job_id": job.job_id, "status": job.status,
            "cancelled": job.status not in ("done",)}
