/**
 * The shape of one row in the Findings tab.
 *
 * The right panel opens on Findings the moment a study is open (DESIGN.md
 * "v2 concept" §2, UI-OVERHAUL.md §3), so this file has to describe *every*
 * thing Margin can say about a study in one uniform row — a carotid contact
 * angle, an airway lumen, a segmented volume, a caliper — without the panel
 * needing to know which tool produced it.
 *
 * Two rules are baked into the shape itself and must survive every future
 * edit:
 *
 *   1. `checked` exists so that "we looked and it was normal" can never be
 *      confused with "nobody looked". Absence of evidence is not evidence of
 *      absence: the panel paints a row green only when `checked === true` AND
 *      `severity === 'ok'`. A row that is merely missing says nothing.
 *
 *   2. There is deliberately no field for a stenosis grade. ROADMAP.md puts
 *      airway stenosis grading out of scope; the airway is a *patency flag*.
 *      A `grade` field would invite someone to fill it, so it does not exist.
 *
 * `statement` is an array rather than a string because the number inside the
 * headline is set in mono while the prose around it is not, and splitting it
 * here keeps the panel from having to parse its own copy back out with a
 * regex.
 */
import type { Triple } from '../api/client';
import type { PaneId } from '../store/useAppStore';

export type { Triple, PaneId };

export type FindingSeverity = 'ok' | 'caution' | 'danger' | 'info';

export type FindingKind =
  | 'carotid'
  | 'airway'
  | 'structure'
  | 'measurement'
  | 'node'
  | 'tumour'
  | 'vascular';

/** Where a finding lives, so the row can jump there. */
export interface FindingTarget {
  /** LPS mm — preferred: works on every plane. */
  world?: Triple;
  /** Slice index in a named pane, for rows that only know a slice. */
  pane?: PaneId;
  sliceIndex?: number;
}

/** One number worth showing as an evidence tile. */
export interface FindingMetric {
  /** Already formatted; the panel never rounds. */
  value: string;
  unit?: string;
  label: string;
  sub?: string;
}

/** One segment of a headline statement. `mono` marks the number. */
export interface FindingStatementPart {
  text: string;
  mono?: boolean;
}

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  /** True only when a check actually ran. Gates the green rows. */
  checked: boolean;
  /** The headline. The number inside it is wrapped — see `statement` below. */
  title: string;
  /**
   * Statement split so the panel can render the number in mono:
   * `[{text:'Right ICA contact '}, {text:'139', mono:true}, {text:'° over 3 slices'}]`
   */
  statement: FindingStatementPart[];
  /** ONE line of evidence/provenance under the statement. */
  evidence: string;
  /** Tiles for the expanded row and for Ask answers. */
  metrics: FindingMetric[];
  target: FindingTarget | null;
  /** Scrubber marker tone (UI-OVERHAUL.md §2). */
  tone: 'warn' | 'danger' | 'node' | 'tumor' | 'ok' | 'accent';
  /** Sort weight; lower sorts first. Computed by `derive`. */
  order: number;
  /** Which tool produced it, for the "source" line. */
  source: string;
}
