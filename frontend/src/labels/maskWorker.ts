/**
 * Mask decode worker.
 *
 * A 512 × 512 × 180 uint8 mask is ~47 MB once inflated. Doing that on the main
 * thread stalls rendering for hundreds of milliseconds, so the fetch and the
 * gzip inflate both happen here and only the finished buffer is transferred
 * back (zero copy).
 *
 * The backend deliberately does not set Content-Encoding, so nothing
 * decompresses the body on the way in — we do it ourselves.
 */

export interface MaskWorkerRequest {
  token: number;
  url: string;
}

export interface MaskWorkerResponse {
  token: number;
  ok: boolean;
  error?: string;
  /** Raw response headers we care about, verbatim. */
  headers?: Record<string, string>;
  buffer?: ArrayBuffer;
}

const HEADERS = ['x-shape', 'x-spacing', 'x-origin', 'x-direction', 'x-label-id', 'x-series-uid'];

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<MaskWorkerRequest>) => void) | null;
  postMessage: (msg: MaskWorkerResponse, transfer?: Transferable[]) => void;
};

ctx.onmessage = (e: MessageEvent<MaskWorkerRequest>) => {
  const { token, url } = e.data ?? { token: 0, url: '' };
  void (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`mask request failed: ${res.status} ${res.statusText}`);
      }
      const headers: Record<string, string> = {};
      for (const h of HEADERS) {
        const v = res.headers.get(h);
        if (v !== null) headers[h] = v;
      }
      if (!res.body) throw new Error('mask response had no body');
      const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
      const buffer = await new Response(stream).arrayBuffer();
      ctx.postMessage({ token, ok: true, headers, buffer }, [buffer]);
    } catch (err) {
      ctx.postMessage({ token, ok: false, error: (err as Error)?.message ?? String(err) });
    }
  })();
};
