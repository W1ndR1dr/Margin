/**
 * "What is under the cursor?" — the arithmetic, with nothing else attached.
 *
 * The anatomy chip has to answer that question on every mouse-move. The answer
 * is one affine inverse and one array read per labelmap, which is cheap enough
 * that the honest place to run it is the pointer handler itself. Everything in
 * this file is therefore deliberately pure: no Cornerstone, no DOM, no store.
 * That keeps it unit-testable, and it keeps the door open for a worker — the
 * inputs are a plain object plus a Uint8Array, both structured-cloneable and
 * transferable — if profiling ever says the main thread cannot afford it.
 * (See the threading note in `anatomyProbe.ts`; today it cannot be justified.)
 */

/** A labelmap's voxel grid, in the frame the backend published (CONTRACT.md `/mask` headers). */
export interface SamplerGrid {
  /** [nx, ny, nz] — voxel counts along i (column), j (row), k (slice). */
  dims: [number, number, number];
  /** LPS mm of voxel (0,0,0). */
  origin: [number, number, number];
  /** [dx, dy, dz] mm along i, j, k. */
  spacing: [number, number, number];
  /** Row-major 9 floats: rowDir (+i), colDir (+j), sliceDir (+k). */
  direction: number[];
}

export interface SamplerLayer {
  segmentationId: string;
  grid: SamplerGrid;
  /** Raw voxels, C order (k, j, i), one byte per voxel. */
  data: Uint8Array;
  /** segmentIndex -> display name. Index 0 is always background. */
  names: Map<number, string>;
  /** segmentIndex -> css colour, for the chip swatch. */
  colors: Map<number, string>;
  /** Layers with a higher priority win when several overlap. Default 0. */
  priority?: number;
}

export interface AnatomyHit {
  segmentationId: string;
  segmentIndex: number;
  name: string;
  color: string;
}

/**
 * Shown when a segment has a name but no colour registered — a named structure
 * with a missing swatch should still light the chip up rather than vanish.
 */
const FALLBACK_COLOR = 'currentColor';

/**
 * Voxel index containing `world` (LPS mm), or null when the point is outside
 * the grid.
 *
 * The forward map is `P = origin + i·dx·rowDir + j·dy·colDir + k·dz·sliceDir`.
 * Inverting it in general means a 4x4 inverse (or an LU solve) per sample.
 * We do not need one: every grid the backend publishes has an orthonormal
 * direction basis — it comes from the DICOM ImageOrientationPatient pair plus
 * their cross product, so the three axes are unit length and mutually
 * perpendicular. For an orthonormal basis the inverse IS the transpose, which
 * makes the inverse map three dot products and three divisions. That is not an
 * approximation: it is exact for orthonormal input, and it is ~1000x cheaper
 * than building and applying a general inverse. At 60 fps, with a pointer that
 * can fire several moves per frame, that difference is the whole design.
 *
 * If a non-orthonormal grid ever arrives the result would be wrong rather than
 * merely imprecise — but `segmentationService.addLabelmap` refuses any mask
 * that does not sit on the CT grid (`describeMismatch`), so a skewed labelmap
 * never reaches this far.
 */
export function worldToIndex(
  grid: SamplerGrid,
  world: readonly [number, number, number],
): [number, number, number] | null {
  const { origin, spacing, direction: d, dims } = grid;
  if (spacing[0] <= 0 || spacing[1] <= 0 || spacing[2] <= 0) return null;

  // P - origin, once; the three projections reuse it.
  const px = world[0] - origin[0];
  const py = world[1] - origin[1];
  const pz = world[2] - origin[2];

  const i = Math.round((px * d[0] + py * d[1] + pz * d[2]) / spacing[0]);
  const j = Math.round((px * d[3] + py * d[4] + pz * d[5]) / spacing[1]);
  const k = Math.round((px * d[6] + py * d[7] + pz * d[8]) / spacing[2]);

  // Written as a negated `>=` so NaN falls out here too: a non-finite world
  // point fails every comparison, where a plain `< 0` would have let it pass.
  if (!(i >= 0 && j >= 0 && k >= 0)) return null;
  if (i >= dims[0] || j >= dims[1] || k >= dims[2]) return null;

  // `+ 0` folds -0 into 0. A point in the lower half of voxel 0 rounds to -0,
  // which indexes correctly but compares unequal to 0 under Object.is, so it
  // would surprise a caller (and a test). Must stay below the NaN guard.
  return [i + 0, j + 0, k + 0];
}

/**
 * The structure of `layer` at `world`, or null for background.
 *
 * Null also covers "a voxel is set but nobody told us what it is": a segment
 * index without a name is a bookkeeping gap, and an anatomy chip reading
 * "segment 7" is worse than no chip at all.
 */
export function sampleLayer(
  layer: SamplerLayer,
  world: readonly [number, number, number],
): AnatomyHit | null {
  const idx = worldToIndex(layer.grid, world);
  if (!idx) return null;

  const [nx, ny] = layer.grid.dims;
  // C order, i fastest — the order both the backend and vtk use.
  const value = layer.data[idx[2] * nx * ny + idx[1] * nx + idx[0]];
  if (!value) return null;

  const name = layer.names.get(value);
  if (name === undefined) return null;

  return {
    segmentationId: layer.segmentationId,
    segmentIndex: value,
    name,
    color: layer.colors.get(value) ?? FALLBACK_COLOR,
  };
}

/**
 * The winning structure across several labelmaps: highest `priority` first,
 * then most recently registered first.
 *
 * Implemented as one backwards pass rather than a sort. Walking the array in
 * reverse already gives "last registered first" inside a priority level, and
 * only a *strictly* higher priority may displace the incumbent — which makes
 * the result identical to sorting by (priority desc, registration desc) and
 * taking the first hit, while allocating nothing. At a dozen resident
 * labelmaps the extra reads cost less than the sort's array would.
 */
export function sampleLayers(
  layers: SamplerLayer[],
  world: readonly [number, number, number],
): AnatomyHit | null {
  let best: AnatomyHit | null = null;
  let bestPriority = 0;

  for (let n = layers.length - 1; n >= 0; n--) {
    const layer = layers[n];
    const priority = layer.priority ?? 0;
    if (best !== null && priority <= bestPriority) continue;
    const hit = sampleLayer(layer, world);
    if (hit) {
      best = hit;
      bestPriority = priority;
    }
  }
  return best;
}

/**
 * Is this the same structure as last time?
 *
 * This is the performance lever for the whole feature. The cursor spends
 * almost all of its life inside one structure (or on background), so the
 * overwhelmingly common answer is "yes, nothing changed" — and that answer
 * must cost a couple of comparisons and no React render. Identity is
 * (segmentation, segment); name and colour are compared too so that renaming
 * or recolouring a row while the cursor rests on it still refreshes the chip.
 */
export function samplersEqual(a: AnatomyHit | null, b: AnatomyHit | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.segmentIndex === b.segmentIndex &&
    a.segmentationId === b.segmentationId &&
    a.name === b.name &&
    a.color === b.color
  );
}
