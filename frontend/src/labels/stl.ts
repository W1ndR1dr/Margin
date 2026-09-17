/**
 * Binary STL reader.
 *
 * `GET /api/analysis/label/{id}/mesh` returns a binary STL in patient LPS
 * millimetres — the same frame Cornerstone's world coordinates use — so the
 * triangles can go straight onto a vtk.js actor with no transform.
 *
 * Pure and Cornerstone-free so it can be unit tested.
 */

export interface StlMesh {
  /** Flat xyz triples, three vertices per triangle. */
  points: Float32Array;
  /** vtk cell array: `[3, a, b, c, 3, d, e, f, …]`. */
  polys: Uint32Array;
  triangles: number;
  /** `[minX, minY, minZ, maxX, maxY, maxZ]`, or null for an empty mesh. */
  bounds: [number, number, number, number, number, number] | null;
}

const HEADER_BYTES = 80;
const COUNT_BYTES = 4;
const TRIANGLE_BYTES = 50;

export class StlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StlParseError';
  }
}

/** True when the buffer looks like ASCII STL ("solid …" and no binary payload). */
function looksAscii(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 6) return false;
  const head = new Uint8Array(buffer, 0, 6);
  const text = String.fromCharCode(...head).toLowerCase();
  if (text !== 'solid ' && text !== 'solid\n') return false;
  // A binary STL may still start with "solid" in its header; the size check is
  // what actually decides.
  if (buffer.byteLength < HEADER_BYTES + COUNT_BYTES) return true;
  const view = new DataView(buffer);
  const n = view.getUint32(HEADER_BYTES, true);
  return buffer.byteLength !== HEADER_BYTES + COUNT_BYTES + n * TRIANGLE_BYTES;
}

export function parseBinaryStl(buffer: ArrayBuffer): StlMesh {
  if (looksAscii(buffer)) {
    throw new StlParseError('that STL is ASCII; the backend is expected to send binary STL');
  }
  if (buffer.byteLength < HEADER_BYTES + COUNT_BYTES) {
    throw new StlParseError('the STL is too short to hold a header');
  }

  const view = new DataView(buffer);
  const count = view.getUint32(HEADER_BYTES, true);
  const need = HEADER_BYTES + COUNT_BYTES + count * TRIANGLE_BYTES;
  if (count > 0 && buffer.byteLength < need) {
    throw new StlParseError(
      `the STL claims ${count} triangles (${need} bytes) but is only ${buffer.byteLength} bytes`,
    );
  }

  const points = new Float32Array(count * 9);
  const polys = new Uint32Array(count * 4);
  let bounds: [number, number, number, number, number, number] | null = null;

  let at = HEADER_BYTES + COUNT_BYTES;
  for (let t = 0; t < count; t++) {
    // 3 floats of facet normal, then the three vertices.
    let p = at + 12;
    for (let v = 0; v < 3; v++) {
      const x = view.getFloat32(p, true);
      const y = view.getFloat32(p + 4, true);
      const z = view.getFloat32(p + 8, true);
      const o = t * 9 + v * 3;
      points[o] = x;
      points[o + 1] = y;
      points[o + 2] = z;
      if (!bounds) bounds = [x, y, z, x, y, z];
      else {
        if (x < bounds[0]) bounds[0] = x;
        if (y < bounds[1]) bounds[1] = y;
        if (z < bounds[2]) bounds[2] = z;
        if (x > bounds[3]) bounds[3] = x;
        if (y > bounds[4]) bounds[4] = y;
        if (z > bounds[5]) bounds[5] = z;
      }
      p += 12;
    }
    const c = t * 4;
    polys[c] = 3;
    polys[c + 1] = t * 3;
    polys[c + 2] = t * 3 + 1;
    polys[c + 3] = t * 3 + 2;
    at += TRIANGLE_BYTES;
  }

  return { points, polys, triangles: count, bounds };
}
