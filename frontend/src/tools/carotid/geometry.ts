/**
 * Carotid encasement geometry — TOOLS-SPEC.md §1.
 *
 * Pure 2-D maths. NOTHING in this file may import Cornerstone, React or the
 * store: it is the part that has to be provably right, so it is unit tested on
 * its own.
 *
 * ---------------------------------------------------------------------------
 * Coordinate frame
 * ---------------------------------------------------------------------------
 * Every point is a millimetre coordinate in the axial image plane expressed in
 * the two in-plane DICOM LPS axes:
 *
 *     +x → patient LEFT        −x → patient right
 *     +y → patient POSTERIOR   −y → patient anterior
 *
 * That is exactly what you get by dropping the z of an LPS world point that
 * lies on an axial slice, so the caller never has to rotate anything.
 *
 * ---------------------------------------------------------------------------
 * Angles and the clock face
 * ---------------------------------------------------------------------------
 * θ is measured from ANTERIOR, increasing towards the patient's LEFT — i.e. the
 * clockwise direction as the slice is displayed in radiological convention
 * (anterior up, patient left on the right of the image):
 *
 *     θ =   0°  anterior    → 12 o'clock
 *     θ =  90°  left        →  3 o'clock
 *     θ = 180°  posterior   →  6 o'clock
 *     θ = 270°  right       →  9 o'clock
 *
 * so a sample on the vessel circumference is
 *
 *     q(θ) = c + r · ( sin θ , −cos θ )
 *
 * and the clock hour is simply θ / 30.
 */

export type Point2 = [number, number];

/**
 * One contiguous run of contact.
 *
 * `startDeg` is always in [0, 360). `endDeg` is `startDeg + extent`, so an arc
 * that wraps across 0° reports an `endDeg` above 360 (e.g. 300 → 390 is the
 * 90° arc from 10 o'clock round through 12 to 1 o'clock). The extent of an arc
 * is therefore always `endDeg − startDeg`, with no special cases, and the
 * extents sum exactly to `angleDeg`.
 */
export interface Arc {
  startDeg: number;
  endDeg: number;
}

export interface ContactAngleInput {
  /** Vessel lumen centre, mm. */
  center: Point2;
  /** Vessel lumen radius, mm. */
  radius: number;
  /** Tumour contour as a closed polygon (the closing edge is implicit). */
  polygon: Point2[];
  /** Contact if the signed distance to the polygon is ≤ this, mm. Default 1.5. */
  tolerance?: number;
  /** Circumference samples. Default 360 (1° resolution). */
  samples?: number;
}

export interface ContactAngleResult {
  /** Total circumferential contact, degrees (0…360). */
  angleDeg: number;
  /** Extent of the single longest contiguous arc, degrees. */
  longestArcDeg: number;
  /** Every contiguous contact arc, ordered by `startDeg`. */
  arcs: Arc[];
  /** Clock hour (1…12) where the longest arc starts; null when there is no contact. */
  clockFrom: number | null;
  /** Clock hour (1…12) where the longest arc ends; null when there is no contact. */
  clockTo: number | null;
  /** Per-sample contact flags, index k ↔ θ = k · 360 / samples. */
  contactMask: boolean[];
}

export type Severity = 'abutment' | 'partial' | 'encasement';

const DEFAULT_TOLERANCE_MM = 1.5;
const DEFAULT_SAMPLES = 360;

/* ------------------------------------------------------------------ */
/* primitives                                                         */
/* ------------------------------------------------------------------ */

const DEG = Math.PI / 180;

/** Unit direction of θ in the LPS in-plane frame: 0° anterior, 90° patient left. */
export function directionAt(deg: number): Point2 {
  const t = deg * DEG;
  return [Math.sin(t), -Math.cos(t)];
}

/** The point on the vessel circumference at θ. */
export function pointOnCircle(center: Point2, radius: number, deg: number): Point2 {
  const [dx, dy] = directionAt(deg);
  return [center[0] + radius * dx, center[1] + radius * dy];
}

/** Shortest distance from p to the segment ab. */
export function distanceToSegment(p: Point2, a: Point2, b: Point2): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  let t = 0;
  if (len2 > 0) {
    t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const dx = p[0] - (a[0] + t * abx);
  const dy = p[1] - (a[1] + t * aby);
  return Math.hypot(dx, dy);
}

/**
 * Even-odd ray casting. Points exactly on an edge are unreliable here by
 * design — `signedDistanceToPolygon` resolves them through the tolerance, so a
 * boundary point is always "in contact" whichever side the test lands on.
 */
export function pointInPolygon(p: Point2, polygon: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const straddles = yi > p[1] !== yj > p[1];
    if (!straddles) continue;
    const x = ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
    if (p[0] < x) inside = !inside;
  }
  return inside;
}

/** Negative inside the polygon, positive outside; magnitude = distance to the boundary. */
export function signedDistanceToPolygon(p: Point2, polygon: Point2[]): number {
  if (polygon.length < 2) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const d = distanceToSegment(p, polygon[j], polygon[i]);
    if (d < best) best = d;
  }
  return pointInPolygon(p, polygon) ? -best : best;
}

/** Drop repeated vertices and an explicit closing vertex; the loop is implicit. */
function cleanPolygon(polygon: Point2[]): Point2[] {
  const out: Point2[] = [];
  for (const p of polygon) {
    if (!Number.isFinite(p?.[0]) || !Number.isFinite(p?.[1])) continue;
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) out.pop();
    else break;
  }
  return out;
}

/** Contiguous runs of `true`, treating the mask as a circle. */
function arcsFromMask(mask: boolean[], step: number): Arc[] {
  const n = mask.length;
  if (n === 0) return [];
  let count = 0;
  for (const m of mask) if (m) count++;
  if (count === 0) return [];
  if (count === n) return [{ startDeg: 0, endDeg: 360 }];

  const arcs: Arc[] = [];
  for (let i = 0; i < n; i++) {
    if (!mask[i] || mask[(i - 1 + n) % n]) continue; // not the first sample of a run
    let len = 0;
    while (len < n && mask[(i + len) % n]) len++;
    arcs.push({ startDeg: i * step, endDeg: (i + len) * step });
  }
  return arcs;
}

/** Clock hour 1…12 for an angle in the frame documented at the top of the file. */
export function hourFromDeg(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360;
  const h = Math.round(wrapped / 30) % 12;
  return h === 0 ? 12 : h;
}

/* ------------------------------------------------------------------ */
/* the measurement                                                    */
/* ------------------------------------------------------------------ */

/**
 * Degrees of the vessel circumference in contact with the tumour.
 *
 * TOOLS-SPEC.md §1: sample the circumference N times, take the signed distance
 * to the tumour polygon at each sample, call it contact when that distance is
 * ≤ the tolerance, and report both the total and the contiguous arcs.
 */
export function contactAngle(input: ContactAngleInput): ContactAngleResult {
  const tolerance = Number.isFinite(input.tolerance) ? (input.tolerance as number) : DEFAULT_TOLERANCE_MM;
  const samples = Math.max(3, Math.round(Number.isFinite(input.samples) ? (input.samples as number) : DEFAULT_SAMPLES));
  const step = 360 / samples;
  const polygon = cleanPolygon(input.polygon ?? []);
  const radius = input.radius;

  const contactMask: boolean[] = new Array(samples).fill(false);
  const usable = polygon.length >= 3 && Number.isFinite(radius) && radius > 0;

  if (usable) {
    for (let k = 0; k < samples; k++) {
      const q = pointOnCircle(input.center, radius, k * step);
      contactMask[k] = signedDistanceToPolygon(q, polygon) <= tolerance;
    }
  }

  let hits = 0;
  for (const m of contactMask) if (m) hits++;
  const angleDeg = (360 * hits) / samples;

  const arcs = arcsFromMask(contactMask, step);
  let longest: Arc | null = null;
  for (const a of arcs) {
    if (!longest || a.endDeg - a.startDeg > longest.endDeg - longest.startDeg) longest = a;
  }

  return {
    angleDeg,
    longestArcDeg: longest ? longest.endDeg - longest.startDeg : 0,
    arcs,
    clockFrom: longest ? hourFromDeg(longest.startDeg) : null,
    clockTo: longest ? hourFromDeg(longest.endDeg) : null,
    contactMask,
  };
}

/** TOOLS-SPEC.md §1: <180 abutment, 180–270 partial encasement, >270 encasement. */
export function classify(angleDeg: number): Severity {
  if (!Number.isFinite(angleDeg)) return 'abutment';
  if (angleDeg > 270) return 'encasement';
  if (angleDeg >= 180) return 'partial';
  return 'abutment';
}

/** "2–6 o'clock", or null when nothing is in contact. */
export function clockLabel(result: Pick<ContactAngleResult, 'clockFrom' | 'clockTo'>): string | null {
  if (result.clockFrom === null || result.clockTo === null) return null;
  return `${result.clockFrom}–${result.clockTo} o'clock`;
}
