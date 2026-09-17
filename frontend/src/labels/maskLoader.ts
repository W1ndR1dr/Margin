/**
 * Fetch + inflate a label mask without freezing the UI.
 *
 * The work happens in maskWorker.ts and the inflated buffer comes back by
 * transfer. If the worker cannot be constructed (older browser, module worker
 * blocked), the same job runs on the main thread — still streamed, so the
 * event loop gets a breath between chunks.
 */
import { analysis } from '../api/client';
import { parseMaskHeaders, voxelCount, type MaskGeometry } from './geometry';
import { MaskGeometryError } from './geometry';

export interface LoadedMask {
  geometry: MaskGeometry;
  /** One byte per voxel, C order `(k, j, i)` — i.e. i fastest, like vtk. */
  data: Uint8Array;
}

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;

interface Pending {
  resolve: (v: LoadedMask) => void;
  reject: (e: Error) => void;
}

const pending = new Map<number, Pending>();

interface WorkerReply {
  token: number;
  ok: boolean;
  error?: string;
  headers?: Record<string, string>;
  buffer?: ArrayBuffer;
}

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./maskWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const msg = e.data;
      const p = pending.get(msg.token);
      if (!p) return;
      pending.delete(msg.token);
      if (!msg.ok || !msg.buffer || !msg.headers) {
        p.reject(new Error(msg.error ?? 'the mask could not be decoded'));
        return;
      }
      try {
        p.resolve(finish(msg.headers, msg.buffer));
      } catch (err) {
        p.reject(err as Error);
      }
    };
    worker.onerror = () => {
      // Fail the whole queue once and fall back for every later request.
      workerBroken = true;
      const inflight = [...pending.values()];
      pending.clear();
      worker?.terminate();
      worker = null;
      inflight.forEach((p) => p.reject(new Error('the mask decode worker stopped')));
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

function finish(headers: Record<string, string>, buffer: ArrayBuffer): LoadedMask {
  const geometry = parseMaskHeaders(headers);
  const data = new Uint8Array(buffer);
  const want = voxelCount(geometry);
  if (data.length !== want) {
    throw new MaskGeometryError(
      `the mask has ${data.length} voxels but its header describes ${want} ` +
        `(${geometry.dimensions.join(' × ')})`,
    );
  }
  return { geometry, data };
}

/** Main-thread fallback: same streaming inflate, just without the worker. */
async function loadInline(url: string): Promise<LoadedMask> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mask request failed: ${res.status} ${res.statusText}`);
  const headers: Record<string, string> = {};
  ['x-shape', 'x-spacing', 'x-origin', 'x-direction', 'x-label-id', 'x-series-uid'].forEach((h) => {
    const v = res.headers.get(h);
    if (v !== null) headers[h] = v;
  });
  if (!res.body) throw new Error('mask response had no body');

  const reader = res.body.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      // Let the renderer breathe between chunks.
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return finish(headers, out.buffer as ArrayBuffer);
}

/** Download and inflate the mask of one label. */
export function loadMask(labelId: string): Promise<LoadedMask> {
  const url = analysis.maskUrl(labelId);
  const w = ensureWorker();
  if (!w) return loadInline(url);
  const token = ++seq;
  return new Promise<LoadedMask>((resolve, reject) => {
    pending.set(token, { resolve, reject });
    w.postMessage({ token, url });
  }).catch((e: Error) => {
    // A dead worker should not cost the user the structure.
    if (workerBroken) return loadInline(url);
    throw e;
  });
}
