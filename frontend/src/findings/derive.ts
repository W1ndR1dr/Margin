/**
 * Findings derivation — everything Margin currently knows, turned into the
 * list the right panel opens on.
 *
 * Why this is a pure function: the Findings tab has to be correct before it is
 * pretty. A function of its inputs can be unit-tested exhaustively, which is
 * the only way to hold the two clinical rules below, and it makes the panel a
 * trivial `useMemo` that cannot drift from what was measured. Nothing here may
 * import zustand, React or Cornerstone — types only.
 *
 * ---------------------------------------------------------------------------
 * Rule 1 — absence of evidence is never evidence of absence
 * ---------------------------------------------------------------------------
 * A green "checked, normal" row is a positive clinical claim: someone looked
 * at this and it was fine. It may therefore only appear when a check actually
 * ran. `deriveFindings` never invents one: green rows come exclusively from
 * `completedChecks`, which the caller supplies from checks that genuinely
 * executed. Every row carries `checked`, and the panel paints green only on
 * `checked === true && severity === 'ok'`.
 *
 * ---------------------------------------------------------------------------
 * Rule 2 — no Myer–Cotton grade, anywhere
 * ---------------------------------------------------------------------------
 * ROADMAP.md puts airway stenosis grading out of scope. Margin reports airway
 * *patency*: the minimum lumen at a level, and how far below the glottis it
 * sits when the glottis was marked. `AirwayResult` carries `myer_cotton_grade`
 * and `stenosis_pct` because the backend computes them; this module reads
 * neither, and no string it produces may imply a grade. There is a regression
 * test for that.
 */
import type { AirwayResult, LabelStats, Triple } from '../api/client';
import { CATEGORY_LABEL, categoryForName } from '../labels/colors';
import type { Structure } from '../labels/structureStore';
import type { Measurement, PaneId } from '../store/useAppStore';
import { clockLabel } from '../tools/carotid/geometry';
import type { CarotidResult } from '../tools/carotid/carotidTool';
import { intensityUnit, normaliseModality, type SequenceKind } from '../viewer/modality';

import type {
  Finding,
  FindingMetric,
  FindingSeverity,
  FindingStatementPart,
  FindingTarget,
} from './types';

/* ------------------------------------------------------------------ */
/* input                                                              */
/* ------------------------------------------------------------------ */

/**
 * A check that genuinely ran and found nothing abnormal.
 *
 * This is the ONLY door through which a green row reaches the panel (rule 1).
 * `deriveFindings` never manufactures one — the vascular-safety checks
 * (retropharyngeal carotid, aberrant subclavian) will hand them over once they
 * land; until then the caller passes none and no green rows appear, which is
 * the honest state of the world.
 */
export interface CompletedCheck {
  id: string;
  title: string;
  statement: string;
  evidence: string;
  source: string;
  /** Optional: only the caller can know where a passed check looked. */
  target?: FindingTarget;
}

export interface FindingsInput {
  modality: string | null | undefined;
  sequenceKind?: string | null;
  carotid: CarotidResult | null;
  airway: AirwayResult | null;
  /** True when the airway tool has a glottis mark, so the distance line is meaningful. */
  airwayGlottisMarked?: boolean;
  structures: Structure[];
  measurements: Measurement[];
  /** Checks that actually ran and passed. See `CompletedCheck`. */
  completedChecks?: CompletedCheck[];
}

/* ------------------------------------------------------------------ */
/* formatting helpers                                                 */
/* ------------------------------------------------------------------ */

/**
 * Every number the panel shows is formatted here with an explicit `toFixed`.
 * A template literal over a float dumps `13.700000000000001` into a report
 * line the first time the arithmetic is unlucky.
 */
function fixed(v: number | null | undefined, digits: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const SEQUENCE_KINDS: SequenceKind[] = [
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

/**
 * The caller stores `sequence_kind` as free-ish text; `intensityUnit` wants the
 * narrowed union. Anything unrecognised becomes null so the unit falls back to
 * the modality-level answer ("signal" on MR) rather than guessing "ADC".
 */
function asSequenceKind(raw: string | null | undefined): SequenceKind | null {
  const s = (raw ?? '').trim().toLowerCase();
  return (SEQUENCE_KINDS as string[]).includes(s) ? (s as SequenceKind) : null;
}

/** Join the parts of an evidence line, dropping the ones that had nothing to say. */
function evidenceLine(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' · ');
}

/* ------------------------------------------------------------------ */
/* 1. Carotid contact (order 10)                                      */
/* ------------------------------------------------------------------ */

/**
 * TOOLS-SPEC.md §1 already classified the contact angle; this only maps that
 * classification onto the panel's vocabulary. Abutment is a real, measured,
 * benign finding — so it is 'ok' *and* `checked`, which is exactly the case
 * rule 1 exists to protect: the tool ran, so the green row is earned.
 */
const CAROTID_SEVERITY: Record<CarotidResult['severity'], FindingSeverity> = {
  abutment: 'ok',
  partial: 'caution',
  encasement: 'danger',
};

const CAROTID_TONE: Record<CarotidResult['severity'], Finding['tone']> = {
  abutment: 'ok',
  partial: 'warn',
  encasement: 'danger',
};

const CAROTID_SIDE: Record<CarotidResult['side'], string> = {
  left: 'Left ICA',
  right: 'Right ICA',
};

function carotidFinding(result: CarotidResult): Finding {
  const lumenDiameterMm = result.radiusMm * 2;
  const statement: FindingStatementPart[] = [
    { text: `${CAROTID_SIDE[result.side]} contact ` },
    { text: fixed(result.angleDeg, 0), mono: true },
    { text: '°' },
  ];

  return {
    id: 'carotid',
    kind: 'carotid',
    severity: CAROTID_SEVERITY[result.severity],
    // The tool cannot produce a result without both outlines, so reaching here
    // always means the check ran.
    checked: true,
    title: 'Carotid contact',
    statement,
    evidence: evidenceLine([
      `longest arc ${fixed(result.longestArcDeg, 0)}°`,
      `lumen ⌀ ${fixed(lumenDiameterMm, 1)} mm`,
      `slice ${result.sliceIndex + 1}`,
      clockLabel(result),
    ]),
    metrics: [
      { value: fixed(result.angleDeg, 0), unit: '°', label: 'contact' },
      { value: fixed(result.longestArcDeg, 0), unit: '°', label: 'longest arc' },
      { value: fixed(lumenDiameterMm, 1), unit: 'mm', label: 'lumen ⌀' },
    ],
    target: {
      world: result.centerWorld as Triple,
      pane: 'axial',
      sliceIndex: result.sliceIndex,
    },
    tone: CAROTID_TONE[result.severity],
    order: 10,
    source: 'Carotid encasement tool',
  };
}

/* ------------------------------------------------------------------ */
/* 2. Airway patency (order 20)                                       */
/* ------------------------------------------------------------------ */

/**
 * Patency thresholds, in minimum *equivalent diameter*.
 *
 * These are a patency flag for anaesthesia (ROADMAP.md item 8) and explicitly
 * NOT a stenosis grade. A grade is a ratio against an assumed-normal lumen for
 * the patient's age and needs a validated reference; a patency flag is the far
 * humbler question "will a tube fit, and should someone look before induction".
 * Roughly: ≥10 mm passes an adult tube without comment, 6–10 mm is worth a
 * conversation, below 6 mm someone needs to see the images before induction.
 * Changing these numbers changes a clinical hint, so change them on purpose.
 */
export const AIRWAY_PATENT_MM = 10;
export const AIRWAY_CAUTION_MM = 6;

function airwaySeverity(minDiameterMm: number): FindingSeverity {
  if (!Number.isFinite(minDiameterMm)) return 'info';
  if (minDiameterMm >= AIRWAY_PATENT_MM) return 'ok';
  if (minDiameterMm >= AIRWAY_CAUTION_MM) return 'caution';
  return 'danger';
}

const AIRWAY_TONE: Record<FindingSeverity, Finding['tone']> = {
  ok: 'ok',
  caution: 'warn',
  danger: 'danger',
  info: 'accent',
};

function airwayFinding(airway: AirwayResult, glottisMarked: boolean): Finding {
  const k = airway.min_csa_index;
  const csa = airway.min_csa_mm2;
  // The backend sends the per-sample equivalent diameters; falling back to the
  // circle-equivalent of the minimum CSA keeps older results readable.
  const fromProfile = airway.eq_diameter_mm?.[k];
  const minDiameter = isFiniteNumber(fromProfile)
    ? fromProfile
    : 2 * Math.sqrt(Math.max(0, csa) / Math.PI);

  const sliceIndex = airway.sample_k?.[k];
  const hasSlice = isFiniteNumber(sliceIndex);
  const distance = airway.distance_from_glottis_mm;
  const hasDistance = glottisMarked && isFiniteNumber(distance);

  const metrics: FindingMetric[] = [
    { value: fixed(csa, 1), unit: 'mm²', label: 'min CSA' },
    { value: fixed(minDiameter, 1), unit: 'mm', label: 'equivalent ⌀' },
  ];
  // Without a glottis mark the distance has no origin, so it is not reported
  // at all rather than reported from an assumed one.
  if (hasDistance) {
    metrics.push({ value: fixed(distance, 1), unit: 'mm', label: 'below glottis' });
  }

  const target: FindingTarget = { world: airway.min_csa_lps };
  if (hasSlice) target.sliceIndex = sliceIndex;

  const severity = airwaySeverity(minDiameter);

  return {
    id: 'airway',
    kind: 'airway',
    severity,
    checked: true,
    title: 'Airway patency',
    statement: [
      { text: 'Narrowest lumen ' },
      { text: fixed(csa, 1), mono: true },
      { text: ' mm² (⌀ ' },
      { text: fixed(minDiameter, 1), mono: true },
      { text: ' mm)' },
    ],
    evidence: evidenceLine([
      hasSlice ? `at slice ${sliceIndex + 1}` : null,
      hasDistance ? `${fixed(distance, 1)} mm below the glottis` : null,
      glottisMarked ? null : 'glottis not marked',
      airway.capped_at_glottis ? 'profile capped at the vocal folds' : null,
    ]),
    metrics,
    target,
    tone: AIRWAY_TONE[severity],
    order: 20,
    source: 'Airway analyser',
  };
}

/* ------------------------------------------------------------------ */
/* 3. Structure volumes (order 30+)                                   */
/* ------------------------------------------------------------------ */

/**
 * A raw region grow is a scratch object — someone clicking around to see what
 * connects — so it is not a finding. Only the sources that represent a
 * deliberate, repeatable segmentation earn a row.
 */
const REPORTABLE_SOURCES: ReadonlyArray<Structure['source']> = ['ai', 'threshold', 'airway'];

/** Past this the list stops being a summary and becomes a second Structures tab. */
export const MAX_STRUCTURE_ROWS = 12;

function structureFindings(input: FindingsInput): Finding[] {
  const modality = normaliseModality(input.modality);
  const kind = asSequenceKind(input.sequenceKind);
  const unit = intensityUnit(modality, kind);

  const eligible = (input.structures ?? [])
    .filter((s) => isFiniteNumber(s.volume_ml) && s.volume_ml > 0)
    .filter((s) => REPORTABLE_SOURCES.includes(s.source))
    .slice()
    .sort((a, b) => b.volume_ml - a.volume_ml);

  const shown = eligible.slice(0, MAX_STRUCTURE_ROWS);
  const out: Finding[] = shown.map((s, i) => {
    const stats: LabelStats | null = s.stats ?? null;
    const category = s.category ?? categoryForName(s.name);

    const metrics: FindingMetric[] = [
      { value: fixed(s.volume_ml, 1), unit: 'ml', label: 'volume' },
    ];
    if (stats) {
      // `mean_hu` is the wire name; the *unit* follows the modality, so an MR
      // ROI reads "signal" and never "HU".
      metrics.push({
        value: fixed(stats.mean_hu, 0),
        unit: unit.short,
        label: 'mean',
        sub: unit.long,
      });
      metrics.push({ value: fixed(stats.longest_axis_mm, 1), unit: 'mm', label: 'longest axis' });
    }

    return {
      id: `structure:${s.id}`,
      kind: 'structure',
      severity: 'info',
      // A segmentation ran and produced a volume: that much is measured fact.
      checked: true,
      title: s.name,
      statement: [
        { text: `${s.name} ` },
        { text: fixed(s.volume_ml, 1), mono: true },
        { text: ' ml' },
      ],
      evidence: evidenceLine([
        CATEGORY_LABEL[category],
        s.source,
        stats ? `longest axis ${fixed(stats.longest_axis_mm, 1)} mm` : null,
      ]),
      metrics,
      target: stats ? { world: stats.centroid_lps } : null,
      tone: 'accent',
      order: 30 + i,
      source: 'Structures',
    };
  });

  const hidden = eligible.length - shown.length;
  if (hidden > 0) {
    out.push({
      id: 'structure:more',
      kind: 'structure',
      severity: 'info',
      checked: true,
      title: `+ ${hidden} more structure${hidden === 1 ? '' : 's'}`,
      statement: [
        { text: '+ ' },
        { text: hidden.toFixed(0), mono: true },
        { text: ` more structure${hidden === 1 ? '' : 's'}` },
      ],
      evidence: 'open the Structures tab for the full list',
      metrics: [],
      target: null,
      tone: 'accent',
      order: 30 + shown.length,
      source: 'Structures',
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 4. Measurements (order 60+)                                        */
/* ------------------------------------------------------------------ */

function measurementFindings(list: Measurement[]): Finding[] {
  return (list ?? []).map((m, i) => {
    const target: FindingTarget = { pane: m.paneId };
    if (isFiniteNumber(m.sliceIndex)) target.sliceIndex = m.sliceIndex;

    return {
      id: `measurement:${m.uid}`,
      kind: 'measurement',
      severity: 'info',
      checked: true,
      title: m.toolName,
      statement: [{ text: `${m.toolName} ` }, { text: m.value, mono: true }],
      evidence:
        m.extra && m.extra.length > 0
          ? m.extra
          : evidenceLine([m.paneId, isFiniteNumber(m.sliceIndex) ? `slice ${m.sliceIndex + 1}` : null]),
      metrics: [],
      target,
      tone: 'accent',
      order: 60 + i,
      source: 'Measurements',
    };
  });
}

/* ------------------------------------------------------------------ */
/* 5. "Checked and normal" rows (order 90+)                           */
/* ------------------------------------------------------------------ */

function completedCheckFindings(list: CompletedCheck[]): Finding[] {
  return list.map((c, i) => ({
    id: `check:${c.id}`,
    kind: 'vascular',
    severity: 'ok',
    // The caller only builds a CompletedCheck for a check that executed. This
    // is the single place `checked: true` coincides with `severity: 'ok'` for a
    // row nobody measured a number on, so it is the one rule 1 guards.
    checked: true,
    title: c.title,
    statement: [{ text: c.statement }],
    evidence: c.evidence,
    metrics: [],
    target: c.target ?? null,
    tone: 'ok',
    order: 90 + i,
    source: c.source,
  }));
}

/* ------------------------------------------------------------------ */
/* ordering                                                           */
/* ------------------------------------------------------------------ */

/** Worst first: a reader scanning the top of the list must see the danger. */
export function severityRank(s: FindingSeverity): number {
  switch (s) {
    case 'danger':
      return 0;
    case 'caution':
      return 1;
    case 'ok':
      return 2;
    default:
      return 3;
  }
}

/** Severity, then the derivation's own weight, then title. Stable. */
export function sortFindings(list: Finding[]): Finding[] {
  return list.slice().sort((a, b) => {
    const s = severityRank(a.severity) - severityRank(b.severity);
    if (s !== 0) return s;
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title);
  });
}

/* ------------------------------------------------------------------ */
/* the derivation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Turn the current session into the Findings list, already sorted.
 *
 * Nothing in here reaches for a store: every input is passed in, so the panel
 * is a `useMemo` and this file is testable on plain objects.
 */
export function deriveFindings(input: FindingsInput): Finding[] {
  const out: Finding[] = [];

  if (input.carotid) out.push(carotidFinding(input.carotid));
  if (input.airway) out.push(airwayFinding(input.airway, input.airwayGlottisMarked === true));
  out.push(...structureFindings(input));
  out.push(...measurementFindings(input.measurements ?? []));
  // Rule 1: the ONLY source of green rows. Nothing above may invent one.
  out.push(...completedCheckFindings(input.completedChecks ?? []));

  return sortFindings(out);
}

/* ------------------------------------------------------------------ */
/* derived views                                                      */
/* ------------------------------------------------------------------ */

export interface FindingsSummary {
  danger: number;
  caution: number;
  ok: number;
  info: number;
  total: number;
}

/** Counts for the tab badge. */
export function findingsSummary(list: Finding[]): FindingsSummary {
  const out: FindingsSummary = { danger: 0, caution: 0, ok: 0, info: 0, total: 0 };
  for (const f of list) {
    out[f.severity] += 1;
    out.total += 1;
  }
  return out;
}

export interface ScrubberMarker {
  id: string;
  slice: number;
  tone: Finding['tone'];
  title: string;
}

/**
 * Markers for one pane's scrubber (UI-OVERHAUL.md §2).
 *
 * A finding with no `pane` is pane-agnostic (an airway minimum is a slice in
 * whatever stack the profile was sampled from) and shows on every scrubber; a
 * finding that names a pane only shows on that one, so a carotid angle
 * measured on axial never marks the sagittal scrubber at a meaningless index.
 */
export function scrubberMarkers(list: Finding[], pane: PaneId): ScrubberMarker[] {
  const seen = new Set<string>();
  const out: ScrubberMarker[] = [];

  for (const f of list) {
    const t = f.target;
    if (!t || !isFiniteNumber(t.sliceIndex)) continue;
    if (t.pane !== undefined && t.pane !== pane) continue;
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push({ id: f.id, slice: t.sliceIndex, tone: f.tone, title: f.title });
  }

  return out.sort((a, b) => a.slice - b.slice);
}
