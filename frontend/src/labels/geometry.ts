/**
 * Mask geometry: the X-* headers of `GET /api/analysis/label/{id}/mask`
 * translated into the frame Cornerstone uses for a volume.
 *
 * Header axis order is the numpy array order `(z, y, x)`; Cornerstone counts
 * `[i, j, k]` = `[column, row, slice]`, so shape and spacing are reversed on
 * the way in. The direction matrix is already row-major rowDir/colDir/sliceDir,
 * which is exactly vtk's `direction`, so it passes through untouched.
 *
 * Pure — no Cornerstone import — so it is unit testable.
 */

export interface MaskGeometry {
  /** `[nx, ny, nz]` — Cornerstone/vtk order. */
  dimensions: [number, number, number];
  /** `[dx, dy, dz]` mm. */
  spacing: [number, number, number];
  /** LPS mm of voxel (0, 0, 0). */
  origin: [number, number, number];
  /** 9 floats, row major: +i axis, +j axis, +k axis. */
  direction: number[];
  labelId: string | null;
  seriesUid: string | null;
}

export class MaskGeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaskGeometryError';
  }
}

function numbers(raw: string | undefined, want: number, what: string): number[] {
  if (!raw) throw new MaskGeometryError(`the mask response is missing ${what}`);
  const parts = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  if (parts.length !== want) {
    throw new MaskGeometryError(`${what} should list ${want} numbers, got "${raw}"`);
  }
  return parts;
}

/** Parse the X-Shape / X-Spacing / X-Origin / X-Direction headers. */
export function parseMaskHeaders(headers: Record<string, string>): MaskGeometry {
  // HTTP header names are case insensitive; fetch lower-cases them, but a hand
  // written record (or a test fixture) may not.
  const lower: Record<string, string> = {};
  Object.entries(headers).forEach(([k, v]) => {
    lower[k.toLowerCase()] = v;
  });
  const get = (k: string): string | undefined => lower[k.toLowerCase()];

  const [nz, ny, nx] = numbers(get('x-shape'), 3, 'X-Shape');
  const [dz, dy, dx] = numbers(get('x-spacing'), 3, 'X-Spacing');
  const origin = numbers(get('x-origin'), 3, 'X-Origin') as [number, number, number];
  const direction = numbers(get('x-direction'), 9, 'X-Direction');

  if (nx < 1 || ny < 1 || nz < 1 || !Number.isInteger(nx) || !Number.isInteger(ny) || !Number.isInteger(nz)) {
    throw new MaskGeometryError(`X-Shape is not a usable volume size: "${get('x-shape')}"`);
  }
  if (dx <= 0 || dy <= 0 || dz <= 0) {
    throw new MaskGeometryError(`X-Spacing must be positive, got "${get('x-spacing')}"`);
  }

  return {
    dimensions: [nx, ny, nz],
    spacing: [dx, dy, dz],
    origin,
    direction,
    labelId: get('x-label-id') ?? null,
    seriesUid: get('x-series-uid') ?? null,
  };
}

/** Voxel count implied by a geometry. */
export function voxelCount(g: MaskGeometry): number {
  return g.dimensions[0] * g.dimensions[1] * g.dimensions[2];
}

/**
 * The backend guarantees a mask on the same grid as the CT. Trust but verify:
 * a silent mismatch would paint the labelmap onto the wrong anatomy.
 * Returns a human-readable complaint, or null when the two grids agree.
 */
export function describeMismatch(
  mask: MaskGeometry,
  ct: { dimensions: readonly number[]; spacing?: readonly number[] },
  spacingTolMm = 0.01,
): string | null {
  const [mx, my, mz] = mask.dimensions;
  const [cx, cy, cz] = [ct.dimensions[0], ct.dimensions[1], ct.dimensions[2]];
  if (mx !== cx || my !== cy || mz !== cz) {
    return `the mask is ${mx}×${my}×${mz} but the CT volume is ${cx}×${cy}×${cz}`;
  }
  if (ct.spacing) {
    const off = mask.spacing.findIndex((s, i) => Math.abs(s - (ct.spacing?.[i] ?? s)) > spacingTolMm);
    if (off >= 0) {
      return `mask voxel spacing ${mask.spacing.map((s) => s.toFixed(3)).join(' × ')} mm does not match the CT ${[
        ct.spacing[0],
        ct.spacing[1],
        ct.spacing[2],
      ]
        .map((s) => Number(s).toFixed(3))
        .join(' × ')} mm`;
    }
  }
  return null;
}
