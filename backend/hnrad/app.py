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

from . import __version__, analysis, config, db
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
