"""Benchmark harness: wall time and peak RAM for one AI job.

Run with the **app** venv (it only uses hnrad + SimpleITK; the model itself
runs in the inference venv as a subprocess, exactly as the server does it)::

    backend\\.venv\\Scripts\\python.exe ai/bench.py --series <uid> \\
        --model totalseg --tasks headneck_bones_vessels

Peak RAM is the peak *working set* of the inference subprocess tree, sampled
from the Windows job/process API via ctypes so no psutil dependency is needed.
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hnrad import ai                                        # noqa: E402


class _PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", wt.DWORD),
        ("PageFaultCount", wt.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


class _PROCESSENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD),
        ("cntUsage", wt.DWORD),
        ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD),
        ("th32ParentProcessID", wt.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wt.DWORD),
        ("szExeFile", ctypes.c_char * 260),
    ]


def _working_set_mb(pid: int) -> float:
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    PROCESS_VM_READ = 0x0010
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
                        False, int(pid))
    if not h:
        return 0.0
    try:
        counters = _PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(counters)
        if not psapi.GetProcessMemoryInfo(h, ctypes.byref(counters),
                                          counters.cb):
            return 0.0
        return counters.PeakWorkingSetSize / (1024.0 * 1024.0)
    finally:
        k32.CloseHandle(h)


def _descendants(root_pid: int) -> list[int]:
    """Every live descendant of *root_pid*, plus itself.

    The direct child we launch is often a tiny launcher shim, so measuring it
    alone reports a few megabytes while the real model sits in a grandchild.
    """
    TH32CS_SNAPPROCESS = 0x00000002
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == -1:
        return [root_pid]
    parents: dict[int, int] = {}
    try:
        entry = _PROCESSENTRY32()
        entry.dwSize = ctypes.sizeof(entry)
        ok = k32.Process32First(snap, ctypes.byref(entry))
        while ok:
            parents[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
            ok = k32.Process32Next(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)

    out = {int(root_pid)}
    for _ in range(8):                       # depth-limited transitive closure
        grew = False
        for pid, parent in parents.items():
            if parent in out and pid not in out:
                out.add(pid)
                grew = True
        if not grew:
            break
    return sorted(out)


def _tree_working_set_mb(root_pid: int) -> float:
    return sum(_working_set_mb(p) for p in _descendants(root_pid))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--series", required=True)
    ap.add_argument("--model", default="totalseg")
    ap.add_argument("--tasks", nargs="*", default=None)
    ap.add_argument("--roi-subset", nargs="*", default=None)
    ap.add_argument("--fast", action="store_true")
    ap.add_argument("--no-cache", action="store_true",
                    help="delete the cached result first so the model really runs")
    args = ap.parse_args()

    if args.no_cache:
        cdir = ai.cache_dir(args.series, args.model)
        if cdir.exists():
            import shutil
            shutil.rmtree(cdir, ignore_errors=True)
            print("cleared cache %s" % cdir)

    # Run the job on this thread instead of the worker so the timing is ours.
    ai.JOBS.autostart = False
    job = ai.JOBS.submit(args.series, args.model, tasks=args.tasks,
                         roi_subset=args.roi_subset, fast=args.fast)
    print("job %s: %s %s fast=%s" % (job.job_id, job.model, job.tasks, job.fast),
          flush=True)

    peak = {"mb": 0.0}
    stop = threading.Event()

    seen = {"n": 0}

    def sampler() -> None:
        while not stop.wait(0.5):
            proc = job._proc
            if proc is not None and proc.poll() is None:
                peak["mb"] = max(peak["mb"], _tree_working_set_mb(proc.pid))
            lines = list(job.log)
            for line in lines[seen["n"]:]:
                print("   | %s" % line, flush=True)
            seen["n"] = len(lines)

    t = threading.Thread(target=sampler, daemon=True)
    t.start()
    t0 = time.perf_counter()
    ai.JOBS.run_job(job)
    wall = time.perf_counter() - t0
    stop.set()
    t.join(timeout=2)

    out = {
        "series": args.series,
        "model": args.model,
        "tasks": job.tasks,
        "fast": job.fast,
        "roi_subset": job.roi_subset,
        "status": job.status,
        "error": job.error,
        "cached": job.cached,
        "wall_seconds": round(wall, 1),
        "peak_rss_mb": round(peak["mb"], 0),
        "n_structures": len(job.structures or []),
        "structures": [(s["name"], s["n_voxels"], round(s["volume_ml"], 2))
                       for s in (job.structures or [])],
    }
    print(json.dumps(out, indent=2))
    if job.status != "done":
        print("\n--- log tail ---")
        for line in job.log:
            print(" ", line)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
