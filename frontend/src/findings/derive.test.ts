/**
 * Findings derivation tests.
 *
 * Everything is a plain object fixture: none of the real stores are imported,
 * so a change to zustand wiring or to Cornerstone can never make this suite
 * red for the wrong reason, and the two clinical rules stay pinned to the
 * derivation itself.
 */
import { describe, expect, it } from 'vitest';

import type { AirwayResult, LabelStats, Triple } from '../api/client';
import type { Structure } from '../labels/structureStore';
import type { Measurement } from '../store/useAppStore';
import type { CarotidResult } from '../tools/carotid/carotidTool';

import {
  deriveFindings,
  findingsSummary,
  scrubberMarkers,
  severityRank,
  sortFindings,
  type CompletedCheck,
  type FindingsInput,
} from './derive';
import type { Finding } from './types';

/* ------------------------------------------------------------------ */
/* fixtures                                                           */
/* ------------------------------------------------------------------ */

function baseInput(patch: Partial<FindingsInput> = {}): FindingsInput {
  return {
    modality: 'CT',
    carotid: null,
    airway: null,
    structures: [],
    measurements: [],
    ...patch,
  };
}

function carotid(patch: Partial<CarotidResult> = {}): CarotidResult {
  return {
    angleDeg: 139.4,
    longestArcDeg: 120,
    arcs: [{ startDeg: 30, endDeg: 150 }],
    clockFrom: 1,
    clockTo: 5,
    severity: 'abutment',
    side: 'right',
    sliceIndex: 42,
    radiusMm: 2.6,
    centerWorld: [-12.5, 30, -80],
    toleranceMm: 1.5,
    ...patch,
  };
}

function airway(patch: Partial<AirwayResult> = {}): AirwayResult {
  return {
    label_id: 'lbl-airway',
    centerline_lps: [[0, 0, 0]],
    sample_k: [10, 11, 12],
    arclength_mm: [0, 1, 2],
    csa_mm2: [120, 80, 100],
    eq_diameter_mm: [12.4, 12, 11],
    min_diameter_mm: [10, 9, 9],
    max_diameter_mm: [14, 13, 13],
    csa_ref_mm2: 160,
    min_csa_mm2: 113.1,
    min_csa_index: 1,
    min_csa_lps: [1, 2, 3],
    stenosis_pct: 29.3,
    stenosis_length_mm: 8,
    distance_from_glottis_mm: 22.5,
    myer_cotton_grade: 'II',
    took_ms: 900,
    ...patch,
  };
}

function stats(patch: Partial<LabelStats> = {}): LabelStats {
  return {
    label_id: 'lbl',
    n_voxels: 1000,
    volume_ml: 4.2,
    bbox_ijk: [0, 0, 0, 10, 10, 10],
    centroid_lps: [5, 6, 7],
    mean_hu: 64.2,
    std_hu: 12,
    longest_axis_mm: 33.44,
    diameters_mm: [10, 20, 30],
    took_ms: 5,
    ...patch,
  };
}

function structure(patch: Partial<Structure> = {}): Structure {
  return {
    id: 'st-1',
    label_id: 'lbl-1',
    name: 'Tumour',
    color: [226, 85, 161],
    volume_ml: 12.34,
    visible: true,
    opacity: 0.5,
    source: 'ai',
    series_uid: 'series-1',
    segmentationId: 'seg-1',
    segmentIndex: 1,
    category: 'other',
    stats: null,
    loaded: true,
    in3d: false,
    busy: null,
    error: null,
    ...patch,
  };
}

function measurement(patch: Partial<Measurement> = {}): Measurement {
  return {
    uid: 'm-1',
    toolName: 'Length',
    value: '24.1 mm',
    extra: '',
    paneId: 'axial',
    sliceIndex: 17,
    ...patch,
  };
}

function find(list: Finding[], id: string): Finding {
  const f = list.find((x) => x.id === id);
  if (!f) throw new Error(`no finding with id ${id}`);
  return f;
}

function plain(parts: Finding['statement']): string {
  return parts.map((p) => p.text).join('');
}

/* ------------------------------------------------------------------ */
/* carotid                                                            */
/* ------------------------------------------------------------------ */

describe('carotid findings', () => {
  it('maps abutment to a checked, ok row', () => {
    const list = deriveFindings(baseInput({ carotid: carotid({ severity: 'abutment' }) }));
    const f = find(list, 'carotid');
    expect(f.severity).toBe('ok');
    expect(f.tone).toBe('ok');
    expect(f.checked).toBe(true);
    expect(f.kind).toBe('carotid');
    expect(f.order).toBe(10);
    expect(f.source).toBe('Carotid encasement tool');
  });

  it('maps partial encasement to caution/warn', () => {
    const list = deriveFindings(baseInput({ carotid: carotid({ severity: 'partial' }) }));
    expect(find(list, 'carotid').severity).toBe('caution');
    expect(find(list, 'carotid').tone).toBe('warn');
  });

  it('maps encasement to danger/danger', () => {
    const list = deriveFindings(baseInput({ carotid: carotid({ severity: 'encasement' }) }));
    expect(find(list, 'carotid').severity).toBe('danger');
    expect(find(list, 'carotid').tone).toBe('danger');
  });

  it('splits the statement so the angle can be set in mono', () => {
    const list = deriveFindings(baseInput({ carotid: carotid({ angleDeg: 139.4 }) }));
    const f = find(list, 'carotid');
    expect(plain(f.statement)).toBe('Right ICA contact 139°');
    expect(f.statement.filter((p) => p.mono === true)).toHaveLength(1);
    expect(f.statement.find((p) => p.mono)?.text).toBe('139');
  });

  it('names the left side from the result', () => {
    const list = deriveFindings(baseInput({ carotid: carotid({ side: 'left' }) }));
    expect(plain(find(list, 'carotid').statement)).toContain('Left ICA');
  });

  it('reports arc, lumen diameter, slice and the clock label as evidence', () => {
    const list = deriveFindings(baseInput({ carotid: carotid() }));
    expect(find(list, 'carotid').evidence).toBe(
      "longest arc 120° · lumen ⌀ 5.2 mm · slice 43 · 1–5 o'clock",
    );
  });

  it('omits the clock label when nothing was in contact', () => {
    const list = deriveFindings(
      baseInput({ carotid: carotid({ clockFrom: null, clockTo: null }) }),
    );
    expect(find(list, 'carotid').evidence).not.toContain("o'clock");
  });

  it('exposes contact, longest arc and lumen diameter as metrics', () => {
    const f = find(deriveFindings(baseInput({ carotid: carotid() })), 'carotid');
    expect(f.metrics).toHaveLength(3);
    expect(f.metrics[0]).toEqual({ value: '139', unit: '°', label: 'contact' });
    expect(f.metrics[1]).toEqual({ value: '120', unit: '°', label: 'longest arc' });
    expect(f.metrics[2]).toEqual({ value: '5.2', unit: 'mm', label: 'lumen ⌀' });
  });

  it('targets the lumen centre on the axial pane', () => {
    const f = find(deriveFindings(baseInput({ carotid: carotid() })), 'carotid');
    expect(f.target).toEqual({ world: [-12.5, 30, -80], pane: 'axial', sliceIndex: 42 });
  });
});

/* ------------------------------------------------------------------ */
/* airway                                                             */
/* ------------------------------------------------------------------ */

describe('airway findings', () => {
  const withDiameter = (mm: number, patch: Partial<AirwayResult> = {}) =>
    airway({ eq_diameter_mm: [20, mm, 20], min_csa_index: 1, ...patch });

  it('calls a 12 mm lumen patent', () => {
    const list = deriveFindings(
      baseInput({ airway: withDiameter(12), airwayGlottisMarked: true }),
    );
    const f = find(list, 'airway');
    expect(f.severity).toBe('ok');
    expect(f.tone).toBe('ok');
    expect(f.checked).toBe(true);
    expect(f.order).toBe(20);
  });

  it('calls an 8 mm lumen a caution', () => {
    const list = deriveFindings(baseInput({ airway: withDiameter(8) }));
    expect(find(list, 'airway').severity).toBe('caution');
    expect(find(list, 'airway').tone).toBe('warn');
  });

  it('calls a 4 mm lumen a danger', () => {
    const list = deriveFindings(baseInput({ airway: withDiameter(4) }));
    expect(find(list, 'airway').severity).toBe('danger');
    expect(find(list, 'airway').tone).toBe('danger');
  });

  it('falls back to the circle-equivalent diameter when the profile is missing', () => {
    const list = deriveFindings(
      baseInput({
        airway: airway({ eq_diameter_mm: [], min_csa_mm2: 113.1, min_csa_index: 1 }),
      }),
    );
    // 2 * sqrt(113.1 / pi) = 12.0 mm -> patent.
    const f = find(list, 'airway');
    expect(f.severity).toBe('ok');
    expect(f.metrics[1].value).toBe('12.0');
  });

  it('writes the narrowest lumen with both numbers in mono', () => {
    const f = find(deriveFindings(baseInput({ airway: withDiameter(8) })), 'airway');
    expect(plain(f.statement)).toBe('Narrowest lumen 113.1 mm² (⌀ 8.0 mm)');
    expect(f.statement.filter((p) => p.mono === true)).toHaveLength(2);
  });

  it('reports the distance from the glottis only when the glottis was marked', () => {
    const f = find(
      deriveFindings(baseInput({ airway: airway(), airwayGlottisMarked: true })),
      'airway',
    );
    expect(f.evidence).toContain('22.5 mm below the glottis');
    expect(f.evidence).not.toContain('glottis not marked');
    expect(f.metrics.map((m) => m.label)).toContain('below glottis');
  });

  it('says "glottis not marked" and drops the distance when it was not', () => {
    const f = find(
      deriveFindings(baseInput({ airway: airway(), airwayGlottisMarked: false })),
      'airway',
    );
    expect(f.evidence).toContain('glottis not marked');
    expect(f.evidence).not.toContain('below the glottis');
    expect(f.metrics.map((m) => m.label)).not.toContain('below glottis');
  });

  it('notes a profile capped at the vocal folds', () => {
    const f = find(
      deriveFindings(
        baseInput({ airway: airway({ capped_at_glottis: true }), airwayGlottisMarked: true }),
      ),
      'airway',
    );
    expect(f.evidence).toContain('profile capped at the vocal folds');
    expect(f.evidence).toContain('at slice 12');
  });

  it('targets the minimum-CSA world point and its slice', () => {
    const f = find(deriveFindings(baseInput({ airway: airway() })), 'airway');
    expect(f.target).toEqual({ world: [1, 2, 3], sliceIndex: 11 });
  });

  it('omits the slice when the backend sent no sample_k', () => {
    const f = find(
      deriveFindings(baseInput({ airway: airway({ sample_k: undefined }) })),
      'airway',
    );
    expect(f.target).toEqual({ world: [1, 2, 3] });
    expect(f.evidence).not.toContain('at slice');
  });

  /**
   * Rule 2 regression: airway stenosis grading is out of scope (ROADMAP.md).
   * The backend still sends `myer_cotton_grade` and `stenosis_pct`; nothing we
   * produce may echo them or imply a grade.
   */
  it('never emits a Myer–Cotton grade or any grade wording', () => {
    const list = deriveFindings(
      baseInput({
        airway: airway({ myer_cotton_grade: 'IV', stenosis_pct: 91.4 }),
        airwayGlottisMarked: true,
      }),
    );
    const json = JSON.stringify(list);
    expect(json).not.toMatch(/Myer/i);
    expect(json).not.toContain('myer_cotton');
    expect(json).not.toMatch(/grade/i);
    expect(json).not.toContain('91.4');
    expect(json).not.toMatch(/stenosis/i);
  });
});

/* ------------------------------------------------------------------ */
/* structures                                                         */
/* ------------------------------------------------------------------ */

describe('structure findings', () => {
  it('excludes region-grow scratch objects and zero-volume rows', () => {
    const list = deriveFindings(
      baseInput({
        structures: [
          structure({ id: 'a', name: 'Grown blob', source: 'region-grow', volume_ml: 50 }),
          structure({ id: 'b', name: 'Empty', source: 'ai', volume_ml: 0 }),
          structure({ id: 'c', name: 'Parotid', source: 'ai', volume_ml: 22.5 }),
          structure({ id: 'd', name: 'Airway', source: 'airway', volume_ml: 9 }),
          structure({ id: 'e', name: 'Bone', source: 'threshold', volume_ml: 300 }),
        ],
      }),
    );
    const ids = list.filter((f) => f.kind === 'structure').map((f) => f.id);
    expect(ids).toEqual(['structure:e', 'structure:c', 'structure:d']);
  });

  it('formats the volume to one decimal, in mono', () => {
    const f = find(
      deriveFindings(baseInput({ structures: [structure({ volume_ml: 12.3456 })] })),
      'structure:st-1',
    );
    expect(plain(f.statement)).toBe('Tumour 12.3 ml');
    expect(f.statement.find((p) => p.mono)?.text).toBe('12.3');
    expect(f.severity).toBe('info');
    expect(f.tone).toBe('accent');
    expect(f.checked).toBe(true);
    expect(f.source).toBe('Structures');
  });

  it('puts the category label and the source in the evidence line', () => {
    const f = find(
      deriveFindings(
        baseInput({ structures: [structure({ category: 'nodal', source: 'ai' })] }),
      ),
      'structure:st-1',
    );
    expect(f.evidence).toBe('Nodal levels · ai');
    expect(f.target).toBeNull();
  });

  it('adds the longest axis and the centroid target when stats exist', () => {
    const f = find(
      deriveFindings(baseInput({ structures: [structure({ stats: stats() })] })),
      'structure:st-1',
    );
    expect(f.evidence).toBe('Other · ai · longest axis 33.4 mm');
    expect(f.target).toEqual({ world: [5, 6, 7] });
    expect(f.metrics.map((m) => m.label)).toEqual(['volume', 'mean', 'longest axis']);
  });

  it('labels CT intensity in HU', () => {
    const f = find(
      deriveFindings(baseInput({ modality: 'CT', structures: [structure({ stats: stats() })] })),
      'structure:st-1',
    );
    expect(f.metrics[1].unit).toBe('HU');
    expect(f.metrics[1].value).toBe('64');
  });

  it('labels MR intensity "signal", never HU', () => {
    const f = find(
      deriveFindings(
        baseInput({
          modality: 'MR',
          sequenceKind: 't1c',
          structures: [structure({ stats: stats() })],
        }),
      ),
      'structure:st-1',
    );
    expect(f.metrics[1].unit).toBe('signal');
    expect(JSON.stringify(f.metrics)).not.toContain('HU');
  });

  it('caps the list at 12 rows, keeping the largest, and adds a summary row', () => {
    const many: Structure[] = Array.from({ length: 15 }, (_, i) =>
      structure({ id: `s${i}`, name: `Structure ${i}`, volume_ml: i + 1 }),
    );
    const list = deriveFindings(baseInput({ structures: many }));
    const rows = list.filter((f) => f.kind === 'structure');
    expect(rows).toHaveLength(13);

    const more = find(list, 'structure:more');
    expect(more.title).toBe('+ 3 more structures');
    expect(more.severity).toBe('info');
    expect(more.checked).toBe(true);
    expect(more.target).toBeNull();
    expect(more.metrics).toEqual([]);

    // The three smallest were dropped, the largest kept.
    const kept = rows.filter((f) => f.id !== 'structure:more').map((f) => f.title);
    expect(kept[0]).toBe('Structure 14');
    expect(kept).not.toContain('Structure 0');
    expect(kept).not.toContain('Structure 2');
  });

  it('singularises the summary row when exactly one is hidden', () => {
    const many: Structure[] = Array.from({ length: 13 }, (_, i) =>
      structure({ id: `s${i}`, name: `Structure ${i}`, volume_ml: i + 1 }),
    );
    expect(find(deriveFindings(baseInput({ structures: many })), 'structure:more').title).toBe(
      '+ 1 more structure',
    );
  });

  it('adds no summary row at exactly 12 structures', () => {
    const many: Structure[] = Array.from({ length: 12 }, (_, i) =>
      structure({ id: `s${i}`, name: `Structure ${i}`, volume_ml: i + 1 }),
    );
    const list = deriveFindings(baseInput({ structures: many }));
    expect(list.filter((f) => f.kind === 'structure')).toHaveLength(12);
    expect(list.some((f) => f.id === 'structure:more')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* measurements                                                       */
/* ------------------------------------------------------------------ */

describe('measurement findings', () => {
  it('turns each measurement into an info row with a mono value', () => {
    const f = find(
      deriveFindings(baseInput({ measurements: [measurement({ extra: 'axial · 2 pts' })] })),
      'measurement:m-1',
    );
    expect(f.kind).toBe('measurement');
    expect(f.severity).toBe('info');
    expect(f.tone).toBe('accent');
    expect(f.checked).toBe(true);
    expect(f.title).toBe('Length');
    expect(plain(f.statement)).toBe('Length 24.1 mm');
    expect(f.statement.find((p) => p.mono)?.text).toBe('24.1 mm');
    expect(f.evidence).toBe('axial · 2 pts');
    expect(f.target).toEqual({ pane: 'axial', sliceIndex: 17 });
    expect(f.source).toBe('Measurements');
  });

  it('falls back to the pane and slice when there is no extra text', () => {
    const f = find(
      deriveFindings(baseInput({ measurements: [measurement({ extra: '' })] })),
      'measurement:m-1',
    );
    expect(f.evidence).toBe('axial · slice 18');
  });

  it('drops a null slice index from the target', () => {
    const f = find(
      deriveFindings(
        baseInput({ measurements: [measurement({ sliceIndex: null, paneId: 'volume3d' })] }),
      ),
      'measurement:m-1',
    );
    expect(f.target).toEqual({ pane: 'volume3d' });
    expect(f.evidence).toBe('volume3d');
  });

  it('numbers successive measurements so they keep insertion order', () => {
    const list = deriveFindings(
      baseInput({
        measurements: [measurement({ uid: 'a' }), measurement({ uid: 'b', toolName: 'Angle' })],
      }),
    );
    expect(find(list, 'measurement:a').order).toBe(60);
    expect(find(list, 'measurement:b').order).toBe(61);
  });
});

/* ------------------------------------------------------------------ */
/* rule 1 — green rows                                                */
/* ------------------------------------------------------------------ */

describe('completed checks (rule 1 regression)', () => {
  const check: CompletedCheck = {
    id: 'retro-carotid',
    title: 'Retropharyngeal carotid',
    statement: 'No retropharyngeal course on either side',
    evidence: 'both carotids lateral to the pharyngeal wall on every axial slice',
    source: 'Vascular safety checks',
  };

  /**
   * Absence of evidence is never evidence of absence: with no check supplied,
   * nothing in the derivation may produce an 'ok' row. If this ever fails,
   * something started inventing reassurance.
   */
  it('produces NO ok-severity row when no check ran', () => {
    const list = deriveFindings(
      baseInput({
        airway: airway({ eq_diameter_mm: [4, 4, 4] }),
        structures: [structure()],
        measurements: [measurement()],
        completedChecks: [],
      }),
    );
    expect(list.filter((f) => f.severity === 'ok')).toHaveLength(0);
  });

  it('produces no ok row when completedChecks is omitted entirely', () => {
    const list = deriveFindings(baseInput({ structures: [structure()] }));
    expect(list.some((f) => f.severity === 'ok')).toBe(false);
  });

  it('produces exactly one green row per check that actually ran', () => {
    const list = deriveFindings(baseInput({ completedChecks: [check] }));
    const f = find(list, 'check:retro-carotid');
    expect(f.severity).toBe('ok');
    expect(f.tone).toBe('ok');
    expect(f.checked).toBe(true);
    expect(f.kind).toBe('vascular');
    expect(f.order).toBe(90);
    expect(plain(f.statement)).toBe('No retropharyngeal course on either side');
    expect(f.metrics).toEqual([]);
    expect(f.target).toBeNull();
    expect(f.source).toBe('Vascular safety checks');
  });

  it('carries a target through when the caller supplies one', () => {
    const list = deriveFindings(
      baseInput({
        completedChecks: [{ ...check, target: { pane: 'axial', sliceIndex: 5 } }],
      }),
    );
    expect(find(list, 'check:retro-carotid').target).toEqual({ pane: 'axial', sliceIndex: 5 });
  });
});

/* ------------------------------------------------------------------ */
/* ordering, summary, markers                                         */
/* ------------------------------------------------------------------ */

describe('sorting and derived views', () => {
  const row = (patch: Partial<Finding>): Finding => ({
    id: 'x',
    kind: 'structure',
    severity: 'info',
    checked: true,
    title: 'X',
    statement: [{ text: 'X' }],
    evidence: '',
    metrics: [],
    target: null,
    tone: 'accent',
    order: 0,
    source: 'test',
    ...patch,
  });

  it('ranks severities worst-first', () => {
    expect(severityRank('danger')).toBe(0);
    expect(severityRank('caution')).toBe(1);
    expect(severityRank('ok')).toBe(2);
    expect(severityRank('info')).toBe(3);
  });

  it('sorts by severity, then order, then title', () => {
    const list = [
      row({ id: 'i', severity: 'info', order: 5, title: 'Info' }),
      row({ id: 'o', severity: 'ok', order: 90, title: 'Ok' }),
      row({ id: 'c2', severity: 'caution', order: 20, title: 'B' }),
      row({ id: 'c1', severity: 'caution', order: 10, title: 'A' }),
      row({ id: 'd', severity: 'danger', order: 99, title: 'Danger' }),
      row({ id: 'c3', severity: 'caution', order: 10, title: 'Aa' }),
    ];
    expect(sortFindings(list).map((f) => f.id)).toEqual(['d', 'c1', 'c3', 'c2', 'o', 'i']);
  });

  it('does not mutate the input array', () => {
    const list = [row({ id: 'a', severity: 'info' }), row({ id: 'b', severity: 'danger' })];
    sortFindings(list);
    expect(list.map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('returns an already-sorted list from deriveFindings', () => {
    const list = deriveFindings(
      baseInput({
        carotid: carotid({ severity: 'encasement' }),
        airway: airway({ eq_diameter_mm: [8, 8, 8] }),
        structures: [structure()],
        measurements: [measurement()],
      }),
    );
    expect(list.map((f) => f.id)).toEqual([
      'carotid',
      'airway',
      'structure:st-1',
      'measurement:m-1',
    ]);
  });

  it('counts each severity and the total', () => {
    const summary = findingsSummary([
      row({ severity: 'danger' }),
      row({ severity: 'danger' }),
      row({ severity: 'caution' }),
      row({ severity: 'ok' }),
      row({ severity: 'info' }),
      row({ severity: 'info' }),
      row({ severity: 'info' }),
    ]);
    expect(summary).toEqual({ danger: 2, caution: 1, ok: 1, info: 3, total: 7 });
  });

  it('counts an empty list as all zeroes', () => {
    expect(findingsSummary([])).toEqual({ danger: 0, caution: 0, ok: 0, info: 0, total: 0 });
  });

  it('keeps only markers for this pane, plus the pane-agnostic ones', () => {
    const markers = scrubberMarkers(
      [
        row({ id: 'ax', target: { pane: 'axial', sliceIndex: 9 }, tone: 'danger', title: 'Ax' }),
        row({ id: 'sag', target: { pane: 'sagittal', sliceIndex: 3 } }),
        row({ id: 'any', target: { sliceIndex: 1 }, tone: 'warn', title: 'Any' }),
        row({ id: 'nowhere', target: null }),
        row({ id: 'worldonly', target: { world: [0, 0, 0] as Triple } }),
      ],
      'axial',
    );
    expect(markers.map((m) => m.id)).toEqual(['any', 'ax']);
    expect(markers[0]).toEqual({ id: 'any', slice: 1, tone: 'warn', title: 'Any' });
    expect(markers[1].tone).toBe('danger');
  });

  it('sorts markers by slice', () => {
    const markers = scrubberMarkers(
      [
        row({ id: 'c', target: { sliceIndex: 30 } }),
        row({ id: 'a', target: { sliceIndex: 2 } }),
        row({ id: 'b', target: { sliceIndex: 11 } }),
      ],
      'coronal',
    );
    expect(markers.map((m) => m.slice)).toEqual([2, 11, 30]);
  });

  it('deduplicates markers by id', () => {
    const markers = scrubberMarkers(
      [
        row({ id: 'dup', target: { sliceIndex: 4 } }),
        row({ id: 'dup', target: { sliceIndex: 8 } }),
      ],
      'axial',
    );
    expect(markers).toHaveLength(1);
    expect(markers[0].slice).toBe(4);
  });

  it('gives an empty study an empty list', () => {
    expect(deriveFindings(baseInput())).toEqual([]);
  });
});
