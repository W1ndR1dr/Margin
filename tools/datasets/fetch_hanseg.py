"""Fetch the HaN-Seg head-and-neck OAR segmentation dataset from Zenodo.

Dataset : HaN-Seg: The head and neck organ-at-risk CT & MR segmentation dataset
Authors : Podobnik G, Strojan P, Peterlin P, Ibragimov B, Vrtovec T (2023)
Record  : https://zenodo.org/records/7442914   (DOI 10.5281/zenodo.7442914)
License : CC BY-NC-ND 4.0  -- non-commercial, NO DERIVATIVES.
          => validation / verification use only.  See README.md.

Access  : fully open.  Zenodo serves the archive over a plain HTTPS URL with no
          login, no registration and no click-through agreement, so this script
          only ever performs anonymous GETs.

Usage:
    <venv>\\Scripts\\python.exe tools\\datasets\\fetch_hanseg.py [--dry-run]
                                                                [--max-gb 25]
                                                                [--no-extract]

Downloads to   %LOCALAPPDATA%\\HNRad\\datasets\\HaN-Seg\\raw
Extracts into  %LOCALAPPDATA%\\HNRad\\datasets\\HaN-Seg\\raw\\HaN-Seg
Resumable: a partially downloaded archive is continued with an HTTP Range
request; a complete archive is verified by size + md5 and then skipped.
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import (  # noqa: E402
    datasets_root,
    download_resumable,
    human,
    init_tls,
    log,
    make_session,
)

ZENODO_RECORD = "7442914"
ZENODO_API = f"https://zenodo.org/api/records/{ZENODO_RECORD}"

# Files we do not need for a CT viewer.  HaN-Seg ships one monolithic zip, so
# this normally matches nothing -- it exists so that a future multi-file version
# of the record can be filtered down to CT + segmentations.
MR_HINTS = ("_MR_", "mr_t1", "-mr.", "_mr.")


def fetch_record(session, record: str = ZENODO_RECORD) -> dict:
    """Return the Zenodo record JSON, following the record to its latest version."""
    url = f"https://zenodo.org/api/records/{record}"
    log(f"GET {url}")
    r = session.get(url, timeout=60)
    r.raise_for_status()
    rec = r.json()

    latest_url = rec.get("links", {}).get("latest")
    if latest_url:
        try:
            lr = session.get(latest_url, timeout=60)
            lr.raise_for_status()
            latest = lr.json()
            if str(latest.get("id")) != str(rec.get("id")):
                log(
                    f"Record {rec.get('id')} is superseded by {latest.get('id')} "
                    f"(version {latest.get('metadata', {}).get('version')}); using the latest."
                )
                rec = latest
        except Exception as exc:
            log(f"WARNING: could not resolve latest version ({exc}); using {record}")
    return rec


def describe(rec: dict) -> list[dict]:
    md = rec.get("metadata", {})
    log("-" * 78)
    log(f"Title        : {md.get('title')}")
    log(f"Record / DOI : {rec.get('id')}  /  {rec.get('doi')}")
    log(f"Version      : {md.get('version')}   published {md.get('publication_date')}")
    lic = md.get("license")
    lic_id = lic.get("id") if isinstance(lic, dict) else lic
    log(f"License      : {lic_id}")
    log(f"Access right : {md.get('access_right')}")
    log("-" * 78)

    files = rec.get("files", [])
    total = 0
    for f in files:
        total += f.get("size", 0)
        log(f"  {f.get('key'):<40s} {human(f.get('size', 0)):>10s}  {f.get('checksum', '')}")
    log(f"  {'TOTAL':<40s} {human(total):>10s}   ({total} bytes, {len(files)} file(s))")
    log("-" * 78)
    return files


def select_files(files: list[dict], max_gb: float) -> list[dict]:
    total = sum(f.get("size", 0) for f in files)
    if total <= max_gb * 1024 ** 3:
        log(f"Total {human(total)} is within the {max_gb} GB budget; taking everything.")
        return files

    log(f"Total {human(total)} exceeds the {max_gb} GB budget; dropping MR-only files.")
    keep = [f for f in files if not any(h in f.get("key", "").lower() for h in MR_HINTS)]
    kept = sum(f.get("size", 0) for f in keep)
    log(f"After dropping MR: {human(kept)} in {len(keep)} file(s).")
    if kept > max_gb * 1024 ** 3:
        log(
            "WARNING: still over budget and MR is not separable in this record "
            "(HaN-Seg ships a single archive containing CT + MR + segmentations). "
            "Re-run with a larger --max-gb to proceed."
        )
        return []
    return keep


def extract(archive: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as zf:
        members = zf.infolist()
        todo = []
        for m in members:
            if m.is_dir():
                continue
            target = out_dir / m.filename
            if target.exists() and target.stat().st_size == m.file_size:
                continue
            todo.append(m)
        log(
            f"Extracting {archive.name}: {len(members)} entries, "
            f"{len(todo)} to write (rest already present with matching size)"
        )
        for i, m in enumerate(todo, 1):
            zf.extract(m, out_dir)
            if i % 100 == 0 or i == len(todo):
                log(f"  extracted {i}/{len(todo)}")
    return out_dir


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="list files and sizes, download nothing")
    ap.add_argument("--max-gb", type=float, default=25.0, help="size budget in GB (default 25)")
    ap.add_argument("--no-extract", action="store_true", help="download only, do not unzip")
    args = ap.parse_args()

    init_tls()
    session = make_session()

    raw = datasets_root() / "HaN-Seg" / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    log(f"Raw directory: {raw}")

    rec = fetch_record(session)
    files = describe(rec)

    # Keep the provenance next to the data.
    (raw / "zenodo_record.json").write_text(json.dumps(rec, indent=1), encoding="utf-8")

    if args.dry_run:
        log("--dry-run: stopping before download.")
        return 0

    chosen = select_files(files, args.max_gb)
    if not chosen:
        log("Nothing selected; aborting.")
        return 2

    archives: list[Path] = []
    for f in chosen:
        url = f.get("links", {}).get("self")
        key = f.get("key")
        size = f.get("size")
        checksum = f.get("checksum", "")
        md5 = checksum.split("md5:", 1)[1] if checksum.startswith("md5:") else None
        log(f"Downloading {key} ({human(size)}) from {url}")
        p = download_resumable(session, url, raw / key, expected_size=size, expected_md5=md5)
        archives.append(p)

    if args.no_extract:
        log("--no-extract: stopping after download.")
        return 0

    for a in archives:
        if a.suffix.lower() == ".zip":
            extract(a, raw)

    log("HaN-Seg fetch complete.")
    log(f"Next: python tools/datasets/nrrd_to_dicom.py   (converts CT NRRD -> DICOM CT series)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
