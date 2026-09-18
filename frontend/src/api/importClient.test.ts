import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BATCH_MAX_BYTES,
  filesFromInput,
  formatBytes,
  formatCount,
  pickFolder,
  planBatches,
  uploadAndIndex,
  walkDataTransfer,
  type DroppedFile,
} from './importClient';

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

/** A File whose reported `size` is a lie, so byte-cap tests cost no memory. */
function fakeFile(name: string, size = 16, relPath?: string): File {
  const f = new File([new Uint8Array(Math.min(size, 16))], name);
  Object.defineProperty(f, 'size', { value: size });
  if (relPath !== undefined) Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
  return f;
}

function dropped(path: string, size = 16): DroppedFile {
  return { file: fakeFile(path.slice(path.lastIndexOf('/') + 1), size), path };
}

function fakeFileList(files: File[]): FileList {
  const list: Record<number | string, unknown> = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
  };
  files.forEach((f, i) => {
    list[i] = f;
  });
  return list as unknown as FileList;
}

interface FakeEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (ok: (f: File) => void) => void;
  createReader?: () => { readEntries: (ok: (e: FakeEntry[]) => void) => void };
}

function fileEntry(fullPath: string, size = 16): FakeEntry {
  const name = fullPath.slice(fullPath.lastIndexOf('/') + 1);
  const f = fakeFile(name, size);
  return { isFile: true, isDirectory: false, name, fullPath, file: (ok) => ok(f) };
}

/**
 * A directory whose reader hands back `chunks` one call at a time and then an
 * empty array — exactly how the real `readEntries` behaves (~100 max per call).
 */
function dirEntry(fullPath: string, chunks: FakeEntry[][], counter?: { n: number }): FakeEntry {
  const name = fullPath.slice(fullPath.lastIndexOf('/') + 1);
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath,
    createReader: () => {
      let i = 0;
      return {
        readEntries: (ok) => {
          if (counter) counter.n += 1;
          ok(i < chunks.length ? chunks[i++] : []);
        },
      };
    },
  };
}

function dtItem(entry: FakeEntry | null, loose?: File): DataTransferItem {
  return {
    kind: 'file',
    webkitGetAsEntry: () => entry,
    getAsFile: () => loose ?? null,
  } as unknown as DataTransferItem;
}

/* ---- fetch stubbing ---- */

interface Call {
  url: string;
  init?: RequestInit;
}

function stubFetch(
  handler: (url: string, init: RequestInit | undefined, call: number) => Response | Promise<Response>,
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return Promise.resolve(handler(url, init, calls.length - 1));
  });
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */

describe('planBatches', () => {
  it('closes a batch on the file-count cap', () => {
    const files = Array.from({ length: 7 }, (_, i) => dropped(`s/IM${i}`, 10));
    const batches = planBatches(files, { maxFiles: 3, maxBytes: 1_000_000 });
    expect(batches.map((b) => b.files.length)).toEqual([3, 3, 1]);
    expect(batches.map((b) => b.index)).toEqual([0, 1, 2]);
    expect(batches[0].bytes).toBe(30);
  });

  it('closes a batch on the byte cap', () => {
    const files = [dropped('a', 40), dropped('b', 40), dropped('c', 10)];
    const batches = planBatches(files, { maxFiles: 100, maxBytes: 85 });
    expect(batches).toHaveLength(2);
    expect(batches[0].files.map((f) => f.path)).toEqual(['a', 'b']);
    expect(batches[0].bytes).toBe(80);
    expect(batches[1].files.map((f) => f.path)).toEqual(['c']);
  });

  it('gives an oversized single file its own batch instead of dropping it', () => {
    const files = [dropped('small', 10), dropped('huge', 5_000), dropped('after', 10)];
    const batches = planBatches(files, { maxFiles: 100, maxBytes: 100 });
    expect(batches).toHaveLength(3);
    expect(batches[1].files.map((f) => f.path)).toEqual(['huge']);
    expect(batches[1].bytes).toBe(5_000);
    // nothing was lost
    expect(batches.flatMap((b) => b.files).map((f) => f.path)).toEqual(['small', 'huge', 'after']);
  });

  it('returns no batches for no files and defaults to the shipped caps', () => {
    expect(planBatches([])).toEqual([]);
    expect(planBatches([dropped('a', BATCH_MAX_BYTES + 1)])).toHaveLength(1);
  });
});

describe('formatBytes / formatCount', () => {
  it('formats byte counts 1024-based', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(812 * 1024)).toBe('812 KB');
    expect(formatBytes(1.4 * 1024 * 1024)).toBe('1.4 MB');
    expect(formatBytes(2.1 * 1024 * 1024 * 1024)).toBe('2.1 GB');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('never prints 1024 of a unit', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB');
  });

  it('groups counts in thousands', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatCount(-4200)).toBe('-4,200');
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('filesFromInput', () => {
  it('derives rootName from the first path segment', () => {
    const r = filesFromInput(
      fakeFileList([
        fakeFile('IM0001', 10, 'CT NECK/SER001/IM0001'),
        fakeFile('IM0002', 10, 'CT NECK/SER001/IM0002'),
      ]),
    );
    expect(r.rootName).toBe('CT NECK');
    expect(r.files.map((f) => f.path)).toEqual(['CT NECK/SER001/IM0001', 'CT NECK/SER001/IM0002']);
    expect(r.truncated).toBe(false);
  });

  it('falls back to "dropped files" for loose files and skips bookkeeping entries', () => {
    const r = filesFromInput(
      fakeFileList([
        fakeFile('IM0001'),
        fakeFile('.DS_Store'),
        fakeFile('Thumbs.db'),
        fakeFile('DICOMDIR'),
      ]),
    );
    expect(r.rootName).toBe('dropped files');
    expect(r.files.map((f) => f.path)).toEqual(['IM0001', 'DICOMDIR']);
  });

  it('handles a null FileList', () => {
    expect(filesFromInput(null)).toEqual({ files: [], rootName: 'dropped files', truncated: false });
  });
});

describe('walkDataTransfer', () => {
  it('drains a directory reader until it returns an empty array', async () => {
    const counter = { n: 0 };
    const dir = dirEntry(
      '/study',
      [
        [fileEntry('/study/IM0001'), fileEntry('/study/IM0002')],
        [fileEntry('/study/IM0003')],
      ],
      counter,
    );
    const r = await walkDataTransfer([dtItem(dir)]);
    // Reading once would have yielded 2 files and silently lost the third.
    expect(r.files).toHaveLength(3);
    expect(r.files.map((f) => f.path)).toEqual([
      'study/IM0001',
      'study/IM0002',
      'study/IM0003',
    ]);
    expect(counter.n).toBe(3); // two chunks plus the terminating empty read
    expect(r.rootName).toBe('study');
    expect(r.truncated).toBe(false);
  });

  it('recurses, strips the leading slash and skips dot-files but keeps DICOMDIR', async () => {
    const dir = dirEntry('/CT NECK', [
      [
        fileEntry('/CT NECK/DICOMDIR'),
        fileEntry('/CT NECK/.DS_Store'),
        fileEntry('/CT NECK/Thumbs.db'),
        dirEntry('/CT NECK/SER001', [[fileEntry('/CT NECK/SER001/IM0001')]]),
        dirEntry('/CT NECK/.Trashes', [[fileEntry('/CT NECK/.Trashes/junk')]]),
      ],
    ]);
    const r = await walkDataTransfer([dtItem(dir)]);
    expect(r.files.map((f) => f.path)).toEqual(['CT NECK/DICOMDIR', 'CT NECK/SER001/IM0001']);
    expect(r.rootName).toBe('CT NECK');
  });

  it('labels multi-item and loose drops "dropped files"', async () => {
    const a = dirEntry('/a', [[fileEntry('/a/1')]]);
    const b = dirEntry('/b', [[fileEntry('/b/1')]]);
    const multi = await walkDataTransfer([dtItem(a), dtItem(b)]);
    expect(multi.rootName).toBe('dropped files');
    expect(multi.files).toHaveLength(2);

    const loose = await walkDataTransfer([dtItem(null, fakeFile('IM0001'))]);
    expect(loose.rootName).toBe('dropped files');
    expect(loose.files.map((f) => f.path)).toEqual(['IM0001']);
  });

  it('caps at maxFiles and reports truncation', async () => {
    const kids = Array.from({ length: 10 }, (_, i) => fileEntry(`/s/IM${i}`));
    const r = await walkDataTransfer([dtItem(dirEntry('/s', [kids]))], { maxFiles: 4 });
    expect(r.files).toHaveLength(4);
    expect(r.truncated).toBe(true);
  });

  it('reports a live count roughly every 200 files', async () => {
    const mk = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => fileEntry(`/s/IM${from + i}`));
    const dir = dirEntry('/s', [mk(0, 100), mk(100, 100), mk(200, 50)]);
    const counts: number[] = [];
    const r = await walkDataTransfer([dtItem(dir)], { onCount: (n) => counts.push(n) });
    expect(r.files).toHaveLength(250);
    expect(counts).toEqual([200, 250]);
  });

  it('resolves with a partial, truncated result when aborted', async () => {
    const ctrl = new AbortController();
    const kids = Array.from({ length: 50 }, (_, i) => fileEntry(`/s/IM${i}`));
    const r = await walkDataTransfer([dtItem(dirEntry('/s', [kids]))], {
      signal: ctrl.signal,
      onCount: () => undefined,
      maxFiles: 50,
    });
    expect(r.files).toHaveLength(50);

    ctrl.abort();
    const after = await walkDataTransfer([dtItem(dirEntry('/s', [kids]))], { signal: ctrl.signal });
    expect(after.files).toHaveLength(0);
    expect(after.truncated).toBe(true);
  });

  it('accepts a null item list', async () => {
    const r = await walkDataTransfer(null);
    expect(r).toEqual({ files: [], rootName: 'dropped files', truncated: false });
  });
});

describe('uploadAndIndex', () => {
  it('uploads every batch then indexes the store path', async () => {
    const calls = stubFetch((url) =>
      url === '/api/import/upload'
        ? json({ received: 1, bytes: 40, path: 'C:/store/imp-1' })
        : json({ patients: 1, studies: 1, series: 3, instances: 250, skipped: 0, seconds: 4.2 }),
    );

    const files = [dropped('CT/IM1', 40), dropped('CT/IM2', 40)];
    const phases: string[] = [];
    const out = await uploadAndIndex(files, {
      name: 'CT',
      batchId: 'batch-123',
      onProgress: (p) => phases.push(p.phase),
    });

    expect(out.phase).toBe('done');
    expect(out.result?.instances).toBe(250);
    expect(out.storePath).toBe('C:/store/imp-1');
    expect(out.filesSent).toBe(2);
    expect(out.bytesSent).toBe(80);
    expect(out.bytesTotal).toBe(80);
    expect(phases).toContain('indexing');
    expect(phases[phases.length - 1]).toBe('done');

    // one upload (both files fit one batch) plus the index call
    expect(calls.map((c) => c.url)).toEqual(['/api/import/upload', '/api/import']);

    const form = calls[0].init?.body as FormData;
    expect(form.getAll('paths[]')).toEqual(['CT/IM1', 'CT/IM2']);
    expect(form.getAll('files')).toHaveLength(2);
    expect(form.get('batch_id')).toBe('batch-123');
    expect(form.get('name')).toBe('CT');
    // the browser must own the multipart boundary
    expect(calls[0].init?.headers).toBeUndefined();
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ path: 'C:/store/imp-1' });
  });

  it('reports "unsupported" — not a throw — when the first batch 404s', async () => {
    const calls = stubFetch(() => json({ detail: 'Not Found' }, 404));
    const out = await uploadAndIndex([dropped('CT/IM1', 40)]);
    expect(out.phase).toBe('unsupported');
    expect(out.message).toMatch(/no \/api\/import\/upload route/);
    expect(out.message).toMatch(/typed path or the Browse-folder button/);
    expect(calls).toHaveLength(1); // stopped immediately, never tried to index
  });

  it('reports the detail text for any other non-OK response', async () => {
    stubFetch(() => json({ detail: 'disk full' }, 400));
    const out = await uploadAndIndex([dropped('CT/IM1', 40)]);
    expect(out.phase).toBe('error');
    expect(out.message).toBe('disk full');
  });

  it('resolves cancelled when the signal aborts between batches', async () => {
    const ctrl = new AbortController();
    const calls = stubFetch(() => json({ received: 1, bytes: 1, path: 'C:/store/x' }));
    const files = [
      dropped('CT/IM1', BATCH_MAX_BYTES - 1),
      dropped('CT/IM2', BATCH_MAX_BYTES - 1),
    ];
    const out = await uploadAndIndex(files, {
      signal: ctrl.signal,
      onProgress: (p) => {
        if (p.batchIndex === 1) ctrl.abort();
      },
    });
    expect(out.phase).toBe('cancelled');
    expect(out.filesSent).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('refuses an empty drop rather than re-indexing the whole studies root', async () => {
    const calls = stubFetch(() => json({}));
    const out = await uploadAndIndex([]);
    expect(out.phase).toBe('error');
    expect(calls).toHaveLength(0);
  });

  it('resolves error, not a rejection, when the backend is unreachable', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const out = await uploadAndIndex([dropped('CT/IM1', 40)]);
    expect(out.phase).toBe('error');
    expect(out.message).toMatch(/unreachable/i);
  });
});

describe('pickFolder', () => {
  it('returns the chosen path', async () => {
    const calls = stubFetch(() => json({ path: 'D:/dicom/CT NECK' }));
    await expect(pickFolder()).resolves.toEqual({ path: 'D:/dicom/CT NECK' });
    expect(calls[0].url).toBe('/api/import/pick-folder');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('returns cancelled when the dialog was dismissed', async () => {
    stubFetch(() => json({ cancelled: true }));
    await expect(pickFolder()).resolves.toEqual({ cancelled: true });
  });

  it('returns unsupported on 404 and on a network failure', async () => {
    stubFetch(() => json({ detail: 'Not Found' }, 404));
    const notFound = await pickFolder();
    expect(notFound).toMatchObject({ unsupported: true });
    expect((notFound as { message: string }).message).toMatch(/pick-folder/);

    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const offline = await pickFolder();
    expect(offline).toMatchObject({ unsupported: true });
  });

  it('treats a body without a usable path as unsupported', async () => {
    stubFetch(() => json({ path: '' }));
    await expect(pickFolder()).resolves.toMatchObject({ unsupported: true });
  });
});
