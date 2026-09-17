import { describe, expect, it } from 'vitest';
import {
  buildAirwayRequest,
  describeReference,
  nearestSample,
  normalizeRange,
  rangeFromSamples,
  rangeLabel,
  sameRequest,
  sampleSpan,
  type AirwayInputs,
} from './reference';

const SAMPLE_K = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];

const BASE: AirwayInputs = {
  seriesUid: '1.2.3',
  seedIjk: [256, 195, 22],
  glottisSlice: null,
  refRangeK: null,
  capAtGlottis: true,
};

describe('brackets', () => {
  it('sorts and rounds the two clicks', () => {
    expect(normalizeRange(40, 12)).toEqual([12, 40]);
    expect(normalizeRange(12.4, 39.6)).toEqual([12, 40]);
    expect(normalizeRange(7, 7)).toEqual([7, 7]);
  });

  it('maps a bracket to the samples it covers', () => {
    expect(sampleSpan(SAMPLE_K, [22, 25])).toEqual([2, 5]);
    expect(sampleSpan(SAMPLE_K, [0, 21])).toEqual([0, 1]);
    expect(sampleSpan(SAMPLE_K, [40, 50])).toBeNull();
    expect(sampleSpan(undefined, [22, 25])).toBeNull();
    expect(sampleSpan(SAMPLE_K, null)).toBeNull();
  });

  it('turns a chart drag into a bracket whichever way it went', () => {
    expect(rangeFromSamples(SAMPLE_K, 2, 5)).toEqual([22, 25]);
    expect(rangeFromSamples(SAMPLE_K, 5, 2)).toEqual([22, 25]);
    expect(rangeFromSamples(SAMPLE_K, -3, 99)).toEqual([20, 30]);
    expect(rangeFromSamples(undefined, 0, 1)).toBeNull();
  });

  it('finds the sample nearest a slice', () => {
    expect(nearestSample(SAMPLE_K, 25)).toBe(5);
    expect(nearestSample(SAMPLE_K, 100)).toBe(10);
    expect(nearestSample(SAMPLE_K, null)).toBeNull();
    expect(nearestSample(undefined, 25)).toBeNull();
  });

  it('labels slices one-based like the rest of the panel', () => {
    expect(rangeLabel([12, 40])).toBe('slices 13 – 41');
  });
});

describe('request', () => {
  it('asks for the auto reference when nothing is bracketed', () => {
    const body = buildAirwayRequest(BASE);
    expect(body).toEqual({
      series_uid: '1.2.3',
      seed_ijk: [256, 195, 22],
      glottis_slice: null,
      reference: 'auto',
    });
    expect(body).not.toHaveProperty('ref_range_k');
    expect(body).not.toHaveProperty('cap_at_glottis');
  });

  it('sends reference manual plus the sorted bracket when one is set', () => {
    const body = buildAirwayRequest({ ...BASE, refRangeK: [40, 12] });
    expect(body.reference).toBe('manual');
    expect(body.ref_range_k).toEqual([12, 40]);
  });

  it('caps at the glottis only when there is a glottis', () => {
    expect(buildAirwayRequest({ ...BASE, glottisSlice: 66 })).toMatchObject({
      glottis_slice: 66,
      cap_at_glottis: true,
    });
    expect(buildAirwayRequest({ ...BASE, glottisSlice: 66, capAtGlottis: false })).not.toHaveProperty(
      'cap_at_glottis',
    );
    expect(buildAirwayRequest({ ...BASE, glottisSlice: null, capAtGlottis: true })).not.toHaveProperty(
      'cap_at_glottis',
    );
  });

  it('knows when a re-run would change nothing', () => {
    const a = buildAirwayRequest({ ...BASE, glottisSlice: 66, refRangeK: [12, 40] });
    expect(sameRequest(a, buildAirwayRequest({ ...BASE, glottisSlice: 66, refRangeK: [40, 12] }))).toBe(true);
    expect(sameRequest(a, buildAirwayRequest({ ...BASE, glottisSlice: 66, refRangeK: [12, 41] }))).toBe(false);
    expect(sameRequest(a, buildAirwayRequest({ ...BASE, glottisSlice: 66, refRangeK: null }))).toBe(false);
    expect(sameRequest(a, buildAirwayRequest({ ...BASE, glottisSlice: 66, refRangeK: [12, 40], capAtGlottis: false }))).toBe(
      false,
    );
    expect(sameRequest(null, null)).toBe(true);
    expect(sameRequest(a, null)).toBe(false);
  });
});

describe('describeReference', () => {
  it('reads the backend echo', () => {
    expect(describeReference({ reference: 'manual', ref_range_k: [12, 40], ref_method: 'manual k 12..40' })).toBe(
      'manual · slices 13 – 41',
    );
    expect(describeReference({ reference: 'auto', ref_range_k: null, ref_method: 'auto (below the stenosis)' })).toBe(
      'auto · below the stenosis',
    );
    expect(describeReference({ reference: 'auto', ref_range_k: null, ref_method: 'auto (whole airway)' })).toBe(
      'auto · whole airway',
    );
  });

  it('falls back to auto for a backend that does not echo', () => {
    expect(describeReference({})).toBe('auto');
    expect(describeReference({ reference: 'manual' })).toBe('manual');
  });
});
