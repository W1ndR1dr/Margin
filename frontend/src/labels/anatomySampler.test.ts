/**
 * The anatomy sampler is the one piece of the chip that can be wrong silently:
 * a transposed axis or an off-by-one still produces a plausible structure name
 * over the wrong anatomy. So the grids here are built by hand, small enough to
 * reason about voxel by voxel, and every expectation is a coordinate someone
 * can check on paper.
 */
import { describe, expect, it } from 'vitest';

import {
  sampleLayer,
  sampleLayers,
  samplersEqual,
  worldToIndex,
  type AnatomyHit,
  type SamplerGrid,
  type SamplerLayer,
} from './anatomySampler';

const N = 4;

/** 4 x 4 x 4, 2 mm voxels, axes aligned with LPS, origin at (10, 20, 30). */
const identityGrid: SamplerGrid = {
  dims: [N, N, N],
  origin: [10, 20, 30],
  spacing: [2, 2, 2],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
};

/**
 * The same block with a permuted, partly flipped basis:
 *   +i runs along -y, +j along +z, +k along +x.
 * Still orthonormal, still right-handed, and nothing like the identity — which
 * is what makes it a real test of the transpose-instead-of-inverse shortcut.
 * Anisotropic spacing too, so an axis/spacing mix-up cannot hide.
 */
const permutedGrid: SamplerGrid = {
  dims: [N, N, N],
  origin: [10, 20, 30],
  spacing: [1, 2, 4],
  direction: [0, -1, 0, 0, 0, 1, 1, 0, 0],
};

function emptyData(): Uint8Array {
  return new Uint8Array(N * N * N);
}

/** Write a segment index at a voxel, C order (k, j, i) — i fastest. */
function poke(data: Uint8Array, i: number, j: number, k: number, value: number): void {
  data[k * N * N + j * N + i] = value;
}

function layer(
  segmentationId: string,
  data: Uint8Array,
  names: Array<[number, string]>,
  options: { grid?: SamplerGrid; priority?: number } = {},
): SamplerLayer {
  return {
    segmentationId,
    grid: options.grid ?? identityGrid,
    data,
    names: new Map(names),
    colors: new Map(names.map(([index]) => [index, `#00${index}00`])),
    priority: options.priority,
  };
}

describe('worldToIndex', () => {
  it('maps the origin to voxel (0, 0, 0)', () => {
    expect(worldToIndex(identityGrid, [10, 20, 30])).toEqual([0, 0, 0]);
  });

  it('walks one voxel per spacing step along each axis', () => {
    expect(worldToIndex(identityGrid, [14, 20, 30])).toEqual([2, 0, 0]);
    expect(worldToIndex(identityGrid, [10, 26, 30])).toEqual([0, 3, 0]);
    expect(worldToIndex(identityGrid, [10, 20, 32])).toEqual([0, 0, 1]);
    expect(worldToIndex(identityGrid, [16, 24, 36])).toEqual([3, 2, 3]);
  });

  it('rounds to the nearest voxel centre rather than truncating', () => {
    // 1.2 mm past the origin is 0.6 of a voxel: nearest centre is voxel 1.
    expect(worldToIndex(identityGrid, [11.2, 20, 30])).toEqual([1, 0, 0]);
    // 0.8 mm is 0.4 of a voxel: still voxel 0.
    expect(worldToIndex(identityGrid, [10.8, 20, 30])).toEqual([0, 0, 0]);
    // Half a voxel short of the far edge is still inside the last voxel.
    expect(worldToIndex(identityGrid, [16.9, 20, 30])).toEqual([3, 0, 0]);
  });

  it('inverts a permuted, flipped basis exactly', () => {
    expect(worldToIndex(permutedGrid, [10, 20, 30])).toEqual([0, 0, 0]);
    // +i is -y at 1 mm spacing: three voxels of i is y = 20 - 3.
    expect(worldToIndex(permutedGrid, [10, 17, 30])).toEqual([3, 0, 0]);
    // +j is +z at 2 mm spacing.
    expect(worldToIndex(permutedGrid, [10, 20, 34])).toEqual([0, 2, 0]);
    // +k is +x at 4 mm spacing.
    expect(worldToIndex(permutedGrid, [18, 20, 30])).toEqual([0, 0, 2]);
    // All three at once.
    expect(worldToIndex(permutedGrid, [22, 19, 36])).toEqual([1, 3, 3]);
  });

  it('refuses a point on the wrong side of the origin in the flipped basis', () => {
    // +y is -i, so anything above the origin in y is outside.
    expect(worldToIndex(permutedGrid, [10, 22, 30])).toBeNull();
  });

  it('returns null outside each of the six faces', () => {
    expect(worldToIndex(identityGrid, [6, 24, 34])).toBeNull(); // -i
    expect(worldToIndex(identityGrid, [18, 24, 34])).toBeNull(); // +i
    expect(worldToIndex(identityGrid, [14, 16, 34])).toBeNull(); // -j
    expect(worldToIndex(identityGrid, [14, 28, 34])).toBeNull(); // +j
    expect(worldToIndex(identityGrid, [14, 24, 26])).toBeNull(); // -k
    expect(worldToIndex(identityGrid, [14, 24, 38])).toBeNull(); // +k
  });

  it('keeps the outer half of the boundary voxels, and folds -0 into 0', () => {
    // Voxel 0 spans half a spacing either side of the origin, so a point 0.9 mm
    // "before" the origin is still inside it — and must not come back as -0.
    const inside = worldToIndex(identityGrid, [9.1, 20, 30]);
    expect(inside).toEqual([0, 0, 0]);
    expect(Object.is(inside?.[0], -0)).toBe(false);
    // A full voxel before the origin is genuinely outside.
    expect(worldToIndex(identityGrid, [7.9, 20, 30])).toBeNull();
  });

  it('treats the last voxel as inside and the next one as outside', () => {
    expect(worldToIndex(identityGrid, [16, 26, 36])).toEqual([3, 3, 3]);
    expect(worldToIndex(identityGrid, [18, 26, 36])).toBeNull();
  });

  it('rejects a degenerate grid and non-finite points instead of guessing', () => {
    const zeroSpacing: SamplerGrid = { ...identityGrid, spacing: [0, 2, 2] };
    expect(worldToIndex(zeroSpacing, [10, 20, 30])).toBeNull();
    expect(worldToIndex(identityGrid, [Number.NaN, 20, 30])).toBeNull();
  });
});

describe('sampleLayer', () => {
  const data = emptyData();
  poke(data, 1, 2, 3, 7); // named
  poke(data, 0, 0, 0, 9); // set but never named
  const parotid = layer('seg-a', data, [[7, 'Left parotid']]);

  it('names the structure at a known voxel', () => {
    // voxel (1, 2, 3) sits at origin + (2, 4, 6) mm.
    const hit = sampleLayer(parotid, [12, 24, 36]);
    expect(hit).not.toBeNull();
    expect(hit?.name).toBe('Left parotid');
    expect(hit?.segmentIndex).toBe(7);
    expect(hit?.segmentationId).toBe('seg-a');
    expect(hit?.color).toBe('#00700');
  });

  it('indexes C order (k, j, i) — a transposed read would land elsewhere', () => {
    // (3, 2, 1) is the transposed voxel and must be empty.
    expect(sampleLayer(parotid, [16, 24, 32])).toBeNull();
  });

  it('returns null on background', () => {
    expect(sampleLayer(parotid, [14, 24, 36])).toBeNull();
  });

  it('returns null on a set but unnamed segment index', () => {
    expect(sampleLayer(parotid, [10, 20, 30])).toBeNull();
  });

  it('returns null outside the grid', () => {
    expect(sampleLayer(parotid, [1000, 1000, 1000])).toBeNull();
  });

  it('falls back to currentColor when a name has no swatch', () => {
    const noColor: SamplerLayer = { ...parotid, colors: new Map() };
    expect(sampleLayer(noColor, [12, 24, 36])?.color).toBe('currentColor');
  });
});

describe('sampleLayers', () => {
  /** Both layers claim voxel (1, 1, 1); only `top` claims (2, 2, 2). */
  function overlapping(bottomPriority?: number, topPriority?: number): SamplerLayer[] {
    const bottomData = emptyData();
    poke(bottomData, 1, 1, 1, 1);
    poke(bottomData, 3, 3, 3, 1);
    const topData = emptyData();
    poke(topData, 1, 1, 1, 2);
    poke(topData, 2, 2, 2, 2);
    return [
      layer('seg-bottom', bottomData, [[1, 'Bone']], { priority: bottomPriority }),
      layer('seg-top', topData, [[2, 'Node level II']], { priority: topPriority }),
    ];
  }

  const at111: [number, number, number] = [12, 22, 32];
  const at222: [number, number, number] = [14, 24, 34];
  const at333: [number, number, number] = [16, 26, 36];

  it('returns null when nothing is registered', () => {
    expect(sampleLayers([], at111)).toBeNull();
  });

  it('prefers the most recently registered layer on an overlap', () => {
    expect(sampleLayers(overlapping(), at111)?.name).toBe('Node level II');
  });

  it('lets a higher priority beat registration order', () => {
    expect(sampleLayers(overlapping(5, 0), at111)?.name).toBe('Bone');
  });

  it('still prefers the later registration when priorities tie', () => {
    expect(sampleLayers(overlapping(3, 3), at111)?.name).toBe('Node level II');
  });

  it('falls through to a lower-priority layer where the winner is background', () => {
    // The high-priority bottom layer is empty at (2, 2, 2).
    expect(sampleLayers(overlapping(5, 0), at222)?.name).toBe('Node level II');
    // And the top layer is empty at (3, 3, 3).
    expect(sampleLayers(overlapping(), at333)?.name).toBe('Bone');
  });

  it('returns null where every layer is background', () => {
    expect(sampleLayers(overlapping(), [10, 20, 30])).toBeNull();
  });
});

describe('samplersEqual', () => {
  const hit = (patch: Partial<AnatomyHit> = {}): AnatomyHit => ({
    segmentationId: 'seg-a',
    segmentIndex: 7,
    name: 'Left parotid',
    color: '#f00',
    ...patch,
  });

  it('treats two nulls as unchanged', () => {
    expect(samplersEqual(null, null)).toBe(true);
  });

  it('treats structurally identical hits as unchanged', () => {
    expect(samplersEqual(hit(), hit())).toBe(true);
  });

  it('is true for the same object', () => {
    const one = hit();
    expect(samplersEqual(one, one)).toBe(true);
  });

  it('sees a different segment index', () => {
    expect(samplersEqual(hit(), hit({ segmentIndex: 8 }))).toBe(false);
  });

  it('sees the same index in a different segmentation', () => {
    expect(samplersEqual(hit(), hit({ segmentationId: 'seg-b' }))).toBe(false);
  });

  it('sees a rename and a recolour, so the chip refreshes in place', () => {
    expect(samplersEqual(hit(), hit({ name: 'Right parotid' }))).toBe(false);
    expect(samplersEqual(hit(), hit({ color: '#0f0' }))).toBe(false);
  });

  it('sees entering and leaving a structure', () => {
    expect(samplersEqual(null, hit())).toBe(false);
    expect(samplersEqual(hit(), null)).toBe(false);
  });
});
