/**
 * Neck level mapper — per-side tally and a conservative, deterministic
 * plain-English neck dissection summary.
 *
 * This deliberately does NOT encode clinical decision rules. It states which
 * levels contain classified nodes and the contiguous range those levels span.
 * The one fixed caveat it carries is the primary-site reminder about level Ib,
 * which the surgeon resolves, not this code.
 */

import type { LevelResult, NeckLevel, Side } from './types';

export const SIDES: Side[] = ['right', 'left', 'midline'];

/** Canonical display order for levels. */
export const LEVEL_ORDER: NeckLevel[] = [
  'Ia',
  'Ib',
  'IIa',
  'IIb',
  'III',
  'IV',
  'Va',
  'Vb',
  'VI',
  'VII',
  'RP',
  'unclassified',
];

/** The Roman numeral group a level belongs to; null for RP / unclassified. */
export type LevelGroup = 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI' | 'VII';

export const GROUP_ORDER: LevelGroup[] = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

const GROUP_OF: Record<NeckLevel, LevelGroup | null> = {
  Ia: 'I',
  Ib: 'I',
  IIa: 'II',
  IIb: 'II',
  III: 'III',
  IV: 'IV',
  Va: 'V',
  Vb: 'V',
  VI: 'VI',
  VII: 'VII',
  RP: null,
  unclassified: null,
};

export type LevelCounts = Record<NeckLevel, number>;
export type LevelTally = Record<Side, LevelCounts>;

function emptyCounts(): LevelCounts {
  const c = {} as LevelCounts;
  for (const l of LEVEL_ORDER) c[l] = 0;
  return c;
}

/** Count classified nodes per side per level. Every key is always present. */
export function tallyLevels(results: LevelResult[]): LevelTally {
  const tally = {} as LevelTally;
  for (const s of SIDES) tally[s] = emptyCounts();
  for (const r of results) {
    if (!tally[r.side]) tally[r.side] = emptyCounts();
    tally[r.side][r.level] = (tally[r.side][r.level] ?? 0) + 1;
  }
  return tally;
}

/** Total number of nodes counted on a side. */
export function sideTotal(counts: LevelCounts): number {
  return LEVEL_ORDER.reduce((sum, l) => sum + (counts[l] ?? 0), 0);
}

const SIDE_NAME: Record<Side, string> = {
  right: 'Right',
  left: 'Left',
  midline: 'Midline',
};

const EN_DASH = '–';

function listLevels(levels: NeckLevel[]): string {
  if (levels.length === 1) return levels[0];
  if (levels.length === 2) return `${levels[0]} and ${levels[1]}`;
  return `${levels.slice(0, -1).join(', ')} and ${levels[levels.length - 1]}`;
}

/**
 * One sentence for one side. Returns null when that side has no nodes.
 * Deterministic: the same tally always produces the same string.
 */
export function sideSuggestion(side: Side, counts: LevelCounts): string | null {
  if (sideTotal(counts) === 0) return null;

  const involved = LEVEL_ORDER.filter((l) => (counts[l] ?? 0) > 0);
  const nodal = involved.filter((l) => l !== 'RP' && l !== 'unclassified');
  const groups = GROUP_ORDER.filter((g) => nodal.some((l) => GROUP_OF[l] === g));

  const parts: string[] = [];

  if (nodal.length > 0) {
    const noun = nodal.length === 1 ? 'level' : 'levels';
    parts.push(`${noun} ${listLevels(nodal)} involved`);

    const first = groups[0];
    const last = groups[groups.length - 1];
    const span = first === last ? first : `${first}${EN_DASH}${last}`;
    const firstIdx = GROUP_ORDER.indexOf(first);
    const lastIdx = GROUP_ORDER.indexOf(last);
    const contiguous = lastIdx - firstIdx + 1 === groups.length;

    let advice = `consider selective neck dissection ${span}`;
    if (!contiguous) advice += ` (the involved levels are not contiguous)`;
    if ((counts.Ib ?? 0) === 0) advice += ` (+ Ib if oral cavity primary)`;
    parts.push(advice);
  }

  if ((counts.RP ?? 0) > 0) {
    const n = counts.RP;
    parts.push(
      `${n} retropharyngeal ${n === 1 ? 'node' : 'nodes'} — not addressed by a standard neck dissection`,
    );
  }
  if ((counts.unclassified ?? 0) > 0) {
    const n = counts.unclassified;
    parts.push(`${n} ${n === 1 ? 'node' : 'nodes'} unclassified — verify the landmarks`);
  }

  return `${SIDE_NAME[side]}: ${parts.join('; ')}`;
}

/**
 * One plain-English line per side that has nodes, in the fixed order
 * right, left, midline. Empty array when nothing was classified.
 */
export function neckDissectionSuggestion(tally: LevelTally): string[] {
  const out: string[] = [];
  for (const s of SIDES) {
    const counts = tally[s];
    if (!counts) continue;
    const line = sideSuggestion(s, counts);
    if (line) out.push(line);
  }
  return out;
}

/** The same lines joined for display, or a neutral message when there are none. */
export function neckDissectionSummary(tally: LevelTally): string {
  const lines = neckDissectionSuggestion(tally);
  return lines.length === 0 ? 'No nodes classified.' : lines.join('\n');
}
