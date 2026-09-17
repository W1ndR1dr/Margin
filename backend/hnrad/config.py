"""Configuration and filesystem locations for HNRad.

Everything lives under %LOCALAPPDATA%/HNRad so that DICOM data never lands in
OneDrive.  The locations can be overridden with the environment variables
HNRAD_DATA_ROOT / HNRAD_STUDIES_ROOT / HNRAD_DB_PATH (the tests use these).
"""

from __future__ import annotations

import os
from pathlib import Path

__all__ = [
    "APP_NAME",
    "VERSION",
    "CORS_ORIGINS",
    "WINDOW_WIDTH",
    "WINDOW_CENTER",
    "THUMBNAIL_SIZE",
    "VOLUME_CACHE_SIZE",
    "data_root",
    "studies_root",
    "db_path",
    "ensure_dirs",
]

APP_NAME = "HNRad"
VERSION = "0.1.0"

CORS_ORIGINS = [
    "http://127.0.0.1:5173",
    "http://localhost:5173",
]

# Soft-tissue neck window used for thumbnails.
WINDOW_WIDTH = 350.0
WINDOW_CENTER = 40.0
THUMBNAIL_SIZE = 128

# Number of whole series volumes kept in RAM (LRU).
VOLUME_CACHE_SIZE = 2


def _local_appdata() -> Path:
    env = os.environ.get("LOCALAPPDATA")
    if env:
        return Path(env)
    return Path.home() / "AppData" / "Local"


def data_root() -> Path:
    """Root of the HNRad data store."""
    env = os.environ.get("HNRAD_DATA_ROOT")
    if env:
        return Path(env)
    return _local_appdata() / APP_NAME


def studies_root() -> Path:
    """Default folder that POST /api/import walks."""
    env = os.environ.get("HNRAD_STUDIES_ROOT")
    if env:
        return Path(env)
    return data_root() / "studies"


def db_path() -> Path:
    """Path of the SQLite index."""
    env = os.environ.get("HNRAD_DB_PATH")
    if env:
        return Path(env)
    return data_root() / "db" / "hnrad.sqlite"


def ensure_dirs() -> None:
    """Create the studies root and the database folder if they are missing."""
    studies_root().mkdir(parents=True, exist_ok=True)
    db_path().parent.mkdir(parents=True, exist_ok=True)
