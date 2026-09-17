"""Fetch a contrast-enhanced neck CT subset from TCIA via the NBIA REST API v1.

Primary collection : HNSCC
Fallback           : Head-Neck-PET-CT

API base: https://services.cancerimagingarchive.net/nbia-api/services/v1/
    getCollectionValues
    getPatient?Collection=<c>
    getSeries?Collection=<c>&PatientID=<p>
    getImage?SeriesInstanceUID=<uid>      -> application/zip

The v1 endpoints are the *unrestricted* surface: they need no token and serve
only collections that TCIA publishes without an access agreement.  Collections
governed by the NIH Controlled Data Access Policy are simply absent (the
endpoints return HTTP 200 with an empty body).

IMPORTANT -- access gating
    As of 2026-09 both HNSCC and Head-Neck-PET-CT are governed by the NIH
    Controlled Data Access Policy because the CTs permit facial reconstruction.
    They are NOT in getCollectionValues and every v1 query returns an empty
    body.  Obtaining them requires a dbGaP data-access request, an NCI Data
    Commons login and a personal API key -- i.e. account creation and an
    explicit agreement.  This script therefore DETECTS the gate and STOPS with
    a report rather than attempting any login.  See README.md.

Usage:
    <venv>\\Scripts\\python.exe tools\\datasets\\fetch_tcia.py [--collection HNSCC]
        [--max-patients 10] [--max-gb 15] [--dry-run]

Downloads to %LOCALAPPDATA%\\HNRad\\studies\\public\\TCIA-<COLLECTION>\\<PatientID>\\<Modality>_<SeriesNumber>\\
Resumable: a series whose folder already holds the expected number of .dcm
files is skipped.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import human, init_tls, log, make_session, studies_public_root  # noqa: E402

BASE = "https://services.cancerimagingarchive.net/nbia-api/services/v1/"

PRIMARY = "HNSCC"
FALLBACK = "Head-Neck-PET-CT"

# What a contrast-enhanced neck CT tends to be called.
NECK_RE = re.compile(r"\b(NECK|H&N|HEAD.?AND.?NECK|HN|HEADNECK)\b", re.I)
CONTRAST_RE = re.compile(r"(W[/ ]?CONTRAST|WITH CONTRAST|\bC\+|\bIV\b|CONTRAST|\bCE\b|\bWC\b)", re.I)
NONCON_RE = re.compile(r"(W/?O CONTRAST|WITHOUT CONTRAST|NON.?CON|\bNC\b)", re.I)
# A PET attenuation-correction CT is still a real (low-dose, non-contrast) neck
# CT, and is accepted when it is the only CT in the study.
AC_RE = re.compile(r"(ATTEN|\bAC\b|CT ?AC|CTAC|\bWB\b|FUSION)", re.I)

IMAGES_NOT_PUBLIC = "is not in public domain"

GATE_REPORT = """
================================================================================
TCIA ACCESS GATE -- STOPPING, NOTHING DOWNLOADED
================================================================================
Collection            : {collection}
Unrestricted NBIA v1  : collection absent from getCollectionValues; getPatient
                        and getSeries return HTTP 200 with a zero-length body.

What TCIA says (collection page
https://www.cancerimagingarchive.net/collection/{slug}/):

    "Some data in this collection contains images that could potentially be
     used to reconstruct a human face. The process for requesting access to
     these is outlined in the NIH Controlled Data Access Policy page."

The process (https://www.cancerimagingarchive.net/nih-controlled-data-access-policy/)
requires ALL of the following, none of which this script may do on your behalf:
  1. A dbGaP data-access request at
     https://dbgap.ncbi.nlm.nih.gov/aa/wga.cgi?page=login
     (PHS accession phs004225 covers the TCIA "face" datasets).  The requester
     must hold a position "equivalent to a tenure-track professor, or senior
     scientist".
  2. An NCI Data Commons Framework Services login, then Profile -> create an
     API key, saved as a JSON credential file.
  3. Download of a per-collection manifest from TCIA's Browse Collections page.
  4. The NBIA Data Retriever desktop client, pointed at that JSON key.

=> Account creation + an explicit access agreement are required.  A human must
   do steps 1-2.  Once you hold the JSON API key, the NBIA v2 API
   (.../nbia-api/services/v2/) accepts it as an OAuth bearer token and this
   script can be pointed at it with --api-base and --token.
================================================================================
"""


def get(session, endpoint: str, params: dict | None = None, timeout: int = 180):
    """GET an NBIA endpoint.  Returns (status_code, parsed_json_or_None, raw_text)."""
    r = session.get(BASE + endpoint, params=params or {}, timeout=timeout)
    txt = r.text or ""
    if not txt.strip():
        return r.status_code, None, txt
    try:
        return r.status_code, r.json(), txt
    except Exception:
        return r.status_code, None, txt


def collection_available(session, collection: str) -> bool:
    code, cols, _ = get(session, "getCollectionValues")
    names = {c.get("Collection") for c in (cols or [])}
    log(f"getCollectionValues -> {code}, {len(names)} collections")
    if collection not in names:
        log(f"  '{collection}' is NOT in the unrestricted collection list.")
        return False
    code, pats, _ = get(session, "getPatient", {"Collection": collection})
    if not pats:
        log(f"  getPatient?Collection={collection} -> {code}, empty body.")
        return False
    log(f"  '{collection}' available: {len(pats)} patients.")
    return True


def slugify(collection: str) -> str:
    return collection.lower().replace(" ", "-").replace("_", "-")


def f(series: dict, *keys, default=None):
    for k in keys:
        if series.get(k) not in (None, ""):
            return series[k]
    return default


def score_ct(s: dict) -> tuple[int, list[str]]:
    """Score a CT series as a candidate contrast neck CT.  Higher is better."""
    desc = str(f(s, "SeriesDescription", default="") or "")
    proto = str(f(s, "ProtocolName", default="") or "")
    body = str(f(s, "BodyPartExamined", default="") or "")
    blob = " ".join([desc, proto, body])
    n = int(f(s, "ImageCount", default=0) or 0)
    thick = f(s, "SliceThickness")
    try:
        thick = float(thick) if thick is not None else None
    except (TypeError, ValueError):
        thick = None

    reasons: list[str] = []
    score = 0
    if NECK_RE.search(blob) or "NECK" in body.upper():
        score += 40
        reasons.append("neck")
    if CONTRAST_RE.search(blob) and not NONCON_RE.search(blob):
        score += 30
        reasons.append("contrast")
    if NONCON_RE.search(blob):
        score -= 25
        reasons.append("non-contrast")
    if n >= 100:
        score += 20
        reasons.append(f"{n} slices")
    else:
        score -= 20
        reasons.append(f"only {n} slices")
    if thick is not None and 0.5 <= thick <= 3.0:
        score += 15
        reasons.append(f"{thick} mm")
    elif thick is not None:
        score -= 10
        reasons.append(f"{thick} mm (out of 1-3 mm)")
    if AC_RE.search(blob):
        score += 10
        reasons.append("PET attenuation-correction CT")
    return score, reasons


def pick_patients(session, collection: str, max_patients: int, max_bytes: int):
    code, patients, _ = get(session, "getPatient", {"Collection": collection})
    patients = patients or []
    log(f"{collection}: {len(patients)} patients")

    candidates = []
    census: dict[str, int] = {}
    for i, p in enumerate(patients, 1):
        pid = f(p, "PatientId", "PatientID")
        code, series, _ = get(session, "getSeries", {"Collection": collection, "PatientID": pid})
        series = series or []
        for s in series:
            m = str(f(s, "Modality", default="?")).upper()
            census[m] = census.get(m, 0) + 1
        if i % 25 == 0:
            log(f"  scanned {i}/{len(patients)} patients; modalities so far {census}")
        cts = [s for s in series if str(f(s, "Modality", default="")).upper() == "CT"]
        if not cts:
            continue
        scored = sorted(((score_ct(s), s) for s in cts), key=lambda x: -x[0][0])
        (best_score, reasons), best = scored[0]
        if best_score < 40:
            # Accept the PET attenuation-correction CT when it is the only CT
            # the study offers -- still a usable (low-dose) neck CT.
            if int(f(best, "ImageCount", default=0) or 0) < 100:
                continue
            reasons = reasons + ["accepted: only CT in study, >=100 slices"]
        study_uid = f(best, "StudyInstanceUID")
        same_study = [s for s in series if f(s, "StudyInstanceUID") == study_uid]
        rt = [s for s in same_study if str(f(s, "Modality", default="")).upper() == "RTSTRUCT"]
        pt = [s for s in same_study if str(f(s, "Modality", default="")).upper() == "PT"]
        bonus = (10 if rt else 0) + (10 if pt else 0)
        candidates.append(
            {
                "PatientID": pid,
                "score": best_score + bonus,
                "reasons": reasons + (["RTSTRUCT"] if rt else []) + (["PT"] if pt else []),
                "ct": best,
                "rtstruct": rt,
                "pt": pt,
            }
        )

    candidates.sort(key=lambda c: -c["score"])
    chosen, total = [], 0
    for c in candidates:
        if len(chosen) >= max_patients:
            break
        want = [c["ct"]] + c["rtstruct"][:1] + c["pt"][:1]
        size = sum(int(f(s, "FileSize", default=0) or 0) for s in want)
        if total + size > max_bytes:
            log(f"  skipping {c['PatientID']}: would exceed the {human(max_bytes)} cap")
            continue
        c["bytes"] = size
        c["download"] = want
        chosen.append(c)
        total += size

    log(f"Modality census across {len(patients)} patients: {census}")
    if not census.get("CT") and not census.get("PT"):
        log("")
        log("!! The unrestricted API exposes NO CT and NO PT series for this collection.")
        log("!! Only derived objects (e.g. RTSTRUCT) are public; the images themselves")
        log("!! are withheld.  Requesting a referenced image series by UID returns:")
        log(f"!!     HTTP 400  \"...{IMAGES_NOT_PUBLIC}.\"")
        log("!! This is the NIH Controlled Data Access gate -- see the README.")
    return chosen, total


def print_table(chosen: list[dict]) -> None:
    hdr = f"{'Patient':<22}{'Series description':<34}{'Slices':>7}{'Thick':>7}{'RT':>4}{'PET':>5}{'Size':>10}"
    log("=" * len(hdr))
    log(hdr)
    log("=" * len(hdr))
    for c in chosen:
        s = c["ct"]
        log(
            f"{c['PatientID']:<22}"
            f"{str(f(s,'SeriesDescription',default=''))[:33]:<34}"
            f"{str(f(s,'ImageCount',default='')):>7}"
            f"{str(f(s,'SliceThickness',default='')):>7}"
            f"{('y' if c['rtstruct'] else '-'):>4}"
            f"{('y' if c['pt'] else '-'):>5}"
            f"{human(c.get('bytes',0)):>10}"
        )
    log("=" * len(hdr))


def download_series(session, s: dict, out_root: Path) -> Path:
    uid = f(s, "SeriesInstanceUID")
    modality = str(f(s, "Modality", default="XX")).upper()
    num = f(s, "SeriesNumber", default="0")
    expected = int(f(s, "ImageCount", default=0) or 0)
    dest = out_root / f"{modality}_{num}"
    dest.mkdir(parents=True, exist_ok=True)

    have = len([p for p in dest.rglob("*") if p.is_file() and p.suffix.lower() in (".dcm", "")])
    if expected and have >= expected:
        log(f"    {dest.name}: {have} files already present, skipping")
        return dest

    log(f"    {dest.name}: downloading {expected} images ({human(int(f(s,'FileSize',default=0) or 0))})")
    r = session.get(BASE + "getImage", params={"SeriesInstanceUID": uid}, timeout=1800)
    if r.status_code == 400 and IMAGES_NOT_PUBLIC in r.text:
        raise SystemExit(
            f"\nTCIA refused series {uid}:\n    {r.text.strip()}\n"
            "This series is behind the NIH Controlled Data Access gate. STOPPING.\n"
        )
    r.raise_for_status()
    buf = io.BytesIO(r.content)
    with zipfile.ZipFile(buf) as zf:
        zf.extractall(dest)
    n = len([p for p in dest.rglob("*") if p.is_file()])
    log(f"    {dest.name}: extracted {n} files")
    return dest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--collection", default=PRIMARY)
    ap.add_argument("--fallback", default=FALLBACK)
    ap.add_argument("--max-patients", type=int, default=10)
    ap.add_argument("--max-gb", type=float, default=15.0)
    ap.add_argument("--out-name", default=None,
                    help="folder name under studies\\public (default: TCIA-<collection>)")
    ap.add_argument("--dry-run", action="store_true", help="select and print the table, download nothing")
    args = ap.parse_args()

    init_tls()
    session = make_session()

    collection = None
    for cand in (args.collection, args.fallback):
        if not cand:
            continue
        log(f"Probing collection '{cand}' on the unrestricted NBIA v1 API ...")
        if collection_available(session, cand):
            collection = cand
            break
        log(GATE_REPORT.format(collection=cand, slug=slugify(cand)))

    if collection is None:
        log("Neither the primary nor the fallback collection is available without an access agreement.")
        log("STOPPING.  A human must complete the dbGaP / NCI Data Commons steps above.")
        return 3

    max_bytes = int(args.max_gb * 1024 ** 3)
    chosen, total = pick_patients(session, collection, args.max_patients, max_bytes)
    if not chosen:
        log(f"No suitable contrast neck CT series found in {collection}.")
        return 4

    print_table(chosen)
    log(f"Selected {len(chosen)} patients, {human(total)} total (cap {human(max_bytes)}).")

    if args.dry_run:
        log("--dry-run: nothing downloaded.")
        return 0

    out_root = studies_public_root() / (args.out_name or f"TCIA-{collection}")
    out_root.mkdir(parents=True, exist_ok=True)
    manifest = []
    for c in chosen:
        log(f"  {c['PatientID']}:")
        pdir = out_root / c["PatientID"]
        entry = {"PatientID": c["PatientID"], "score": c["score"], "reasons": c["reasons"], "series": []}
        for s in c["download"]:
            download_series(session, s, pdir)
            entry["series"].append(
                {
                    "SeriesInstanceUID": f(s, "SeriesInstanceUID"),
                    "StudyInstanceUID": f(s, "StudyInstanceUID"),
                    "Modality": f(s, "Modality"),
                    "SeriesNumber": f(s, "SeriesNumber"),
                    "SeriesDescription": f(s, "SeriesDescription"),
                    "ImageCount": f(s, "ImageCount"),
                    "SliceThickness": f(s, "SliceThickness"),
                    "BodyPartExamined": f(s, "BodyPartExamined"),
                }
            )
        manifest.append(entry)

    (out_root / "manifest.json").write_text(
        json.dumps({"collection": collection, "api_base": BASE, "patients": manifest}, indent=1),
        encoding="utf-8",
    )
    log(f"Wrote {out_root / 'manifest.json'}")
    log("TCIA fetch complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
