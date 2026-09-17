/**
 * Neck level mapper — classification of a single lymph node centroid.
 * Implements TOOLS-SPEC.md section 3 (Robbins 2008 / AJCC radiologic boundaries).
 *
 * Coordinates: DICOM LPS mm. +x = patient left, +y = posterior, +z = superior.
 * Pure module: no React, no Cornerstone, no DOM.
 */

import type {
  AnatomicSide,
  Confidence,
  Landmarks,
  LevelResult,
  NeckLevel,
  Point3,
  Side,
  SideLandmarks,
} from './types';

/** |x - midline| at or below this and the node is reported as 'midline'. */
export const MIDLINE_TOLERANCE_MM = 2;

/** marginMm below this yields confidence 'boundary'. */
export const BOUNDARY_MARGIN_MM = 5;

/** Fallback offset used when `ijvPosteriorEdge` is not supplied. */
export const IJV_POSTERIOR_EDGE_OFFSET_MM = 5;

/* ------------------------------------------------------------------ */
/* polyline interpolation                                              */
/* ------------------------------------------------------------------ */

/**
 * Linear interpolation of a sampled landmark polyline at a given z.
 * Samples are sorted by z; outside the sampled range the nearest end is
 * clamped (a node above the topmost sample uses the topmost sample).
 * Throws on an empty polyline — callers validate first.
 */
export function interpolateAtZ(polyline: Point3[], z: number): { x: number; y: number } {
  if (polyline.length === 0) throw new Error('interpolateAtZ: empty polyline');
  const pts = [...polyline].sort((a, b) => a[2] - b[2]);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (z <= first[2]) return { x: first[0], y: first[1] };
  if (z >= last[2]) return { x: last[0], y: last[1] };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (z >= a[2] && z <= b[2]) {
      const dz = b[2] - a[2];
      const t = dz === 0 ? 0 : (z - a[2]) / dz;
      return { x: a[0] + t * (b[0] - a[0]), y: a[1] + t * (b[1] - a[1]) };
    }
  }
  return { x: last[0], y: last[1] };
}

/** The IJV posterior edge at z, derived from ijvCenter when not supplied. */
export function ijvPosteriorEdgeAtZ(side: SideLandmarks, z: number): { x: number; y: number } {
  if (side.ijvPosteriorEdge && side.ijvPosteriorEdge.length > 0) {
    return interpolateAtZ(side.ijvPosteriorEdge, z);
  }
  const c = interpolateAtZ(side.ijvCenter, z);
  return { x: c.x, y: c.y + IJV_POSTERIOR_EDGE_OFFSET_MM };
}

/**
 * Midline x at a given z: the explicit `midlineX` when given, else the mean of
 * the two carotid medial edges at that z (TOOLS-SPEC: "mean of the two carotid
 * centres"), else 0.
 */
export function midlineAtZ(lm: Landmarks, z: number): number {
  if (typeof lm.midlineX === 'number') return lm.midlineX;
  const l = lm.left.carotidMedial;
  const r = lm.right.carotidMedial;
  if (l && l.length > 0 && r && r.length > 0) {
    return (interpolateAtZ(l, z).x + interpolateAtZ(r, z).x) / 2;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* boundary trace                                                      */
/* ------------------------------------------------------------------ */

const fmt = (v: number): string => Math.abs(v).toFixed(1);

/**
 * Records every boundary comparison actually performed, so that `marginMm` is
 * the distance to the nearest consulted boundary and `reasons` reads back as
 * the decision path. Short-circuited comparisons are never recorded.
 */
class Trace {
  readonly reasons: string[] = [];
  private readonly margins = new Map<string, number>();

  private note(key: string, delta: number, text: string): number {
    const d = Math.abs(delta);
    const prev = this.margins.get(key);
    if (prev === undefined || d < prev) this.margins.set(key, d);
    this.reasons.push(text);
    return delta;
  }

  /** z compared against a transverse plane. Positive delta = node is superior. */
  plane(label: string, z: number, boundary: number): number {
    const d = z - boundary;
    return this.note(`z:${label}`, d, `${d >= 0 ? 'above' : 'below'} ${label} by ${fmt(d)} mm`);
  }

  /** y compared against a structure. Positive delta = node is posterior to it. */
  ap(label: string, y: number, boundary: number): number {
    const d = y - boundary;
    return this.note(
      `y:${label}`,
      d,
      `${d >= 0 ? 'posterior to' : 'anterior to'} ${label} by ${fmt(d)} mm`,
    );
  }

  /** |x - midline| compared against a structure. Positive delta = node is lateral to it. */
  lateral(label: string, absX: number, boundary: number): number {
    const d = absX - boundary;
    return this.note(
      `x:${label}`,
      d,
      `${d >= 0 ? 'lateral to' : 'medial to'} ${label} by ${fmt(d)} mm`,
    );
  }

  /** A note that carries no measurable boundary (e.g. a missing landmark). */
  remark(text: string): void {
    this.reasons.push(text);
  }

  get marginMm(): number {
    let m = Number.POSITIVE_INFINITY;
    for (const v of this.margins.values()) if (v < m) m = v;
    return m;
  }
}

/* ------------------------------------------------------------------ */
/* classification                                                      */
/* ------------------------------------------------------------------ */

const HYOID = 'hyoid plane';
const CRICOID = 'cricoid plane';
const SKULL_BASE = 'skull base plane';
const CLAVICLE = 'clavicle / sternal notch plane';
const SCM = 'SCM posterior border';
const SMG = 'submandibular gland posterior border';
const IJV = 'IJV posterior edge';
const CAROTID = 'carotid medial edge';
const DIGASTRIC = 'anterior digastric belly';

function finish(level: NeckLevel, side: Side, trace: Trace): LevelResult {
  const marginMm = trace.marginMm;
  const confidence: Confidence =
    Number.isFinite(marginMm) && marginMm < BOUNDARY_MARGIN_MM ? 'boundary' : 'clear';
  return { level, side, confidence, marginMm, reasons: [...trace.reasons] };
}

/**
 * Classify a node centroid into a neck level.
 *
 * Evaluation order (README explains why it differs from the spec's listing
 * order): skull base -> below clavicle (VII) -> retropharyngeal -> level V
 * (posterior to SCM) -> at/above hyoid (I / II) -> medial to carotid (VI) ->
 * III / IV.
 */
export function classifyNode(centroid: Point3, lm: Landmarks): LevelResult {
  const [x, y, z] = centroid;
  const trace = new Trace();

  const mid = midlineAtZ(lm, z);
  const dx = x - mid;
  const absX = Math.abs(dx);
  const anatomicSide: AnatomicSide = dx < 0 ? 'right' : 'left';
  const side: Side = absX <= MIDLINE_TOLERANCE_MM ? 'midline' : anatomicSide;
  const S = lm[anatomicSide];

  // --- landmark sanity -------------------------------------------------
  if (!S || !Array.isArray(S.scmPosteriorBorder) || S.scmPosteriorBorder.length === 0) {
    trace.remark(`no SCM posterior border landmark for the ${anatomicSide} side`);
    return finish('unclassified', side, trace);
  }
  if (!Array.isArray(S.ijvCenter) || S.ijvCenter.length === 0) {
    trace.remark(`no IJV landmark for the ${anatomicSide} side`);
    return finish('unclassified', side, trace);
  }

  const carotidPoly = S.carotidMedial && S.carotidMedial.length > 0 ? S.carotidMedial : null;
  const carotid = carotidPoly ? interpolateAtZ(carotidPoly, z) : null;
  const carotidAbsX = carotid ? Math.abs(carotid.x - mid) : null;

  // --- 0. above the skull base: outside the cervical levels -------------
  if (typeof lm.skullBaseZ === 'number') {
    if (trace.plane(SKULL_BASE, z, lm.skullBaseZ) > 0) {
      trace.remark('above the skull base — outside the cervical node levels');
      return finish('unclassified', side, trace);
    }
  }

  // --- 1. below the sternal notch: level VII ----------------------------
  // Checked before III/IV/V, which the spec implicitly bounds at the clavicle.
  if (typeof lm.clavicleZ === 'number') {
    if (trace.plane(CLAVICLE, z, lm.clavicleZ) < 0) {
      return finish('VII', side, trace);
    }
  }

  // --- 2. retropharyngeal ------------------------------------------------
  // Simplified definition (there is no pharyngeal wall landmark): at or above
  // the hyoid, medial to the carotid medial edge, and posterior to the carotid.
  // Checked before I / II because level II would otherwise swallow it.
  if (carotid && carotidAbsX !== null) {
    if (trace.plane(HYOID, z, lm.hyoidInferiorZ) >= 0) {
      if (trace.lateral(CAROTID, absX, carotidAbsX) < 0) {
        if (trace.ap(CAROTID, y, carotid.y) > 0) {
          trace.remark('retropharyngeal — not addressed by a standard neck dissection');
          return finish('RP', side, trace);
        }
      }
    }
  }

  const scm = interpolateAtZ(S.scmPosteriorBorder, z);

  // --- 3. posterior to the SCM posterior border: level V ----------------
  if (trace.ap(SCM, y, scm.y) > 0) {
    const aboveCricoid = trace.plane(CRICOID, z, lm.cricoidInferiorZ) >= 0;
    return finish(aboveCricoid ? 'Va' : 'Vb', side, trace);
  }

  // --- 4. at or above the hyoid: level I or II --------------------------
  if (trace.plane(HYOID, z, lm.hyoidInferiorZ) >= 0) {
    if (trace.ap(SMG, y, S.submandibularPosterior[1]) < 0) {
      // Level I.
      const dig = S.digastricAnteriorMedial;
      if (!dig) {
        trace.remark('no anterior digastric landmark — level I reported as Ib');
        return finish('Ib', side, trace);
      }
      const digAbsX = Math.abs(dig[0] - mid);
      // Ia = the anteromedial quadrant of the digastric landmark (see README).
      if (trace.lateral(DIGASTRIC, absX, digAbsX) < 0 && trace.ap(DIGASTRIC, y, dig[1]) <= 0) {
        return finish('Ia', side, trace);
      }
      return finish('Ib', side, trace);
    }
    // Level II.
    const ijv = ijvPosteriorEdgeAtZ(S, z);
    return finish(trace.ap(IJV, y, ijv.y) > 0 ? 'IIb' : 'IIa', side, trace);
  }

  // --- 5. below the hyoid, medial to the carotids: level VI -------------
  if (carotidAbsX !== null) {
    if (trace.lateral(CAROTID, absX, carotidAbsX) < 0) {
      return finish('VI', side, trace);
    }
  } else {
    trace.remark('no carotid landmark — medial/lateral test skipped');
  }

  // --- 6. lateral chain: level III or IV --------------------------------
  return finish(trace.plane(CRICOID, z, lm.cricoidInferiorZ) >= 0 ? 'III' : 'IV', side, trace);
}

/** Convenience: classify many nodes in one call. */
export function classifyNodes(centroids: Point3[], lm: Landmarks): LevelResult[] {
  return centroids.map((c) => classifyNode(c, lm));
}
