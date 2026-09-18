import { describe, expect, it } from 'vitest';

import type { Series } from '../api/client';
import {
  MR_PRESETS,
  PT_PRESETS,
  SEQUENCE_LABEL,
  THICK_SLICE_MM,
  autoWindowForVolume,
  buildHistogram,
  defaultPresetId,
  effectiveSliceSpacing,
  formatIntensity,
  groupSeries,
  inferSequenceKind,
  intensityUnit,
  isCt,
  isMr,
  isThickSeries,
  normaliseModality,
  percentile,
  planeFromOrientation,
  preferredPrimary,
  presetsFor,
  rescalePresetToData,
  resolveWindow,
  sameFrameOfReference,
  windowFromHistogram,
} from './modality';

/** Minimal but complete Series so the tests exercise the real types. */
function mkSeries(over: Partial<Series> = {}): Series {
  return {
    series_uid: 'uid',
    study_uid: 'study',
    series_number: 1,
    modality: 'MR',
    description: null,
    body_part: null,
    instance_count: 40,
    rows: 512,
    cols: 512,
    pixel_spacing: [0.5, 0.5],
    slice_thickness: null,
    spacing_between_slices: null,
    orientation: null,
    is_multiframe: false,
    is_3d: true,
    ...over,
  };
}

const AXIAL = [1, 0, 0, 0, 1, 0];
const SAGITTAL = [0, 1, 0, 0, 0, 1];
const CORONAL = [1, 0, 0, 0, 0, 1];

describe('normaliseModality', () => {
  it('folds vendor spellings and unknown codes', () => {
    expect(normaliseModality('ct')).toBe('CT');
    expect(normaliseModality(' MRI ')).toBe('MR');
    expect(normaliseModality('PET')).toBe('PT');
    expect(normaliseModality('RTSTRUCT')).toBe('OT');
    expect(normaliseModality(null)).toBe('OT');
    expect(normaliseModality(undefined)).toBe('OT');
  });

  it('answers the CT/MR predicates', () => {
    expect(isCt({ modality: 'CT' })).toBe(true);
    expect(isCt({ modality: 'MRI' })).toBe(false);
    expect(isMr({ modality: 'MRI' })).toBe(true);
    expect(isMr({ modality: null })).toBe(false);
  });
});

describe('inferSequenceKind', () => {
  const mr = (description: string, over: Partial<Series> = {}) =>
    inferSequenceKind(mkSeries({ modality: 'MR', description, ...over }));

  it('trusts a stored sequence_kind and normalises its spelling', () => {
    expect(inferSequenceKind(mkSeries({ sequence_kind: 'T1CE' }))).toBe('t1c');
    expect(inferSequenceKind(mkSeries({ sequence_kind: 't1_c' }))).toBe('t1c');
    expect(inferSequenceKind(mkSeries({ sequence_kind: 't1gd' }))).toBe('t1c');
    expect(inferSequenceKind(mkSeries({ sequence_kind: 'dwi_adc' }))).toBe('adc');
    expect(inferSequenceKind(mkSeries({ sequence_kind: 'TIRM' }))).toBe('stir');
    expect(inferSequenceKind(mkSeries({ sequence_kind: 'tof' }))).toBe('mra');
    expect(inferSequenceKind(mkSeries({ sequence_kind: 'vibe' }))).toBe('other');
  });

  it('checks ADC before DWI', () => {
    expect(mr('AX DWI ADC MAP')).toBe('adc');
    expect(mr('AX DWI b1000')).toBe('dwi');
  });

  it('checks post-contrast T1 before plain T1', () => {
    expect(mr('AX T1 POST GD FS')).toBe('t1c');
    expect(mr('SAG T1 +C')).toBe('t1c');
    expect(mr('AX T1 C+ SPAIR')).toBe('t1c');
    expect(mr('AX T1 CE')).toBe('t1c');
    expect(mr('AX T1 FS')).toBe('t1');
    expect(mr('SAG T1W')).toBe('t1');
  });

  it('does not let a fat-sat marker change the kind', () => {
    expect(mr('AX T2 FS')).toBe('t2');
    expect(mr('AX T2 FATSAT')).toBe('t2');
    expect(mr('COR T1 SPIR')).toBe('t1');
  });

  it('recognises the named sequences', () => {
    expect(mr('COR STIR')).toBe('stir');
    expect(mr('COR TIRM')).toBe('stir');
    expect(mr('AX T2 FLAIR')).toBe('flair');
    expect(mr('AX SWI')).toBe('swi');
    expect(mr('3D TOF MRA CIRCLE OF WILLIS')).toBe('mra');
    expect(mr('AX T2 TSE')).toBe('t2');
  });

  it('falls back to TR/TE when the description says nothing', () => {
    expect(mr('AX SERIES 4', { repetition_time: 500, echo_time: 12 })).toBe('t1');
    expect(mr('AX SERIES 5', { repetition_time: 4000, echo_time: 100 })).toBe('t2');
    expect(
      mr('AX SERIES 6', { repetition_time: 5000, echo_time: 40, inversion_time: 150 }),
    ).toBe('stir');
    expect(mr('AX SERIES 7', { repetition_time: 1200, echo_time: 40 })).toBeNull();
  });

  it('returns null for non-MR and for unusable MR', () => {
    expect(inferSequenceKind(mkSeries({ modality: 'CT', description: 'AX T1 POST' }))).toBeNull();
    expect(mr('LOCALIZER')).toBeNull();
  });

  it('labels every kind', () => {
    expect(SEQUENCE_LABEL.t1c).toBe('T1 +C');
    expect(SEQUENCE_LABEL.adc).toBe('ADC');
    expect(SEQUENCE_LABEL.other).toBe('MR');
  });
});

describe('presets', () => {
  it('serves the modality-appropriate table', () => {
    const ct = [{ id: 'soft', label: 'Soft', ww: 350, wc: 40, hint: '350 / 40' }];
    expect(presetsFor('MR', ct)).toBe(MR_PRESETS);
    expect(presetsFor('PT', ct)).toBe(PT_PRESETS);
    expect(presetsFor('CT', ct)).toBe(ct);
    expect(presetsFor('US', ct)).toBe(ct);
  });

  it('formats every MR hint as "ww / wc"', () => {
    for (const p of MR_PRESETS) expect(p.hint).toBe(`${p.ww} / ${p.wc}`);
    expect(MR_PRESETS.every((p) => p.id.startsWith('mr-'))).toBe(true);
  });

  it('picks a sensible starting preset', () => {
    expect(defaultPresetId('MR', 'adc')).toBe('mr-adc');
    expect(defaultPresetId('MR', 'flair')).toBe('mr-stir');
    expect(defaultPresetId('MR', 't2')).toBe('mr-t2');
    expect(defaultPresetId('MR', 't1c')).toBe('mr-t1');
    expect(defaultPresetId('MR', null)).toBe('mr-wide');
    expect(defaultPresetId('PT', null)).toBe('pt-suv');
    expect(defaultPresetId('CT', null)).toBeNull();
  });
});

describe('histogram windowing', () => {
  /** 0..1000 inclusive — a flat distribution with known percentiles. */
  const ramp = Array.from({ length: 1001 }, (_, i) => i);

  it('builds a histogram over the data range', () => {
    const h = buildHistogram(ramp, { bins: 100 });
    expect(h).not.toBeNull();
    if (!h) return;
    expect(h.min).toBe(0);
    expect(h.max).toBe(1000);
    expect(h.counts.length).toBe(100);
    expect(h.binWidth).toBeCloseTo(10, 6);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(1001);
  });

  it('honours an explicit sample stride', () => {
    const h = buildHistogram(ramp, { bins: 100, sampleStride: 10 });
    expect(h).not.toBeNull();
    if (!h) return;
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(101);
  });

  it('refuses degenerate input', () => {
    expect(buildHistogram([], {})).toBeNull();
    expect(buildHistogram([1, 2, 3], {})).toBeNull();
    expect(buildHistogram(new Array(200).fill(7), {})).toBeNull();
    expect(buildHistogram(new Array(200).fill(Number.NaN), {})).toBeNull();
  });

  it('interpolates percentiles inside the bin', () => {
    const h = buildHistogram(ramp, { bins: 100 });
    expect(h).not.toBeNull();
    if (!h) return;
    expect(percentile(h, 0.5)).toBeCloseTo(500.5, 1);
    expect(percentile(h, 0.02)).toBeCloseTo(20, 0);
    expect(percentile(h, 0.98)).toBeCloseTo(981, 0);
    expect(percentile(h, 0)).toBe(0);
    expect(percentile(h, 1)).toBe(1000);
    expect(percentile(h, -5)).toBe(0);
  });

  it('derives a window from the percentile pair', () => {
    const h = buildHistogram(ramp, { bins: 100 });
    expect(h).not.toBeNull();
    if (!h) return;
    const w = windowFromHistogram(h);
    expect(w.ww).toBe(961);
    expect([500, 501]).toContain(w.wc);
    expect(Number.isInteger(w.ww)).toBe(true);
  });

  it('keeps 2 decimals for narrow (SUV-scale) windows', () => {
    const suv = Array.from({ length: 1000 }, (_, i) => (i % 100) / 20);
    const h = buildHistogram(suv, { bins: 64 });
    expect(h).not.toBeNull();
    if (!h) return;
    const w = windowFromHistogram(h);
    expect(w.ww).toBeLessThan(10);
    expect(w.ww).toBeGreaterThan(0);
    // narrow windows keep 2 decimals rather than being rounded into oblivion
    expect(Math.abs(w.ww * 100 - Math.round(w.ww * 100))).toBeLessThan(1e-6);
    expect(Math.abs(w.wc * 100 - Math.round(w.wc * 100))).toBeLessThan(1e-6);
  });

  it('lifts the low percentile off the MR background spike', () => {
    // 80% background zeros, 20% "tissue" spread over 500..1000.
    const vol = [
      ...new Array(8000).fill(0),
      ...Array.from({ length: 2000 }, (_, i) => 500 + (i * 500) / 1999),
    ];
    const h = buildHistogram(vol, {});
    expect(h).not.toBeNull();
    if (!h) return;

    const raw = windowFromHistogram(h);
    expect(raw.wc - raw.ww / 2).toBeLessThan(5); // low pinned inside the air spike

    const auto = autoWindowForVolume(vol, 'MR');
    expect(auto).not.toBeNull();
    if (!auto) return;
    expect(auto.source).toBe('percentile');
    const low = auto.wc - auto.ww / 2;
    expect(low).toBeGreaterThan(15);
    expect(low).toBeLessThan(25);
    expect(auto.ww).toBeGreaterThan(800);
  });

  it('leaves CT to its HU presets', () => {
    expect(autoWindowForVolume(ramp, 'CT')).toBeNull();
    expect(autoWindowForVolume([1, 2, 3], 'MR')).toBeNull();
  });
});

describe('rescalePresetToData', () => {
  it('re-anchors the preset ratio onto the measured centre', () => {
    const t1 = MR_PRESETS[0];
    expect(rescalePresetToData(t1, { ww: 0, wc: 900 })).toEqual({ ww: 1800, wc: 900 });
    expect(rescalePresetToData(t1, { ww: 0, wc: 150 })).toEqual({ ww: 300, wc: 150 });
  });

  it('returns the measured window when the preset has no usable ratio', () => {
    const zero = { id: 'z', label: 'z', ww: 100, wc: 0, hint: '' };
    const data = { ww: 42, wc: 21 };
    expect(rescalePresetToData(zero, data)).toBe(data);
    expect(rescalePresetToData(MR_PRESETS[0], { ww: 10, wc: Number.NaN })).toEqual({
      ww: 10,
      wc: Number.NaN,
    });
  });
});

describe('planeFromOrientation', () => {
  it('names the three cardinal planes', () => {
    expect(planeFromOrientation(AXIAL)).toBe('axial');
    expect(planeFromOrientation(SAGITTAL)).toBe('sagittal');
    expect(planeFromOrientation(CORONAL)).toBe('coronal');
  });

  it('calls a 45-degree acquisition oblique', () => {
    const k = Math.SQRT1_2;
    expect(planeFromOrientation([1, 0, 0, 0, k, k])).toBe('oblique');
  });

  it('keeps a small tilt on its cardinal plane', () => {
    expect(planeFromOrientation([1, 0, 0, 0, 0.995, 0.1])).toBe('axial');
  });

  it('rejects missing or malformed orientation', () => {
    expect(planeFromOrientation(null)).toBeNull();
    expect(planeFromOrientation(undefined)).toBeNull();
    expect(planeFromOrientation([1, 0, 0])).toBeNull();
    expect(planeFromOrientation([1, 0, 0, 0, 1, Number.NaN])).toBeNull();
    expect(planeFromOrientation([1, 0, 0, 1, 0, 0])).toBeNull(); // parallel -> no normal
  });
});

describe('slice thickness and primary layout', () => {
  it('prefers SpacingBetweenSlices over SliceThickness', () => {
    expect(effectiveSliceSpacing({ spacing_between_slices: 3, slice_thickness: 5 })).toBe(3);
    expect(effectiveSliceSpacing({ spacing_between_slices: null, slice_thickness: 5 })).toBe(5);
    expect(effectiveSliceSpacing({ spacing_between_slices: 0, slice_thickness: 0 })).toBeNull();
    expect(effectiveSliceSpacing({ spacing_between_slices: null, slice_thickness: null })).toBeNull();
  });

  it('flags thick series', () => {
    expect(THICK_SLICE_MM).toBe(2.5);
    expect(isThickSeries({ spacing_between_slices: 4, slice_thickness: 4 })).toBe(true);
    expect(isThickSeries({ spacing_between_slices: 2.5, slice_thickness: 2.5 })).toBe(false);
    expect(isThickSeries({ spacing_between_slices: null, slice_thickness: null })).toBe(false);
  });

  it('reads a thick MR in its acquired plane', () => {
    const p = preferredPrimary(
      mkSeries({
        modality: 'MR',
        orientation: CORONAL,
        spacing_between_slices: 4,
        slice_thickness: 4,
        is_3d: true,
        instance_count: 30,
      }),
    );
    expect(p.mode).toBe('stack');
    expect(p.plane).toBe('coronal');
    expect(p.reason).toContain('thick MR');
  });

  it('puts an isotropic CT into MPR', () => {
    const p = preferredPrimary(
      mkSeries({
        modality: 'CT',
        orientation: AXIAL,
        spacing_between_slices: 0.625,
        slice_thickness: 0.625,
        is_3d: true,
        instance_count: 400,
      }),
    );
    expect(p).toEqual({ mode: 'mpr', plane: 'axial', reason: 'isotropic volume' });
  });

  it('never reformats a non-volumetric series', () => {
    expect(
      preferredPrimary(mkSeries({ modality: 'CT', orientation: AXIAL, is_3d: false })).reason,
    ).toBe('single stack');
    expect(
      preferredPrimary(mkSeries({ modality: 'CT', orientation: AXIAL, instance_count: 1 })).mode,
    ).toBe('stack');
  });
});

describe('groupSeries', () => {
  it('orders modalities then MR sequences', () => {
    const groups = groupSeries([
      mkSeries({ series_uid: 'a', modality: 'US', description: 'NECK US' }),
      mkSeries({ series_uid: 'b', modality: 'MR', description: 'AX T2' }),
      mkSeries({ series_uid: 'c', modality: 'PET', description: 'PET AC' }),
      mkSeries({ series_uid: 'd', modality: 'MR', description: 'LOCALIZER' }),
      mkSeries({ series_uid: 'e', modality: 'CT', description: 'AX SOFT' }),
      mkSeries({ series_uid: 'f', modality: 'MR', description: 'AX T1' }),
      mkSeries({ series_uid: 'g', modality: 'MR', description: 'AX DWI ADC' }),
    ]);
    expect(groups.map((g) => g.key)).toEqual([
      'ct',
      'mr-t1',
      'mr-t2',
      'mr-adc',
      'mr-other',
      'pt',
      'us',
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      'CT',
      'T1',
      'T2',
      'ADC',
      'MR — other',
      'PET',
      'Ultrasound',
    ]);
    expect(groups[5].modality).toBe('PT');
  });

  it('sorts inside a group by series number then description', () => {
    const groups = groupSeries([
      mkSeries({ series_uid: '1', modality: 'CT', series_number: null, description: 'LAST' }),
      mkSeries({ series_uid: '2', modality: 'CT', series_number: 7, description: 'SEVEN' }),
      mkSeries({ series_uid: '3', modality: 'CT', series_number: 2, description: 'TWO B' }),
      mkSeries({ series_uid: '4', modality: 'CT', series_number: 2, description: 'TWO A' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].series.map((s) => s.series_uid)).toEqual(['4', '3', '2', '1']);
  });

  it('returns nothing for an empty list', () => {
    expect(groupSeries([])).toEqual([]);
  });
});

describe('sameFrameOfReference', () => {
  const withFor = (uid: string | null) => mkSeries({ frame_of_reference_uid: uid });

  it('matches only on two equal non-empty UIDs', () => {
    expect(sameFrameOfReference(withFor('1.2.3'), withFor('1.2.3'))).toBe(true);
    expect(sameFrameOfReference(withFor('1.2.3'), withFor('1.2.4'))).toBe(false);
    expect(sameFrameOfReference(withFor(null), withFor(null))).toBe(false);
    expect(sameFrameOfReference(withFor(''), withFor(''))).toBe(false);
    expect(sameFrameOfReference(null, withFor('1.2.3'))).toBe(false);
    expect(sameFrameOfReference(undefined, undefined)).toBe(false);
  });
});

describe('intensity units', () => {
  it('names the unit per modality and sequence', () => {
    expect(intensityUnit('CT')).toEqual({ short: 'HU', long: 'Hounsfield units' });
    expect(intensityUnit('MR', 'adc').short).toBe('ADC');
    expect(intensityUnit('MR', 't2')).toEqual({ short: 'signal', long: 'signal intensity' });
    expect(intensityUnit('PT').short).toBe('SUV');
    expect(intensityUnit('US')).toEqual({ short: 'value', long: 'stored value' });
  });

  it('formats at the precision the modality supports', () => {
    expect(formatIntensity(null, 'CT')).toBe('—');
    expect(formatIntensity(Number.NaN, 'CT')).toBe('—');
    expect(formatIntensity(-42.6, 'CT')).toBe('-43 HU');
    expect(formatIntensity(812.4, 'MR', 'adc')).toBe('812 ADC');
    expect(formatIntensity(812.4, 'MR', 't1')).toBe('812');
    expect(formatIntensity(3.456, 'PT')).toBe('3.46');
    expect(formatIntensity(9.6, 'US')).toBe('10');
  });
});

describe('resolveWindow', () => {
  it('degrades to the fallback instead of throwing', async () => {
    const out = await resolveWindow(
      { series_uid: 'nope', modality: 'MR', description: null, sequence_kind: null },
      { ww: 600, wc: 300 },
    );
    expect(out).toEqual({ ww: 600, wc: 300, source: 'fallback' });
  });
});
