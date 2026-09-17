import { describe, expect, it } from 'vitest';

import { bandAtZ, levelBands } from './bands';
import { classifyNode, classifyNodes, interpolateAtZ, midlineAtZ } from './classify';
import { SYNTHETIC_LANDMARKS as LM, makeSyntheticLandmarks } from './fixtures';
import { neckDissectionSuggestion, neckDissectionSummary, sideTotal, tallyLevels } from './tally';
import type { NeckLevel, Point3, Side } from './types';

/** Shorthand: classify against the synthetic neck. */
const at = (p: Point3) => classifyNode(p, LM);

describe('classifyNode — the worked examples from the spec', () => {
  const cases: Array<[string, Point3, NeckLevel, Side]> = [
    ['anterior to the IJV posterior edge, above the hyoid', [-30, 8, 110], 'IIa', 'right'],
    ['posterior to the IJV posterior edge', [-38, 20, 110], 'IIb', 'right'],
    ['lateral chain between hyoid and cricoid', [-34, 10, 70], 'III', 'right'],
    ['lateral chain below the cricoid', [-34, 12, 30], 'IV', 'right'],
    ['posterior to SCM, above the cricoid', [-62, 42, 70], 'Va', 'right'],
    ['posterior to SCM, below the cricoid', [-62, 40, 30], 'Vb', 'right'],
    ['submandibular triangle', [-8, -28, 100], 'Ib', 'right'],
    ['submental triangle', [-3, -45, 98], 'Ia', 'right'],
    ['between the carotids, below the hyoid', [-10, 5, 60], 'VI', 'right'],
    ['below the sternal notch', [-30, 10, 2], 'VII', 'right'],
    ['medial and posterior to the carotid, above the hyoid', [-10, 12, 110], 'RP', 'right'],
  ];

  for (const [name, p, level, side] of cases) {
    it(`${name} -> ${level} (${side})`, () => {
      const r = at(p);
      expect(r.level).toBe(level);
      expect(r.side).toBe(side);
      expect(r.reasons.length).toBeGreaterThan(0);
      expect(Number.isFinite(r.marginMm)).toBe(true);
      expect(r.marginMm).toBeGreaterThanOrEqual(0);
    });
  }
});

describe('classifyNode — sides, boundaries and failure modes', () => {
  it('mirrors the right-side IIa case onto the left', () => {
    const right = at([-30, 8, 110]);
    const left = at([30, 8, 110]);
    expect(left.level).toBe('IIa');
    expect(left.side).toBe('left');
    expect(left.level).toBe(right.level);
    expect(left.marginMm).toBeCloseTo(right.marginMm, 9);
  });

  it('mirrors every worked example onto the left side', () => {
    const points: Point3[] = [
      [-38, 20, 110],
      [-34, 10, 70],
      [-34, 12, 30],
      [-62, 42, 70],
      [-62, 40, 30],
      [-8, -28, 100],
      [-10, 5, 60],
      [-10, 12, 110],
    ];
    for (const p of points) {
      const r = at(p);
      const mirrored = at([-p[0], p[1], p[2]]);
      expect(mirrored.level).toBe(r.level);
      expect(mirrored.side).toBe('left');
    }
  });

  it('flags a node 2 mm above the hyoid plane as a boundary call', () => {
    const r = at([-34, 0, 92]);
    expect(r.level).toBe('IIa');
    expect(r.confidence).toBe('boundary');
    expect(r.marginMm).toBeCloseTo(2, 9);
    expect(r.reasons).toContain('above hyoid plane by 2.0 mm');
  });

  it('calls a node well inside a level clear', () => {
    const r = at([-62, 60, 70]);
    expect(r.level).toBe('Va');
    expect(r.confidence).toBe('clear');
    expect(r.marginMm).toBeGreaterThanOrEqual(5);
  });

  it('returns unclassified above the skull base', () => {
    const r = at([-30, 8, 190]);
    expect(r.level).toBe('unclassified');
    expect(r.marginMm).toBeCloseTo(10, 9);
    expect(r.reasons.some((s) => s.startsWith('above skull base plane'))).toBe(true);
  });

  it('reports a near-midline node as side midline', () => {
    const r = at([-1, 5, 60]);
    expect(r.level).toBe('VI');
    expect(r.side).toBe('midline');
  });

  it('returns unclassified when the SCM landmark is missing', () => {
    const lm = makeSyntheticLandmarks();
    lm.right.scmPosteriorBorder = [];
    const r = classifyNode([-34, 10, 70], lm);
    expect(r.level).toBe('unclassified');
    expect(r.reasons.join(' ')).toContain('SCM posterior border landmark');
  });

  it('falls back to Ib when the digastric landmark is missing', () => {
    const lm = makeSyntheticLandmarks();
    delete lm.right.digastricAnteriorMedial;
    expect(classifyNode([-3, -45, 98], lm).level).toBe('Ib');
  });

  it('honours an explicit ijvPosteriorEdge over the +5 mm fallback', () => {
    const lm = makeSyntheticLandmarks();
    // Push the posterior edge 20 mm further back: the IIb node becomes IIa.
    lm.right.ijvPosteriorEdge = [
      [-36, 28, 20],
      [-30, 22, 150],
    ];
    expect(at([-38, 20, 110]).level).toBe('IIb');
    expect(classifyNode([-38, 20, 110], lm).level).toBe('IIa');
  });

  it('writes human-readable reasons', () => {
    const r = at([-34, 10, 70]);
    expect(r.reasons).toContain('anterior to SCM posterior border by 24.9 mm');
    expect(r.reasons).toContain('lateral to carotid medial edge by 13.5 mm');
    expect(r.reasons).toContain('above cricoid plane by 20.0 mm');
  });
});

describe('geometry helpers', () => {
  it('interpolates linearly between samples', () => {
    const poly: Point3[] = [
      [-52, 38, 20],
      [-58, 30, 150],
    ];
    expect(interpolateAtZ(poly, 85)).toEqual({ x: -55, y: 34 });
  });

  it('clamps outside the sampled z range', () => {
    const poly: Point3[] = [
      [-52, 38, 20],
      [-58, 30, 150],
    ];
    expect(interpolateAtZ(poly, -100)).toEqual({ x: -52, y: 38 });
    expect(interpolateAtZ(poly, 1000)).toEqual({ x: -58, y: 30 });
  });

  it('sorts unordered samples by z', () => {
    const poly: Point3[] = [
      [-58, 30, 150],
      [-52, 38, 20],
    ];
    expect(interpolateAtZ(poly, 85)).toEqual({ x: -55, y: 34 });
  });

  it('derives the midline from the carotids when midlineX is absent', () => {
    const lm = makeSyntheticLandmarks();
    delete lm.midlineX;
    expect(midlineAtZ(lm, 70)).toBeCloseTo(0, 9);
  });
});

describe('tallyLevels', () => {
  const points: Point3[] = [
    [-30, 8, 110], // right IIa
    [-38, 20, 110], // right IIb
    [-34, 10, 70], // right III
    [-34, 12, 30], // right IV
    [30, 8, 110], // left IIa
    [-10, 12, 110], // right RP
    [-30, 8, 190], // right unclassified
  ];
  const tally = tallyLevels(classifyNodes(points, LM));

  it('counts per side and per level, with every key present', () => {
    expect(tally.right.IIa).toBe(1);
    expect(tally.right.IIb).toBe(1);
    expect(tally.right.III).toBe(1);
    expect(tally.right.IV).toBe(1);
    expect(tally.right.RP).toBe(1);
    expect(tally.right.unclassified).toBe(1);
    expect(tally.left.IIa).toBe(1);
    expect(tally.left.III).toBe(0);
    expect(tally.midline.VI).toBe(0);
    expect(sideTotal(tally.right)).toBe(6);
    expect(sideTotal(tally.left)).toBe(1);
    expect(sideTotal(tally.midline)).toBe(0);
  });

  it('returns zeroed sides for an empty input', () => {
    const empty = tallyLevels([]);
    expect(sideTotal(empty.right)).toBe(0);
    expect(sideTotal(empty.left)).toBe(0);
    expect(sideTotal(empty.midline)).toBe(0);
    expect(neckDissectionSuggestion(empty)).toEqual([]);
    expect(neckDissectionSummary(empty)).toBe('No nodes classified.');
  });
});

describe('neckDissectionSuggestion', () => {
  it('states the involved levels and the contiguous range', () => {
    const t = tallyLevels(
      classifyNodes(
        [
          [-30, 8, 110],
          [-38, 20, 110],
          [-34, 10, 70],
          [-34, 12, 30],
        ],
        LM,
      ),
    );
    expect(neckDissectionSuggestion(t)).toEqual([
      'Right: levels IIa, IIb, III and IV involved; consider selective neck dissection ' +
        'II–IV (+ Ib if oral cavity primary)',
    ]);
  });

  it('is deterministic and ordered right, left, midline', () => {
    const t = tallyLevels(
      classifyNodes(
        [
          [30, 8, 110],
          [-34, 10, 70],
          [-1, 5, 60],
        ],
        LM,
      ),
    );
    const lines = neckDissectionSuggestion(t);
    expect(lines).toHaveLength(3);
    expect(lines[0].startsWith('Right:')).toBe(true);
    expect(lines[1].startsWith('Left:')).toBe(true);
    expect(lines[2].startsWith('Midline:')).toBe(true);
    expect(neckDissectionSuggestion(t)).toEqual(lines);
    expect(lines[0]).toBe(
      'Right: level III involved; consider selective neck dissection III (+ Ib if oral cavity primary)',
    );
  });

  it('flags a non-contiguous range and drops the Ib caveat when Ib is involved', () => {
    const t = tallyLevels(
      classifyNodes(
        [
          [-8, -28, 100],
          [-34, 12, 30],
        ],
        LM,
      ),
    );
    const line = neckDissectionSuggestion(t)[0];
    expect(line).toContain('levels Ib and IV involved');
    expect(line).toContain('I–IV');
    expect(line).toContain('not contiguous');
    expect(line).not.toContain('oral cavity primary');
  });

  it('calls out retropharyngeal and unclassified nodes separately', () => {
    const t = tallyLevels(
      classifyNodes(
        [
          [-10, 12, 110],
          [-30, 8, 190],
        ],
        LM,
      ),
    );
    const line = neckDissectionSuggestion(t)[0];
    expect(line).toContain('1 retropharyngeal node');
    expect(line).toContain('1 node unclassified');
    expect(line).not.toContain('selective neck dissection');
  });
});

describe('levelBands', () => {
  const bands = levelBands(LM);

  it('spans the neck superior to inferior without gaps', () => {
    expect(bands.z.map((b) => b.level)).toEqual(['I/II', 'III', 'IV', 'VII']);
    expect(bands.z[0]).toEqual({ level: 'I/II', zFrom: 90, zTo: 180 });
    expect(bands.z[1]).toEqual({ level: 'III', zFrom: 50, zTo: 90 });
    expect(bands.z[2]).toEqual({ level: 'IV', zFrom: 5, zTo: 50 });
    expect(bands.z[3].zTo).toBe(5);
    for (const b of bands.z) expect(b.zFrom).toBeLessThan(b.zTo);
    for (let i = 0; i < bands.z.length - 1; i++) {
      expect(bands.z[i].zFrom).toBe(bands.z[i + 1].zTo);
    }
  });

  it('substitutes defaults for the optional planes', () => {
    const lm = makeSyntheticLandmarks();
    delete lm.skullBaseZ;
    delete lm.clavicleZ;
    const b = levelBands(lm);
    expect(b.z[0].zTo).toBe(180); // hyoid 90 + 90
    expect(b.z[2].zFrom).toBe(5); // cricoid 50 - 45
  });

  it('agrees with the classifier about which band a node sits in', () => {
    expect(bandAtZ(bands, 110)?.level).toBe('I/II');
    expect(bandAtZ(bands, 70)?.level).toBe('III');
    expect(bandAtZ(bands, 30)?.level).toBe('IV');
    expect(bandAtZ(bands, 2)?.level).toBe('VII');
    expect(bandAtZ(bands, 400)).toBeNull();
  });
});
