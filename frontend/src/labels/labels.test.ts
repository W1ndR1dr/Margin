import { describe, expect, it } from 'vitest';

import {
  MaskGeometryError,
  describeMismatch,
  parseMaskHeaders,
  voxelCount,
} from './geometry';
import { StlParseError, parseBinaryStl } from './stl';
import { anatomyForName, categoryForName, colorForName, rgbToHex, ANATOMY } from './colors';
import { equivalentDiameterMm, minEquivalentDiameterMm, narrative } from '../tools/airway/report';
import { normaliseAiModels } from '../api/client';
import { availability } from '../tools/ai/availability';
import type { AirwayResult } from '../api/client';

/* ------------------------------------------------------------------ */
/* mask headers                                                       */
/* ------------------------------------------------------------------ */

/** Exactly what the phantom's /mask route answers (verified against the API). */
const PHANTOM_HEADERS: Record<string, string> = {
  'x-shape': '180,512,512',
  'x-spacing': '1,0.45,0.45',
  'x-origin': '-114.9749985,-114.9749985,-89.5',
  'x-direction': '1,0,0,0,1,0,0,0,1',
  'x-label-id': 'd02b2f8b-7515-40b6-92b4-1337e361631a',
  'x-series-uid': '1.2.826.0.1.3680043.10.9481.541',
};

describe('parseMaskHeaders', () => {
  it('reverses the (z, y, x) header order into Cornerstone [i, j, k]', () => {
    const g = parseMaskHeaders(PHANTOM_HEADERS);
    expect(g.dimensions).toEqual([512, 512, 180]);
    expect(g.spacing).toEqual([0.45, 0.45, 1]);
    expect(g.origin).toEqual([-114.9749985, -114.9749985, -89.5]);
    expect(g.direction).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(g.labelId).toBe(PHANTOM_HEADERS['x-label-id']);
    expect(voxelCount(g)).toBe(512 * 512 * 180);
  });

  it('accepts the canonical capitalised header names too', () => {
    const g = parseMaskHeaders({
      'X-Shape': '2,3,4',
      'X-Spacing': '1,1,1',
      'X-Origin': '0,0,0',
      'X-Direction': '1,0,0,0,1,0,0,0,1',
    });
    expect(g.dimensions).toEqual([4, 3, 2]);
  });

  it('rejects a missing or malformed header rather than guessing', () => {
    expect(() => parseMaskHeaders({})).toThrow(MaskGeometryError);
    expect(() =>
      parseMaskHeaders({ ...PHANTOM_HEADERS, 'x-direction': '1,0,0' }),
    ).toThrow(/X-Direction should list 9/);
    expect(() =>
      parseMaskHeaders({ ...PHANTOM_HEADERS, 'x-spacing': '0,1,1' }),
    ).toThrow(/positive/);
    expect(() =>
      parseMaskHeaders({ ...PHANTOM_HEADERS, 'x-shape': '180,512,0' }),
    ).toThrow(/usable volume size/);
  });
});

describe('describeMismatch', () => {
  const g = parseMaskHeaders(PHANTOM_HEADERS);

  it('passes a mask that sits on the CT grid', () => {
    expect(describeMismatch(g, { dimensions: [512, 512, 180], spacing: [0.45, 0.45, 1] })).toBeNull();
  });

  it('names the offending dimensions', () => {
    const out = describeMismatch(g, { dimensions: [512, 512, 179] });
    expect(out).toMatch(/512×512×180/);
    expect(out).toMatch(/512×512×179/);
  });

  it('catches a spacing mismatch even when the sizes agree', () => {
    const out = describeMismatch(g, { dimensions: [512, 512, 180], spacing: [0.7, 0.7, 1] });
    expect(out).toMatch(/spacing/);
  });

  it('tolerates floating point noise in the spacing', () => {
    expect(
      describeMismatch(g, { dimensions: [512, 512, 180], spacing: [0.450001, 0.45, 1.000002] }),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* binary STL                                                         */
/* ------------------------------------------------------------------ */

function makeStl(triangles: number[][][]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buf);
  view.setUint32(80, triangles.length, true);
  let at = 84;
  for (const tri of triangles) {
    // facet normal, unused by the reader
    view.setFloat32(at, 0, true);
    view.setFloat32(at + 4, 0, true);
    view.setFloat32(at + 8, 1, true);
    let p = at + 12;
    for (const v of tri) {
      view.setFloat32(p, v[0], true);
      view.setFloat32(p + 4, v[1], true);
      view.setFloat32(p + 8, v[2], true);
      p += 12;
    }
    at += 50;
  }
  return buf;
}

describe('parseBinaryStl', () => {
  it('reads vertices and builds a vtk cell array', () => {
    const mesh = parseBinaryStl(
      makeStl([
        [
          [0, 0, 0],
          [1, 0, 0],
          [0, 2, 0],
        ],
        [
          [0, 0, 0],
          [0, 0, -3],
          [1, 0, 0],
        ],
      ]),
    );
    expect(mesh.triangles).toBe(2);
    expect(mesh.points.length).toBe(18);
    expect(Array.from(mesh.polys)).toEqual([3, 0, 1, 2, 3, 3, 4, 5]);
    expect(Array.from(mesh.points.slice(0, 9))).toEqual([0, 0, 0, 1, 0, 0, 0, 2, 0]);
    expect(mesh.bounds).toEqual([0, 0, -3, 1, 2, 0]);
  });

  it('handles an empty mesh without throwing', () => {
    const mesh = parseBinaryStl(makeStl([]));
    expect(mesh.triangles).toBe(0);
    expect(mesh.bounds).toBeNull();
  });

  it('rejects a truncated file instead of reading past the end', () => {
    const full = makeStl([
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
    ]);
    expect(() => parseBinaryStl(full.slice(0, 100))).toThrow(StlParseError);
  });

  it('rejects ASCII STL with a clear message', () => {
    const text = new TextEncoder().encode('solid x\nfacet normal 0 0 1\nendsolid x\n');
    expect(() => parseBinaryStl(text.buffer as ArrayBuffer)).toThrow(/ASCII/);
  });
});

/* ------------------------------------------------------------------ */
/* colours                                                            */
/* ------------------------------------------------------------------ */

describe('anatomy colours', () => {
  it('maps the DESIGN.md anatomy names onto their tokens', () => {
    expect(anatomyForName('Bone')).toBe('bone');
    expect(anatomyForName('Airway lumen')).toBe('airway');
    expect(anatomyForName('common_carotid_artery_left')).toBe('artery');
    expect(anatomyForName('internal_jugular_vein_right')).toBe('vein');
    expect(anatomyForName('parotid_gland_left')).toBe('gland');
    expect(anatomyForName('sternocleidomastoid_right')).toBe('muscle');
    expect(anatomyForName('Primary tumour')).toBe('tumor');
    expect(rgbToHex(ANATOMY.bone.rgb)).toBe('#e9e4d6');
    expect(rgbToHex(ANATOMY.airway.rgb)).toBe('#7dd3fc');
  });

  it('routes nodal levels to the node token and the nodal category', () => {
    expect(anatomyForName('level_IIa_left')).toBe('node');
    expect(anatomyForName('Level Vb right')).toBe('node');
    expect(categoryForName('level_III_right')).toBe('nodal');
    expect(categoryForName('mandible')).toBe('bones');
    expect(categoryForName('trachea')).toBe('airway');
  });

  it('keeps laryngeal cartilage with the bones, not the glands', () => {
    // TotalSegmentator's headneck_bones_vessels output, verbatim.
    expect(categoryForName('thyroid_cartilage')).toBe('bones');
    expect(categoryForName('cricoid_cartilage')).toBe('bones');
    expect(categoryForName('hyoid')).toBe('bones');
    expect(categoryForName('thyroid_gland')).toBe('glands');
    expect(categoryForName('parotid_gland_left')).toBe('glands');
    expect(categoryForName('internal_carotid_artery_right')).toBe('vessels');
    expect(categoryForName('internal_jugular_vein_left')).toBe('vessels');
    expect(categoryForName('larynx_air')).toBe('airway');
  });

  it('falls back to a stable palette for anonymous structures', () => {
    const a = colorForName('Region 42 HU', 0);
    const b = colorForName('Region 42 HU', 0);
    const c = colorForName('Region 42 HU', 1);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(categoryForName('Region 42 HU')).toBe('other');
  });
});

/* ------------------------------------------------------------------ */
/* airway narrative                                                   */
/* ------------------------------------------------------------------ */

/** The numbers the PHANTOM_NECK series actually produces. */
const PHANTOM_AIRWAY = {
  min_csa_mm2: 50.85,
  min_csa_index: 60,
  eq_diameter_mm: [],
  stenosis_pct: 81.285,
  stenosis_length_mm: 12.0145,
  distance_from_glottis_mm: 6.0076,
  myer_cotton_grade: 'III',
} as unknown as AirwayResult;

describe('equivalent diameter', () => {
  it('is 2·sqrt(CSA/pi)', () => {
    expect(equivalentDiameterMm(Math.PI)).toBeCloseTo(2, 10);
    expect(equivalentDiameterMm(50.85)).toBeCloseTo(8.0464, 3);
    expect(equivalentDiameterMm(-5)).toBe(0);
  });

  it('prefers the backend value at the minimum when it is present', () => {
    expect(minEquivalentDiameterMm(PHANTOM_AIRWAY)).toBeCloseTo(8.0464, 3);
    expect(
      minEquivalentDiameterMm({
        ...PHANTOM_AIRWAY,
        eq_diameter_mm: [1, 2, 7.77],
        min_csa_index: 2,
      } as unknown as AirwayResult),
    ).toBeCloseTo(7.77, 6);
  });
});

describe('narrative', () => {
  it('reads as the sentence the spec asks for', () => {
    expect(narrative(PHANTOM_AIRWAY)).toBe(
      'Min CSA 50.9 mm² (eq. ⌀ 8.0 mm), 81% reduction over 12 mm, 6 mm below glottis, Myer–Cotton III',
    );
  });

  it('drops the glottis clause when the folds were not marked', () => {
    const out = narrative({ ...PHANTOM_AIRWAY, distance_from_glottis_mm: null });
    expect(out).not.toMatch(/glottis/);
    expect(out).toMatch(/Myer–Cotton III$/);
  });
});

/* ------------------------------------------------------------------ */
/* AI model list normalisation                                        */
/* ------------------------------------------------------------------ */

describe('normaliseAiModels', () => {
  it('reads a plain array of models', () => {
    const out = normaliseAiModels([
      { id: 'totalseg', available: true, tasks: [{ id: 'headneck_muscles', available: false, reason: 'weights missing' }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].tasks[0]).toEqual({
      id: 'headneck_muscles',
      name: undefined,
      available: false,
      reason: 'weights missing',
    });
  });

  it('reads a {models: [...]} envelope', () => {
    expect(normaliseAiModels({ models: [{ id: 'hnlnl', available: false, reason: 'not installed' }] })).toEqual([
      { id: 'hnlnl', name: undefined, available: false, reason: 'not installed', tasks: [] },
    ]);
  });

  it('reads a map keyed by model id, with tasks as a map or a string list', () => {
    const out = normaliseAiModels({
      totalseg: { available: true, tasks: ['headneck_bones_vessels'] },
      hnlnl: { available: true, tasks: { nodal_levels: { available: false, reason: 'no weights' } } },
    });
    expect(out.map((m) => m.id).sort()).toEqual(['hnlnl', 'totalseg']);
    const ts = out.find((m) => m.id === 'totalseg');
    expect(ts?.tasks).toEqual([{ id: 'headneck_bones_vessels', available: true }]);
    const hn = out.find((m) => m.id === 'hnlnl');
    expect(hn?.tasks[0].available).toBe(false);
  });

  it("reads the backend's own shape: model/task keys and weights_present", () => {
    const out = normaliseAiModels({
      models: [
        {
          model: 'totalseg',
          title: 'TotalSegmentator',
          available: true,
          tasks: [
            { task: 'headneck_bones_vessels', weights_present: true, missing_weights: [], n_classes: 12 },
            { task: 'teeth', weights_present: false, missing_weights: ['Dataset111_x', 'Dataset112_y'] },
          ],
        },
        { model: 'hnlnl', available: true },
      ],
    });
    expect(out.map((m) => m.id)).toEqual(['totalseg', 'hnlnl']);
    expect(out[0].name).toBe('TotalSegmentator');
    expect(out[0].tasks[0]).toEqual({
      id: 'headneck_bones_vessels',
      name: undefined,
      available: true,
      reason: undefined,
    });
    expect(out[0].tasks[1].available).toBe(false);
    expect(out[0].tasks[1].reason).toMatch(/weights missing: Dataset111_x, Dataset112_y/);
    // A model with no task list is usable as a whole.
    expect(out[1].tasks).toEqual([]);
    expect(availability(out, 'totalseg', 'headneck_bones_vessels').available).toBe(true);
    expect(availability(out, 'totalseg', 'teeth').available).toBe(false);
    expect(availability(out, 'hnlnl', 'nodal_levels').available).toBe(true);
    expect(availability(out, 'nope', 'x').available).toBe(false);
  });

  it('survives rubbish rather than throwing at the panel', () => {
    expect(normaliseAiModels(null)).toEqual([]);
    expect(normaliseAiModels('nope')).toEqual([]);
    expect(normaliseAiModels([null, 3, { name: 'x' }])).toEqual([
      { id: 'x', name: 'x', available: true, reason: undefined, tasks: [] },
    ]);
  });
});
