"""Shared helpers for the hnrad public-dataset fetchers.

Corporate-proxy notes (KP workstation):
  * TLS is intercepted, so the default certifi bundle rejects the proxy CA.
    ``truststore.inject_into_ssl()`` makes Python use the Windows certificate
    store instead, which *does* contain the proxy CA.  Call :func:`init_tls`
    before any HTTPS traffic.
  * No admin rights are needed for any of this; everything is user-level.
"""

from __future__ import annotations

import hashlib
import os
import sys
import time
from pathlib import Path

__all__ = [
    "init_tls",
    "log",
    "human",
    "local_appdata",
    "datasets_root",
    "studies_public_root",
    "download_resumable",
    "md5_file",
]


def init_tls() -> None:
    """Route SSL verification through the Windows cert store (TLS interception)."""
    try:
        import truststore

        truststore.inject_into_ssl()
    except Exception as exc:  # pragma: no cover - best effort
        log(f"WARNING: truststore unavailable ({exc}); using default CA bundle")


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024.0:
            return f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} PB"


def local_appdata() -> Path:
    p = os.environ.get("LOCALAPPDATA")
    if not p:
        raise RuntimeError("LOCALAPPDATA is not set; this script targets Windows.")
    return Path(p)


def datasets_root() -> Path:
    """%LOCALAPPDATA%\\HNRad\\datasets -- raw archives, never OneDrive."""
    return local_appdata() / "HNRad" / "datasets"


def studies_public_root() -> Path:
    """%LOCALAPPDATA%\\HNRad\\studies\\public -- what the backend indexes."""
    return local_appdata() / "HNRad" / "studies" / "public"


def md5_file(path: Path, chunk: int = 4 << 20) -> str:
    h = hashlib.md5()
    with open(path, "rb") as fh:
        while True:
            b = fh.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def download_resumable(
    session,
    url: str,
    dest: Path,
    expected_size: int | None = None,
    expected_md5: str | None = None,
    chunk: int = 4 << 20,
    timeout: int = 120,
) -> Path:
    """Download ``url`` to ``dest``, resuming a partial file via HTTP Range.

    Idempotent: if ``dest`` already exists with ``expected_size`` bytes (and the
    md5 matches when supplied) nothing is transferred.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)

    if dest.exists() and expected_size is not None and dest.stat().st_size == expected_size:
        if expected_md5:
            log(f"  {dest.name}: present, verifying md5 ...")
            got = md5_file(dest)
            if got == expected_md5:
                log(f"  {dest.name}: already complete and verified, skipping")
                return dest
            log(f"  {dest.name}: md5 mismatch ({got} != {expected_md5}), re-downloading")
            dest.unlink()
        else:
            log(f"  {dest.name}: already complete ({human(expected_size)}), skipping")
            return dest

    have = dest.stat().st_size if dest.exists() else 0
    if expected_size is not None and have > expected_size:
        log(f"  {dest.name}: local file larger than expected, restarting")
        dest.unlink()
        have = 0

    headers = {}
    mode = "wb"
    if have:
        headers["Range"] = f"bytes={have}-"
        mode = "ab"
        log(f"  {dest.name}: resuming at {human(have)}")

    with session.get(url, headers=headers, stream=True, timeout=timeout) as r:
        if have and r.status_code == 200:
            # Server ignored the Range header -> start over.
            log(f"  {dest.name}: server ignored Range, restarting from 0")
            have, mode = 0, "wb"
        elif have and r.status_code != 206:
            r.raise_for_status()
        r.raise_for_status()

        total = expected_size
        if total is None:
            cl = r.headers.get("Content-Length")
            total = (int(cl) + have) if cl else None

        done = have
        t0 = time.time()
        last = 0.0
        with open(dest, mode) as fh:
            for block in r.iter_content(chunk_size=chunk):
                if not block:
                    continue
                fh.write(block)
                done += len(block)
                now = time.time()
                if now - last > 5:
                    last = now
                    rate = (done - have) / max(now - t0, 1e-6)
                    pct = f"{100.0 * done / total:5.1f}%" if total else "  ?  "
                    eta = ""
                    if total and rate > 0:
                        eta = f" eta {int((total - done) / rate) // 60}m{int((total - done) / rate) % 60:02d}s"
                    print(
                        f"    {dest.name}: {pct} {human(done)}"
                        f"{'/' + human(total) if total else ''} @ {human(rate)}/s{eta}",
                        flush=True,
                    )

    size = dest.stat().st_size
    log(f"  {dest.name}: done, {human(size)}")
    if expected_size is not None and size != expected_size:
        raise RuntimeError(f"{dest}: size {size} != expected {expected_size}")
    if expected_md5:
        log(f"  {dest.name}: verifying md5 ...")
        got = md5_file(dest)
        if got != expected_md5:
            raise RuntimeError(f"{dest}: md5 {got} != expected {expected_md5}")
        log(f"  {dest.name}: md5 ok")
    return dest


def make_session():
    import requests

    s = requests.Session()
    s.headers.update({"User-Agent": "hnrad-dataset-fetcher/1.0 (local research viewer)"})
    return s
