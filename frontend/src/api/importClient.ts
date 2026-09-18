/**
 * Drag-and-drop / folder-picker import for the study browser.
 *
 * The v0.1 import flow asks the user to type a path that the *backend* can
 * see (`POST /api/import`). That is fine when the studies live on the same
 * box, and useless when a radiologist drags a folder off a USB stick into the
 * browser. This module covers the other half: walk what was dropped, ship the
 * bytes to `POST /api/import/upload`, then ask the backend to index the copy
 * it just made.
 *
 * Two deliberate shapes here:
 *
 * - **404 is a state, not an error.** Neither `/api/import/upload` nor
 *   `/api/import/pick-folder` exists in the shipped backend yet. A build
 *   without them must degrade to "this build can't do drag-and-drop, use the
 *   typed path" — a caption in the drop zone, not a red toast and certainly
 *   not an unhandled rejection. So every public function here *resolves* with
 *   a reportable state; none of them reject on a routine backend answer.
 *
 * - **Not the `req` helper from ./client.** `req` sets
 *   `Content-Type: application/json` (which would destroy the multipart
 *   boundary the browser must choose) and arms a 30 s timeout (which a 48 MB
 *   batch over a slow link will blow through). Uploads therefore call `fetch`
 *   directly, with no timeout and only the caller's AbortSignal.
 *
 * No React, no zustand, no DOM globals beyond File/DataTransfer — every
 * optional API is feature-checked so the module imports cleanly under
 * vitest's node environment.
 */

import type { ImportResult } from './client';

/* ------------------------------------------------------------------ */
/* Minimal typings for the non-standard entries API                    */
/* ------------------------------------------------------------------ */

/**
 * TypeScript's built-in `FileSystemEntry` family is incomplete (no `file()`,
 * no `createReader()` on the union, and `webkitGetAsEntry` is typed as
 * returning the bare base type), so declare the slice we actually touch.
 * Everything here is the callback-era WebKit API, not the Promise-based
 * File System Access API.
 */
interface FsEntry {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
  /** Absolute within the drop, e.g. `/CT NECK/SER001/IM0001`. */
  readonly fullPath: string;
}

interface FsFileEntry extends FsEntry {
  file(onSuccess: (f: File) => void, onError?: (e: unknown) => void): void;
}

interface FsDirectoryReader {
  readEntries(onSuccess: (entries: FsEntry[]) => void, onError?: (e: unknown) => void): void;
}

interface FsDirectoryEntry extends FsEntry {
  createReader(): FsDirectoryReader;
}

/** The bits of `DataTransferItem` we probe for, all optional. */
interface EntryCapableItem {
  readonly kind?: string;
  webkitGetAsEntry?: () => FsEntry | null;
  getAsFile?: () => File | null;
}

/* ------------------------------------------------------------------ */
/* Walking a drop                                                      */
/* ------------------------------------------------------------------ */

export interface DroppedFile {
  file: File;
  /** forward-slash path relative to the dropped root */
  path: string;
}

export interface WalkResult {
  files: DroppedFile[];
  rootName: string;
  truncated: boolean;
}

/** A whole-body CT plus priors is ~100k instances; 200k is a sane ceiling. */
export const MAX_FILES = 200_000;

/** Fallback label when the drop was not one tidy folder. */
const LOOSE_ROOT = 'dropped files';

/** Bookkeeping files that are never DICOM. `DICOMDIR` deliberately is not one. */
const NEVER_DICOM = new Set(['thumbs.db', 'desktop.ini']);

/**
 * Dot-files (`.DS_Store`, `.Trashes`, `._IM0001` AppleDouble stubs) and the
 * Windows/macOS folder bookkeeping above are skipped. `DICOMDIR` is *kept* —
 * it is a real DICOM file and the indexer reads it.
 */
function skipName(name: string): boolean {
  if (!name) return true;
  if (name.startsWith('.')) return true;
  return NEVER_DICOM.has(name.toLowerCase());
}

/** `fullPath` is absolute within the drop; the backend wants it root-relative. */
function relPathOf(entry: FsEntry, file: File): string {
  const full = entry.fullPath || '';
  if (full) return full.replace(/^\/+/, '').replace(/\\/g, '/');
  return file.webkitRelativePath || file.name;
}

function readEntriesOnce(reader: FsDirectoryReader): Promise<FsEntry[]> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (entries: FsEntry[]) => {
      if (settled) return;
      settled = true;
      resolve(entries);
    };
    try {
      reader.readEntries(
        (entries) => done(Array.isArray(entries) ? entries : []),
        () => done([]),
      );
    } catch {
      done([]);
    }
  });
}

function entryToFile(entry: FsFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (f: File | null) => {
      if (settled) return;
      settled = true;
      resolve(f);
    };
    try {
      entry.file(
        (f) => done(f ?? null),
        () => done(null),
      );
    } catch {
      done(null);
    }
  });
}

/**
 * Read a directory to exhaustion.
 *
 * **The whole reason this helper exists:** `FileSystemDirectoryReader.readEntries`
 * returns AT MOST ~100 entries per call (Chrome's limit; Safari's is similar)
 * and there is no `hasMore` flag. You must keep calling the *same* reader until
 * it hands back an empty array. Reading it once — the obvious implementation —
 * silently truncates every series over 100 instances, which is every series
 * that matters. See crbug.com/514087.
 */
async function drainDirectory(dir: FsDirectoryEntry): Promise<FsEntry[]> {
  let reader: FsDirectoryReader;
  try {
    reader = dir.createReader();
  } catch {
    return [];
  }
  const all: FsEntry[] = [];
  // Belt and braces: a reader that never empties would otherwise spin forever.
  for (let call = 0; call < 20_000; call++) {
    const chunk = await readEntriesOnce(reader);
    if (!chunk.length) break;
    for (const e of chunk) all.push(e);
  }
  return all;
}

/** Normalise a live `DataTransferItemList` or a plain array into an array. */
function itemsToArray(
  items: DataTransferItemList | DataTransferItem[] | null,
): EntryCapableItem[] {
  if (!items) return [];
  const out: EntryCapableItem[] = [];
  const len = items.length ?? 0;
  for (let i = 0; i < len; i++) {
    const it = (items as { [k: number]: DataTransferItem })[i];
    if (it) out.push(it as unknown as EntryCapableItem);
  }
  return out;
}

/** Report progress roughly every this many files, so the UI can count up. */
const COUNT_STRIDE = 200;

/**
 * Walk everything under a drop without reading a single byte of file content.
 *
 * `File` objects are lazy handles; we only ever ask for `size` and hand them
 * to `FormData`. A 40 GB drop costs no memory here.
 *
 * Aborting resolves with whatever was collected so far and `truncated: true` —
 * the caller gets a usable partial list rather than an exception.
 */
export async function walkDataTransfer(
  items: DataTransferItemList | DataTransferItem[] | null,
  opts?: { maxFiles?: number; signal?: AbortSignal; onCount?: (n: number) => void },
): Promise<WalkResult> {
  const maxFiles = Math.max(0, opts?.maxFiles ?? MAX_FILES);
  const signal = opts?.signal;
  const onCount = opts?.onCount;

  const files: DroppedFile[] = [];
  let truncated = false;
  let reported = 0;
  const tick = () => {
    if (onCount && files.length - reported >= COUNT_STRIDE) {
      reported = files.length;
      onCount(reported);
    }
  };

  /*
   * A `DataTransferItemList` is only valid for the duration of the drop
   * handler, so harvest every entry/file handle synchronously, before the
   * first await. Anything read later comes back null.
   */
  const roots: FsEntry[] = [];
  const loose: File[] = [];
  for (const item of itemsToArray(items)) {
    if (item.kind === 'string') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) {
      roots.push(entry);
      continue;
    }
    const f = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
    if (f) loose.push(f);
  }

  const rootName =
    roots.length === 1 && loose.length === 0 && roots[0].isDirectory ? roots[0].name : LOOSE_ROOT;

  const capped = () => {
    if (files.length >= maxFiles) {
      truncated = true;
      return true;
    }
    return false;
  };

  // Items dropped without an entries API (older Safari, some Firefox builds).
  for (const f of loose) {
    if (signal?.aborted) {
      truncated = true;
      break;
    }
    if (capped()) break;
    if (skipName(f.name)) continue;
    files.push({ file: f, path: f.webkitRelativePath || f.name });
    tick();
  }

  // Depth-first so one series arrives contiguously and batches stay coherent.
  const stack: FsEntry[] = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i]);

  while (stack.length) {
    if (signal?.aborted) {
      truncated = true;
      break;
    }
    if (capped()) break;

    const entry = stack.pop();
    if (!entry) break;
    if (skipName(entry.name)) continue;

    if (entry.isDirectory) {
      const kids = await drainDirectory(entry as FsDirectoryEntry);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    } else if (entry.isFile) {
      const f = await entryToFile(entry as FsFileEntry);
      if (f) {
        files.push({ file: f, path: relPathOf(entry, f) });
        tick();
      }
    }
  }

  if (onCount && files.length !== reported) onCount(files.length);
  return { files, rootName, truncated };
}

/**
 * `<input type="file" webkitdirectory>` fallback, for browsers (and locked-down
 * enterprise profiles) where the drop never yields entries. `webkitRelativePath`
 * is already root-relative with forward slashes, so the first segment is the
 * folder the user chose.
 */
export function filesFromInput(list: FileList | null): WalkResult {
  const files: DroppedFile[] = [];
  let truncated = false;
  let rootName = LOOSE_ROOT;
  const len = list?.length ?? 0;

  for (let i = 0; i < len; i++) {
    const f = list?.[i];
    if (!f) continue;
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    const path = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    const base = path.slice(path.lastIndexOf('/') + 1);
    if (skipName(base)) continue;
    if (rootName === LOOSE_ROOT && path.includes('/')) {
      const head = path.slice(0, path.indexOf('/'));
      if (head) rootName = head;
    }
    files.push({ file: f, path });
  }

  return { files, rootName, truncated };
}

/* ------------------------------------------------------------------ */
/* Batching                                                            */
/* ------------------------------------------------------------------ */

export interface Batch {
  files: DroppedFile[];
  bytes: number;
  index: number;
}

/** One request per ~300 instances keeps each POST well under a minute. */
export const BATCH_MAX_FILES = 300;
/** 48 MB: comfortably under the usual 64/100 MB proxy body limits. */
export const BATCH_MAX_BYTES = 48 * 1024 * 1024;

/**
 * Greedy fill: a file joins the current batch unless it would push the batch
 * past either cap. A single file bigger than `maxBytes` (an enhanced-MR
 * multiframe can be 300 MB) gets a batch to itself rather than being dropped —
 * skipping it would silently lose a whole study.
 */
export function planBatches(
  files: DroppedFile[],
  opts?: { maxFiles?: number; maxBytes?: number },
): Batch[] {
  const maxFiles = Math.max(1, opts?.maxFiles ?? BATCH_MAX_FILES);
  const maxBytes = Math.max(1, opts?.maxBytes ?? BATCH_MAX_BYTES);

  const batches: Batch[] = [];
  let current: DroppedFile[] = [];
  let bytes = 0;

  const close = () => {
    if (!current.length) return;
    batches.push({ files: current, bytes, index: batches.length });
    current = [];
    bytes = 0;
  };

  for (const f of files) {
    const size = f.file?.size ?? 0;
    if (current.length && (current.length + 1 > maxFiles || bytes + size > maxBytes)) close();
    current.push(f);
    bytes += size;
  }
  close();
  return batches;
}

/* ------------------------------------------------------------------ */
/* Upload + index                                                      */
/* ------------------------------------------------------------------ */

export interface ImportProgress {
  phase: 'scanning' | 'uploading' | 'indexing' | 'done' | 'error' | 'cancelled' | 'unsupported';
  filesTotal: number;
  filesSent: number;
  bytesTotal: number;
  bytesSent: number;
  batchIndex: number;
  batchCount: number;
  message?: string;
  /** Present once POST /api/import has answered. */
  result?: ImportResult;
  /** Where the backend put the copies. */
  storePath?: string;
}

export interface UploadOptions {
  name?: string;
  batchId?: string;
  signal?: AbortSignal;
  onProgress?: (p: ImportProgress) => void;
}

const NO_UPLOAD_ROUTE =
  'This backend build has no /api/import/upload route, so files cannot be sent from the ' +
  'browser. Importing by typed path or the Browse-folder button still works.';

const NO_PICKER_ROUTE =
  'This backend build has no /api/import/pick-folder route. Type the folder path instead.';

/**
 * `readErrorDetail` in ./client is module-private, so mirror it: the contract
 * says every error body is `{detail: string}`, but a proxy 502 or a FastAPI
 * 422 (list-shaped `detail`) can still land here.
 */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    const detail = body?.detail;
    if (typeof detail === 'string' && detail) return detail;
    if (Array.isArray(detail) && detail.length) {
      const first = detail[0] as { msg?: string } | undefined;
      if (first?.msg) return first.msg;
    }
    if (detail && typeof detail === 'object') return JSON.stringify(detail);
  } catch {
    /* non-JSON error body */
  }
  return `${res.status} ${res.statusText}`.trim();
}

function isAbort(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError';
}

/** `crypto.randomUUID` needs a secure context; 127.0.0.1 counts, file:// may not. */
function newBatchId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      /* fall through */
    }
  }
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface UploadAck {
  received?: number;
  bytes?: number;
  path?: string;
}

/**
 * Upload every batch, then ask the backend to index the copy.
 *
 * Resolves — never rejects — with the terminal `ImportProgress`. The same
 * object shape is fed to `onProgress` along the way, so a progress bar and the
 * final outcome read from one type.
 */
export async function uploadAndIndex(
  files: DroppedFile[],
  opts?: UploadOptions,
): Promise<ImportProgress> {
  const signal = opts?.signal;
  const batches = planBatches(files);
  const batchId = opts?.batchId || newBatchId();
  const name = opts?.name || LOOSE_ROOT;

  let progress: ImportProgress = {
    phase: 'uploading',
    filesTotal: files.length,
    filesSent: 0,
    bytesTotal: files.reduce((n, f) => n + (f.file?.size ?? 0), 0),
    bytesSent: 0,
    batchIndex: 0,
    batchCount: batches.length,
  };

  const emit = (patch: Partial<ImportProgress>): ImportProgress => {
    progress = { ...progress, ...patch };
    opts?.onProgress?.(progress);
    return progress;
  };

  // An empty drop must not fall through to `POST /api/import {}`, which would
  // re-index the entire studies root — a minutes-long surprise nobody asked for.
  if (!files.length) {
    return emit({ phase: 'error', message: 'Nothing to import — no files were found in the drop.' });
  }

  emit({});

  let storePath: string | undefined;

  for (const batch of batches) {
    if (signal?.aborted) return emit({ phase: 'cancelled', message: 'Import cancelled.' });

    const form = new FormData();
    for (const f of batch.files) {
      // Field order matters: `files[i]` pairs with `paths[][i]` on the server.
      form.append('files', f.file, f.file.name);
      form.append('paths[]', f.path);
    }
    form.append('batch_id', batchId);
    form.append('name', name);

    let res: Response;
    try {
      // No Content-Type header: the browser must add its own multipart
      // boundary. No timeout either — a 48 MB batch is allowed to take a while.
      res = await fetch('/api/import/upload', { method: 'POST', body: form, signal });
    } catch (e) {
      if (isAbort(e) || signal?.aborted) {
        return emit({ phase: 'cancelled', message: 'Import cancelled.' });
      }
      return emit({ phase: 'error', message: 'Backend unreachable during upload.' });
    }

    if (!res.ok) {
      // Only the *first* batch can diagnose a missing route. A 404 halfway
      // through means something else went wrong and deserves an error.
      if (res.status === 404 && batch.index === 0) {
        return emit({ phase: 'unsupported', message: NO_UPLOAD_ROUTE });
      }
      return emit({ phase: 'error', message: await errorDetail(res) });
    }

    let ack: UploadAck = {};
    try {
      ack = ((await res.json()) ?? {}) as UploadAck;
    } catch {
      /* a 200 with no body still counts as delivered */
    }
    if (typeof ack.path === 'string' && ack.path) storePath = ack.path;

    emit({
      phase: 'uploading',
      filesSent: progress.filesSent + batch.files.length,
      bytesSent: progress.bytesSent + batch.bytes,
      batchIndex: batch.index + 1,
      storePath,
    });
  }

  if (signal?.aborted) return emit({ phase: 'cancelled', message: 'Import cancelled.' });

  emit({ phase: 'indexing', message: 'Reading DICOM headers…' });

  let res: Response;
  try {
    res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(storePath ? { path: storePath } : {}),
      signal,
    });
  } catch (e) {
    if (isAbort(e) || signal?.aborted) {
      return emit({ phase: 'cancelled', message: 'Import cancelled.' });
    }
    return emit({ phase: 'error', message: 'Backend unreachable while indexing.' });
  }

  if (!res.ok) return emit({ phase: 'error', message: await errorDetail(res) });

  let result: ImportResult | undefined;
  try {
    result = (await res.json()) as ImportResult;
  } catch {
    /* indexed, but the body was unreadable */
  }
  return emit({ phase: 'done', result, message: undefined });
}

/* ------------------------------------------------------------------ */
/* Native folder picker                                                */
/* ------------------------------------------------------------------ */

export type PickFolderResult =
  | { path: string }
  | { cancelled: true }
  | { unsupported: true; message: string };

/**
 * Ask the backend to open a native folder dialog **on the server machine**.
 * That is the right dialog for Margin's localhost deployment (the studies live
 * where the indexer runs) and nonsense for anything remote — hence the
 * generous unsupported branch rather than a thrown error.
 */
export async function pickFolder(): Promise<PickFolderResult> {
  let res: Response;
  try {
    res = await fetch('/api/import/pick-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {
    return { unsupported: true, message: NO_PICKER_ROUTE };
  }

  if (!res.ok) {
    if (res.status === 404) return { unsupported: true, message: NO_PICKER_ROUTE };
    return { unsupported: true, message: await errorDetail(res) };
  }

  let body: { path?: unknown; cancelled?: unknown } = {};
  try {
    body = ((await res.json()) ?? {}) as { path?: unknown; cancelled?: unknown };
  } catch {
    return { unsupported: true, message: NO_PICKER_ROUTE };
  }

  if (body.cancelled === true) return { cancelled: true };
  if (typeof body.path === 'string' && body.path) return { path: body.path };
  return { unsupported: true, message: 'The folder dialog returned no path.' };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const KIB = 1024;

/**
 * 1024-based, integral up to KB and one decimal from MB — the progress line
 * reads `812 KB` / `1.4 MB` / `2.1 GB`, never `0.79 MB`.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (Math.round(n) < KIB) return `${Math.round(n)} B`;
  const kb = n / KIB;
  if (Math.round(kb) < KIB) return `${Math.round(kb)} KB`;
  const mb = kb / KIB;
  if (mb < KIB) return `${mb.toFixed(1)} MB`;
  const gb = mb / KIB;
  if (gb < KIB) return `${gb.toFixed(1)} GB`;
  return `${(gb / KIB).toFixed(1)} TB`;
}

/**
 * Thousands separators without `toLocaleString`, whose grouping character
 * follows the machine locale and would make `1 234` / `1.234` out of a count
 * the rest of the UI writes as `1,234`.
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(Math.abs(n));
  const grouped = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${grouped}` : grouped;
}
