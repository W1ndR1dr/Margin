/**
 * The manual reference bracket and the request it turns into.
 *
 * Pure: no Cornerstone, no store, so the slice arithmetic and the request
 * shape are unit testable on their own.
 */
import type { AirwayRequest, AirwayResult, Triple } from '../../api/client';

/** An inclusive slice bracket `[k0, k1]`, always sorted. */
export type KRange = [number, number];

/** Sort and round two slice indices into a bracket. */
export function normalizeRange(a: number, b: number): KRange {
  const k0 = Math.round(a);
  const k1 = Math.round(b);
  return k0 <= k1 ? [k0, k1] : [k1, k0];
}

export function sameRange(a: KRange | null, b: KRange | null): boolean {
  if (a === null || b === null) return a === b;
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * First and last profile sample whose slice falls inside the bracket, or null
 * when the bracket selects nothing (or the result predates `sample_k`).
 */
export function sampleSpan(sampleK: number[] | undefined, range: KRange | null): [number, number] | null {
  if (!sampleK || !range) return null;
  let lo = -1;
  let hi = -1;
  sampleK.forEach((k, i) => {
    if (k < range[0] || k > range[1]) return;
    if (lo < 0) lo = i;
    hi = i;
  });
  return lo < 0 ? null : [lo, hi];
}

/** The bracket covered by a span of profile samples (a drag on the chart). */
export function rangeFromSamples(
  sampleK: number[] | undefined,
  i0: number,
  i1: number,
): KRange | null {
  if (!sampleK || !sampleK.length) return null;
  const a = Math.max(0, Math.min(sampleK.length - 1, Math.round(Math.min(i0, i1))));
  const b = Math.max(0, Math.min(sampleK.length - 1, Math.round(Math.max(i0, i1))));
  const ks = sampleK.slice(a, b + 1);
  return normalizeRange(Math.min(...ks), Math.max(...ks));
}

/** Index of the profile sample nearest a slice, or null without `sample_k`. */
export function nearestSample(sampleK: number[] | undefined, k: number | null): number | null {
  if (!sampleK || !sampleK.length || k === null) return null;
  let best = 0;
  let bestD = Infinity;
  sampleK.forEach((v, i) => {
    const d = Math.abs(v - k);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

export interface AirwayInputs {
  seriesUid: string;
  seedIjk: Triple;
  glottisSlice: number | null;
  refRangeK: KRange | null;
  capAtGlottis: boolean;
}

/**
 * The request body for the inputs: `reference: 'manual'` plus the bracket
 * when one is set, `'auto'` otherwise; the glottis cap only when there is a
 * glottis to cap at.
 */
export function buildAirwayRequest(inp: AirwayInputs): AirwayRequest {
  const body: AirwayRequest = {
    series_uid: inp.seriesUid,
    seed_ijk: inp.seedIjk,
    glottis_slice: inp.glottisSlice,
    reference: inp.refRangeK ? 'manual' : 'auto',
  };
  if (inp.refRangeK) body.ref_range_k = normalizeRange(inp.refRangeK[0], inp.refRangeK[1]);
  if (inp.glottisSlice !== null && inp.capAtGlottis) body.cap_at_glottis = true;
  return body;
}

/** True when two requests would ask the backend for the same analysis. */
export function sameRequest(a: AirwayRequest | null, b: AirwayRequest | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.series_uid === b.series_uid &&
    (a.seed_ijk ?? []).join(',') === (b.seed_ijk ?? []).join(',') &&
    (a.glottis_slice ?? null) === (b.glottis_slice ?? null) &&
    (a.reference ?? 'auto') === (b.reference ?? 'auto') &&
    sameRange(a.ref_range_k ?? null, b.ref_range_k ?? null) &&
    (a.cap_at_glottis ?? false) === (b.cap_at_glottis ?? false)
  );
}

/** "slices 13 – 41" in the 1-based numbering the rest of the panel uses. */
export function rangeLabel(range: KRange): string {
  return `slices ${range[0] + 1} – ${range[1] + 1}`;
}

/**
 * Which reference the result card should say was used. Reads the backend's
 * echo when present and falls back to plain `auto` for older responses.
 */
export function describeReference(r: Pick<AirwayResult, 'reference' | 'ref_range_k' | 'ref_method'>): string {
  if (r.reference === 'manual') {
    return r.ref_range_k ? `manual · ${rangeLabel(r.ref_range_k)}` : 'manual';
  }
  const m = /^auto\s*\((.+)\)\s*$/.exec(r.ref_method ?? '');
  return m ? `auto · ${m[1]}` : 'auto';
}
