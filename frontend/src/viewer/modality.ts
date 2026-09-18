/**
 * Modality-aware viewer logic: sequence inference, MR/PET presets, client-side
 * percentile windowing, acquired-plane detection and sequence-browser grouping.
 *
 * Why it lives on its own: CT is the easy case — HU are absolute, so a fixed
 * preset table (`presets.ts`) is correct forever. MR is the opposite: signal
 * intensity has no absolute scale, the same anatomy windows differently on two
 * scanners, and the clinically useful label ("T1 +C", "ADC") is buried in a
 * free-text SeriesDescription. All of that reasoning is pure arithmetic and
 * string work, so it is kept free of Cornerstone, React and the store and is
 * unit-tested directly.
 */

import { api, type Series } from '../api/client';
import type { WindowPreset } from './presets';

/* ------------------------------------------------------------------ */
/* 1. Modality                                                        */
/* ------------------------------------------------------------------ */

export type Modality = 'CT' | 'MR' | 'PT' | 'US' | 'CR' | 'OT';

const KNOWN_MODALITIES: Modality[] = ['CT', 'MR', 'PT', 'US', 'CR', 'OT'];

/**
 * Collapse whatever the indexer stored into the six modalities the viewer
 * actually behaves differently for. Real archives carry both 'PET'/'PT' and
 * 'MRI'/'MR' depending on the sending AE, and every unknown code (SR, PR, RTSTRUCT…)
 * should fall through to the neutral 'OT' path rather than crash a lookup table.
 */
export function normaliseModality(m: string | null | undefined): Modality {
  const s = (m ?? '').trim().toUpperCase();
  if (s === 'PET') return 'PT';
  if (s === 'MRI') return 'MR';
  return (KNOWN_MODALITIES as string[]).includes(s) ? (s as Modality) : 'OT';
}

/** CT is the only modality with absolute units, so callers branch on it a lot. */
export function isCt(s: { modality?: string | null }): boolean {
  return normaliseModality(s.modality) === 'CT';
}

/** MR drives sequence inference, rescaled presets and the thick-slice rule. */
export function isMr(s: { modality?: string | null }): boolean {
  return normaliseModality(s.modality) === 'MR';
}

/* ------------------------------------------------------------------ */
/* 2. Sequence inference                                              */
/* ------------------------------------------------------------------ */

export type SequenceKind =
  | 't1'
  | 't1c'
  | 't2'
  | 'stir'
  | 'flair'
  | 'dwi'
  | 'adc'
  | 'swi'
  | 'mra'
  | 'other';

/** Short labels for the series list and the sequence browser headers. */
export const SEQUENCE_LABEL: Record<SequenceKind, string> = {
  t1: 'T1',
  t1c: 'T1 +C',
  t2: 'T2',
  stir: 'STIR',
  flair: 'FLAIR',
  dwi: 'DWI',
  adc: 'ADC',
  swi: 'SWI',
  mra: 'MRA',
  other: 'MR',
};

/** Canonical spellings the backend (or another PACS) might hand us. */
const KIND_ALIASES: Record<string, SequenceKind> = {
  t1: 't1',
  t1w: 't1',
  t1c: 't1c',
  t1ce: 't1c',
  t1post: 't1c',
  t1_c: 't1c',
  t1gd: 't1c',
  t2: 't2',
  t2w: 't2',
  stir: 'stir',
  tirm: 'stir',
  flair: 'flair',
  dwi: 'dwi',
  dw: 'dwi',
  adc: 'adc',
  dwi_adc: 'adc',
  swi: 'swi',
  mra: 'mra',
  tof: 'mra',
};

/**
 * Normalise a stored `sequence_kind`. Separators vary by source ('t1_c' vs
 * 't1-c'), so they are folded away before the alias lookup; anything we do not
 * recognise becomes 'other' rather than null, because the field being *set* is
 * itself the signal that someone classified this series.
 */
function kindFromStored(raw: string): SequenceKind {
  const s = raw.trim().toLowerCase();
  const direct = KIND_ALIASES[s];
  if (direct) return direct;
  const folded = s.replace(/[\s\-/]+/g, '_');
  const viaFold = KIND_ALIASES[folded] ?? KIND_ALIASES[folded.replace(/_/g, '')];
  return viaFold ?? 'other';
}

/**
 * Fat-suppression markers describe *how* the fat signal was nulled, not what
 * kind of sequence this is — 'T2 FS' is still T2. They are removed before the
 * description is matched so they can never tip a decision.
 */
const FAT_SAT = /\b(fs|fatsat|fat\s*sat|spair|spir|sat)\b/g;

/** Post-gadolinium markers. Kept to whole tokens so 'posterior' is not 'post'. */
const POST_CONTRAST =
  /(\+\s*c\b|\bc\s*\+|\bpost\b|\bpostcontrast\b|\bpostgd\b|\bgd\b|\bgad\b|\bce\b|\bcontrast\b)/;

const T1_MARK = /\bt1(?!\d)/;
const T2_MARK = /\bt2(?!\d)/;

/** Lower-case and fold DICOM's separator soup so `\b` anchors behave. */
function normaliseDescription(d: string): string {
  return d
    .toLowerCase()
    .replace(/[_\-/\\,.():;*]+/g, ' ')
    .replace(FAT_SAT, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Long-TR threshold shared by the T2 and STIR heuristics (ms). */
const LONG_TR_MS = 1800;

/**
 * Work out what kind of MR sequence this is, because the window preset, the
 * ROI unit and the sequence-browser grouping all hang off it.
 *
 * Three tiers, most trustworthy first: an explicit `sequence_kind` from the
 * indexer, then the SeriesDescription (what the tech typed — messy but almost
 * always present), then the acquisition parameters (always present but only
 * separate the extremes). Returns null when nothing is knowable, so callers can
 * fall back to a modality-level default instead of showing a wrong label.
 */
export function inferSequenceKind(
  s: Pick<
    Series,
    | 'modality'
    | 'description'
    | 'sequence_kind'
    | 'echo_time'
    | 'repetition_time'
    | 'inversion_time'
    | 'scanning_sequence'
    | 'contrast_agent'
  >,
): SequenceKind | null {
  const stored = (s.sequence_kind ?? '').trim();
  if (stored) return kindFromStored(stored);

  if (normaliseModality(s.modality) !== 'MR') return null;

  const d = normaliseDescription(s.description ?? '');
  if (d) {
    // ADC before DWI: an ADC map's description nearly always still says "DWI".
    if (/\badc\b/.test(d)) return 'adc';
    if (/\b(dwi|dw|dti|trace)\b/.test(d)) return 'dwi';
    if (/\b(stir|tirm)\b/.test(d)) return 'stir';
    if (/\bflair\b/.test(d)) return 'flair';
    if (/\bswi\b/.test(d)) return 'swi';
    if (/\b(mra|tof)\b/.test(d)) return 'mra';
    if (T1_MARK.test(d)) {
      // A recorded contrast agent is as good a post-contrast marker as the text.
      const agent = (s.contrast_agent ?? '').trim();
      if (POST_CONTRAST.test(d) || agent) return 't1c';
    }
    if (T2_MARK.test(d)) return 't2';
    if (T1_MARK.test(d)) return 't1';
  }

  const tr = s.repetition_time;
  const te = s.echo_time;
  if (typeof tr === 'number' && Number.isFinite(tr) && typeof te === 'number' && Number.isFinite(te)) {
    if (tr < 800 && te < 30) return 't1';
    if (tr > LONG_TR_MS && te > 60) return 't2';
    const ti = s.inversion_time;
    // Short-TI inversion recovery on a long-TR acquisition is STIR by definition.
    if (typeof ti === 'number' && Number.isFinite(ti) && ti >= 100 && ti <= 200 && tr > LONG_TR_MS) {
      return 'stir';
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 3. Presets                                                         */
/* ------------------------------------------------------------------ */

const hint = (ww: number, wc: number) => `${ww} / ${wc}`;

/**
 * MR starting points. These are *not* absolute like the CT table: MR signal has
 * no fixed scale, so each one is only a width:centre ratio that
 * `rescalePresetToData` re-anchors onto the volume's own intensity range.
 */
export const MR_PRESETS: WindowPreset[] = [
  { id: 'mr-t1', label: 'T1', ww: 600, wc: 300, hint: hint(600, 300) },
  { id: 'mr-t2', label: 'T2', ww: 1200, wc: 600, hint: hint(1200, 600) },
  { id: 'mr-stir', label: 'STIR / fat-sat', ww: 900, wc: 450, hint: hint(900, 450) },
  { id: 'mr-adc', label: 'ADC', ww: 2400, wc: 1200, hint: hint(2400, 1200) },
  { id: 'mr-wide', label: 'Wide', ww: 2000, wc: 1000, hint: hint(2000, 1000) },
];

/** PET is displayed in SUV, where a 0–10 range covers almost every head/neck study. */
export const PT_PRESETS: WindowPreset[] = [
  { id: 'pt-suv', label: 'PET SUV', ww: 10, wc: 5, hint: hint(10, 5) },
  { id: 'pt-wide', label: 'Wide', ww: 20, wc: 10, hint: hint(20, 10) },
];

/**
 * Pick the preset table for a modality. CT's list is passed in rather than
 * imported so this module stays independent of the CT preset file's contents
 * (the caller may have user-edited or reordered it).
 */
export function presetsFor(modality: Modality, ctPresets: WindowPreset[]): WindowPreset[] {
  if (modality === 'MR') return MR_PRESETS;
  if (modality === 'PT') return PT_PRESETS;
  return ctPresets;
}

/**
 * Which preset to select when a series first opens. Chosen so the first frame
 * is diagnostic without a mouse drag: diffusion/ADC and fluid-sensitive series
 * need much wider windows than T1 anatomy.
 * CT and everything else return null — the caller keeps its own default.
 */
export function defaultPresetId(modality: Modality, kind: SequenceKind | null): string | null {
  if (modality === 'PT') return 'pt-suv';
  if (modality !== 'MR') return null;
  switch (kind) {
    case 'adc':
      return 'mr-adc';
    case 'stir':
    case 'flair':
    case 'dwi':
      return 'mr-stir';
    case 't2':
      return 'mr-t2';
    case 't1':
    case 't1c':
      return 'mr-t1';
    default:
      return 'mr-wide';
  }
}

/* ------------------------------------------------------------------ */
/* 4. Percentile windowing                                            */
/* ------------------------------------------------------------------ */

export interface Histogram {
  min: number;
  max: number;
  counts: Uint32Array;
  binWidth: number;
}

/** Above this many samples the histogram stops getting more accurate and starts
 *  costing frames, so `buildHistogram` strides instead of reading every voxel. */
const MAX_HISTOGRAM_SAMPLES = 2_000_000;

export interface HistogramOptions {
  bins?: number;
  sampleStride?: number;
}

/**
 * Summarise a loaded volume's intensities. A histogram — rather than a sort —
 * because a 512³ MR volume is 134M voxels: an O(n) strided pass into 512 bins is
 * the only thing that stays inside a frame budget, and percentile accuracy of
 * half a bin is far finer than the eye can see in a window/level.
 *
 * Returns null when the data cannot produce a meaningful window (too few finite
 * samples, or a constant image), so the caller keeps its existing window.
 */
export function buildHistogram(
  values: ArrayLike<number>,
  opts: HistogramOptions = {},
): Histogram | null {
  const n = values.length;
  if (!Number.isFinite(n) || n <= 0) return null;

  const bins = Math.max(2, Math.floor(opts.bins ?? 512));
  const stride = Math.max(
    1,
    Math.floor(opts.sampleStride ?? Math.ceil(n / MAX_HISTOGRAM_SAMPLES)) || 1,
  );

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let seen = 0;
  for (let i = 0; i < n; i += stride) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    seen += 1;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (seen < 32 || min === max) return null;

  const binWidth = (max - min) / bins;
  const counts = new Uint32Array(bins);
  for (let i = 0; i < n; i += stride) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    let k = Math.floor((v - min) / binWidth);
    if (k < 0) k = 0;
    else if (k >= bins) k = bins - 1;
    counts[k] += 1;
  }
  return { min, max, counts, binWidth };
}

/**
 * Value at fraction `p` of the distribution, interpolated inside the bin so a
 * 512-bin histogram does not quantise the window into visible steps.
 */
export function percentile(h: Histogram, p: number): number {
  const bins = h.counts.length;
  let total = 0;
  for (let i = 0; i < bins; i += 1) total += h.counts[i];
  if (total === 0) return h.min;

  const q = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
  if (q <= 0) return h.min;
  if (q >= 1) return h.max;

  const target = q * total;
  let cum = 0;
  for (let i = 0; i < bins; i += 1) {
    const c = h.counts[i];
    if (c === 0) continue;
    if (cum + c >= target) {
      const frac = (target - cum) / c;
      return h.min + (i + frac) * h.binWidth;
    }
    cum += c;
  }
  return h.max;
}

/**
 * Windows wider than ~10 units are read as integers by every DICOM viewer, but
 * a PET SUV window of 3.5 would be destroyed by rounding — so the precision
 * follows the magnitude.
 */
function roundWindow(ww: number, wc: number): { ww: number; wc: number } {
  if (ww >= 10) return { ww: Math.round(ww), wc: Math.round(wc) };
  return { ww: Math.round(ww * 100) / 100, wc: Math.round(wc * 100) / 100 };
}

function windowFromRange(low: number, high: number, minWidth: number): { ww: number; wc: number } {
  const ww = Math.max(high - low, minWidth);
  const wc = (high + low) / 2;
  return roundWindow(ww, wc);
}

export interface WindowFromHistogramOptions {
  lowP?: number;
  highP?: number;
  minWidth?: number;
}

/**
 * Turn a histogram into a window. The 2/98 percentile pair rather than min/max
 * because a handful of hot voxels (metal, a fiducial, a reconstruction spike)
 * otherwise stretch the window until the anatomy is a flat grey.
 */
export function windowFromHistogram(
  h: Histogram,
  opts: WindowFromHistogramOptions = {},
): { ww: number; wc: number } {
  const low = percentile(h, opts.lowP ?? 0.02);
  const high = percentile(h, opts.highP ?? 0.98);
  return windowFromRange(low, high, opts.minWidth ?? 1);
}

export interface AutoWindowOptions extends HistogramOptions, WindowFromHistogramOptions {
  /** Fraction of the intensity range treated as background air. Default 0.02. */
  backgroundFraction?: number;
}

/**
 * Derive a window straight from the loaded voxels, for the modalities where no
 * fixed preset can be right.
 *
 * MR background air is a huge zero spike — typically well over a third of the
 * voxels in a head/neck volume — that would otherwise swallow the low
 * percentile and pin the bottom of the window to noise. So the low bound is
 * clamped to sit above the bottom `backgroundFraction` of the intensity range,
 * which puts it inside real tissue.
 *
 * CT returns null on purpose: HU are absolute and the clinical HU presets beat
 * anything derived from one volume's own distribution.
 */
export function autoWindowForVolume(
  values: ArrayLike<number>,
  modality: Modality,
  opts: AutoWindowOptions = {},
): { ww: number; wc: number; source: 'percentile' } | null {
  if (modality === 'CT') return null;
  const h = buildHistogram(values, opts);
  if (!h) return null;

  const cut = h.min + (opts.backgroundFraction ?? 0.02) * (h.max - h.min);
  const low = Math.max(percentile(h, opts.lowP ?? 0.02), cut);
  const high = percentile(h, opts.highP ?? 0.98);
  return { ...windowFromRange(low, high, opts.minWidth ?? 1), source: 'percentile' };
}

/* ------------------------------------------------------------------ */
/* 5. Rescaling a preset onto real data                               */
/* ------------------------------------------------------------------ */

/**
 * Re-anchor an MR preset onto this volume's own intensity scale.
 *
 * MR signal has no absolute units: 600/300 is meaningful on the scanner that
 * produced the numbers behind the preset and meaningless everywhere else. What
 * *is* portable is the preset's width-to-centre ratio ("show me a window twice
 * as wide as the centre"), so the preset is scaled by `data.wc / preset.wc`,
 * which lands the centre exactly on the data's measured centre.
 *
 * A preset centred on zero (or non-finite input) has no such ratio, so the
 * measured window is returned unchanged.
 */
export function rescalePresetToData(
  preset: WindowPreset,
  data: { ww: number; wc: number },
): { ww: number; wc: number } {
  if (!Number.isFinite(preset.wc) || preset.wc === 0) return data;
  if (!Number.isFinite(preset.ww) || !Number.isFinite(data.wc) || !Number.isFinite(data.ww)) {
    return data;
  }
  const scale = data.wc / preset.wc;
  if (!Number.isFinite(scale) || scale === 0) return data;
  return roundWindow(Math.abs(preset.ww * scale), preset.wc * scale);
}

/* ------------------------------------------------------------------ */
/* 6. Resolving a window for a series                                 */
/* ------------------------------------------------------------------ */

/**
 * Ask the backend for the right window, degrading quietly to the caller's
 * fallback. `GET /api/series/{uid}/window` is still being built, so a 404 is a
 * first-class, expected answer — this never throws and never blocks a series
 * from opening.
 */
export async function resolveWindow(
  series: Pick<Series, 'series_uid' | 'modality' | 'description' | 'sequence_kind'>,
  fallback: { ww: number; wc: number },
): Promise<{ ww: number; wc: number; source: string }> {
  try {
    const resp = await api.seriesWindow(series.series_uid);
    // The route reports bounds (`lower`/`upper`); accept a width/centre pair
    // too so the client does not have to change if the shape ever does.
    const fromBounds =
      typeof resp.lower === 'number' && typeof resp.upper === 'number' && resp.upper > resp.lower
        ? { ww: resp.upper - resp.lower, wc: (resp.upper + resp.lower) / 2 }
        : null;
    const pair =
      fromBounds ??
      (typeof resp.ww === 'number' && typeof resp.wc === 'number' && resp.ww > 0
        ? { ww: resp.ww, wc: resp.wc }
        : null);
    if (pair && Number.isFinite(pair.ww) && Number.isFinite(pair.wc)) {
      return {
        ww: Math.round(pair.ww),
        wc: Math.round(pair.wc),
        source: resp.method ?? resp.source ?? 'backend',
      };
    }
  } catch {
    /* an older backend has no such route; an unreachable one is the same story */
  }
  return { ...fallback, source: 'fallback' };
}

/* ------------------------------------------------------------------ */
/* 7. Acquired plane and slice thickness                              */
/* ------------------------------------------------------------------ */

export type Plane = 'axial' | 'sagittal' | 'coronal' | 'oblique';

/** Below this the normal is not close enough to an anatomic axis to name it. */
const CARDINAL_TOLERANCE = 0.85;

/**
 * Name the plane a series was acquired in, from ImageOrientationPatient.
 *
 * Why the cross product: the two direction cosines describe the in-plane axes,
 * so the slice normal (rowDir x colDir, in LPS) is what actually identifies the
 * plane. A normal that is not within ~32 degrees of an anatomic axis is genuinely
 * oblique and mislabelling it 'axial' would make the reformat controls lie.
 */
export function planeFromOrientation(orientation: number[] | null | undefined): Plane | null {
  if (!orientation || orientation.length !== 6) return null;
  if (!orientation.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;

  const [rx, ry, rz, cx, cy, cz] = orientation;
  const nx = ry * cz - rz * cy;
  const ny = rz * cx - rx * cz;
  const nz = rx * cy - ry * cx;

  const len = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(len) || len === 0) return null;

  const ax = Math.abs(nx) / len;
  const ay = Math.abs(ny) / len;
  const az = Math.abs(nz) / len;
  const peak = Math.max(ax, ay, az);
  if (peak < CARDINAL_TOLERANCE) return 'oblique';
  if (peak === az) return 'axial';
  if (peak === ax) return 'sagittal';
  return 'coronal';
}

/**
 * The through-plane step that actually matters for reformats.
 * SpacingBetweenSlices is the real sample spacing; SliceThickness is only the
 * slab each sample covers, and the two differ whenever slices overlap or gap.
 */
export function effectiveSliceSpacing(
  s: Pick<Series, 'spacing_between_slices' | 'slice_thickness'>,
): number | null {
  const sbs = s.spacing_between_slices;
  if (typeof sbs === 'number' && Number.isFinite(sbs) && sbs > 0) return sbs;
  const st = s.slice_thickness;
  if (typeof st === 'number' && Number.isFinite(st) && st > 0) return st;
  return null;
}

/** Above this, reformats are visibly stepped and the acquired plane wins. */
export const THICK_SLICE_MM = 2.5;

/** Thick series cannot be reformatted without obvious stair-step artefact. */
export function isThickSeries(s: Pick<Series, 'spacing_between_slices' | 'slice_thickness'>): boolean {
  const sp = effectiveSliceSpacing(s);
  return sp !== null && sp > THICK_SLICE_MM;
}

/**
 * Decide how a series should open. The rule that matters clinically: a routine
 * 4 mm MR is acquired in one plane and read in that plane — forcing it into MPR
 * shows the reader two blurred reformats and one good image. CT (and isotropic
 * MR) is the reverse, where MPR is the whole point.
 */
export function preferredPrimary(
  s: Pick<
    Series,
    'modality' | 'orientation' | 'spacing_between_slices' | 'slice_thickness' | 'is_3d' | 'instance_count'
  >,
): { mode: 'mpr' | 'stack'; plane: Plane | null; reason: string } {
  const plane = planeFromOrientation(s.orientation);
  if (!s.is_3d || s.instance_count < 3) {
    return { mode: 'stack', plane, reason: 'single stack' };
  }
  if (isMr(s) && isThickSeries(s)) {
    return { mode: 'stack', plane, reason: 'thick MR — reading the acquired plane' };
  }
  return { mode: 'mpr', plane, reason: 'isotropic volume' };
}

/* ------------------------------------------------------------------ */
/* 8. Sequence browser grouping                                       */
/* ------------------------------------------------------------------ */

export interface SeriesGroup {
  key: string;
  label: string;
  modality: Modality;
  series: Series[];
}

/** CT/MR/PT/US are what head-and-neck reading actually uses; the rest trail. */
const MODALITY_ORDER: Modality[] = ['CT', 'MR', 'PT', 'US', 'CR', 'OT'];

const MODALITY_GROUP_LABEL: Record<Modality, string> = {
  CT: 'CT',
  MR: 'MR',
  PT: 'PET',
  US: 'Ultrasound',
  CR: 'Radiograph',
  OT: 'Other',
};

/** Reading order within MR: anatomy first, then fluid, then diffusion/angio. */
const SEQUENCE_ORDER: SequenceKind[] = [
  't1',
  't1c',
  't2',
  'stir',
  'flair',
  'dwi',
  'adc',
  'swi',
  'mra',
  'other',
];

function compareSeries(a: Series, b: Series): number {
  const na = a.series_number ?? Number.POSITIVE_INFINITY;
  const nb = b.series_number ?? Number.POSITIVE_INFINITY;
  if (na !== nb) return na < nb ? -1 : 1;
  return (a.description ?? '').localeCompare(b.description ?? '');
}

/**
 * Build the sequence browser's sections. Grouping by modality then MR sequence
 * is how a radiologist actually navigates a study — "show me the T1 +C" — and a
 * flat, scanner-ordered series list buries that under localisers and derived
 * series.
 */
export function groupSeries(list: Series[]): SeriesGroup[] {
  const groups = new Map<string, SeriesGroup>();
  const rank = new Map<string, number>();

  for (const s of list) {
    const modality = normaliseModality(s.modality);
    let key: string;
    let label: string;
    let order: number;

    if (modality === 'MR') {
      const kind = inferSequenceKind(s);
      // Unclassified and explicitly-'other' MR share one bucket: both mean
      // "MR we could not name", and a group labelled plainly 'MR' next to
      // 'MR — other' would be a distinction without a difference.
      const bucket: SequenceKind = kind ?? 'other';
      key = `mr-${bucket}`;
      label = bucket === 'other' ? 'MR — other' : SEQUENCE_LABEL[bucket];
      order = MODALITY_ORDER.indexOf('MR') * 100 + SEQUENCE_ORDER.indexOf(bucket);
    } else {
      key = modality.toLowerCase();
      label = MODALITY_GROUP_LABEL[modality];
      order = MODALITY_ORDER.indexOf(modality) * 100;
    }

    const existing = groups.get(key);
    if (existing) {
      existing.series.push(s);
    } else {
      groups.set(key, { key, label, modality, series: [s] });
      rank.set(key, order);
    }
  }

  const out = [...groups.values()];
  out.sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
  for (const g of out) g.series.sort(compareSeries);
  return out;
}

/**
 * Whether two series share a coordinate system, which is the precondition for
 * linked scrolling, crosshairs and copying an ROI between them. A missing UID
 * is never a match — guessing here silently puts a measurement on the wrong
 * anatomy.
 */
export function sameFrameOfReference(
  a: Series | null | undefined,
  b: Series | null | undefined,
): boolean {
  const ua = (a?.frame_of_reference_uid ?? '').trim();
  const ub = (b?.frame_of_reference_uid ?? '').trim();
  return ua.length > 0 && ua === ub;
}

/* ------------------------------------------------------------------ */
/* 9. ROI units                                                       */
/* ------------------------------------------------------------------ */

/**
 * What an ROI's mean value actually means. Labelling an MR ROI "HU" (or an ADC
 * ROI "signal") is the kind of small lie that ends up in a report, so every
 * readout carries the right unit.
 */
export function intensityUnit(
  modality: Modality,
  kind?: SequenceKind | null,
): { short: string; long: string } {
  if (modality === 'CT') return { short: 'HU', long: 'Hounsfield units' };
  if (modality === 'MR') {
    if (kind === 'adc') return { short: 'ADC', long: '×10⁻⁶ mm²/s' };
    return { short: 'signal', long: 'signal intensity' };
  }
  if (modality === 'PT') return { short: 'SUV', long: 'standardised uptake value' };
  return { short: 'value', long: 'stored value' };
}

/**
 * Format an intensity for the overlay at the precision that modality supports.
 * ADC values run in the hundreds-to-thousands so decimals are noise, while SUV
 * decisions turn on tenths — hence the per-modality precision.
 */
export function formatIntensity(
  v: number | null,
  modality: Modality,
  kind?: SequenceKind | null,
): string {
  if (v === null || !Number.isFinite(v)) return '—';
  if (modality === 'MR' && kind === 'adc') return `${Math.round(v)} ADC`;
  if (modality === 'CT') return `${Math.round(v)} HU`;
  if (modality === 'MR') return `${Math.round(v)}`;
  if (modality === 'PT') return v.toFixed(2);
  return `${Math.round(v)}`;
}
