import { describe, expect, it } from 'vitest';
import {
  classify,
  clockLabel,
  contactAngle,
  hourFromDeg,
  pointInPolygon,
  pointOnCircle,
  signedDistanceToPolygon,
  type Point2,
} from './geometry';

/** Axis-aligned rectangle as a closed polygon (LPS in-plane mm). */
function rect(x0: number, y0: number, x1: number, y1: number): Point2[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

const CENTER: Point2 = [0, 0];
const R = 10;

describe('primitives', () => {
  it('places 0° anterior, 90° patient-left, 180° posterior, 270° patient-right', () => {
    const [ax, ay] = pointOnCircle(CENTER, R, 0);
    expect(ax).toBeCloseTo(0, 6);
    expect(ay).toBeCloseTo(-R, 6); // anterior = −y

    const [lx, ly] = pointOnCircle(CENTER, R, 90);
    expect(lx).toBeCloseTo(R, 6); // patient left = +x
    expect(ly).toBeCloseTo(0, 6);

    const [px, py] = pointOnCircle(CENTER, R, 180);
    expect(px).toBeCloseTo(0, 6);
    expect(py).toBeCloseTo(R, 6); // posterior = +y

    const [rx, ry] = pointOnCircle(CENTER, R, 270);
    expect(rx).toBeCloseTo(-R, 6); // patient right = −x
    expect(ry).toBeCloseTo(0, 6);
  });

  it('maps degrees onto the clock face with 12 o\'clock anterior', () => {
    expect(hourFromDeg(0)).toBe(12);
    expect(hourFromDeg(360)).toBe(12);
    expect(hourFromDeg(90)).toBe(3);
    expect(hourFromDeg(180)).toBe(6);
    expect(hourFromDeg(270)).toBe(9);
    expect(hourFromDeg(-90)).toBe(9);
    expect(hourFromDeg(451)).toBe(3); // wrapped arc end
  });

  it('signs the distance to the polygon: negative inside, positive outside', () => {
    const square = rect(-5, -5, 5, 5);
    expect(pointInPolygon([0, 0], square)).toBe(true);
    expect(pointInPolygon([9, 0], square)).toBe(false);
    expect(signedDistanceToPolygon([0, 0], square)).toBeCloseTo(-5, 6);
    expect(signedDistanceToPolygon([8, 0], square)).toBeCloseTo(3, 6);
    expect(signedDistanceToPolygon([5, 0], square)).toBeCloseTo(0, 6);
  });
});

describe('contactAngle — concentric degenerate cases', () => {
  it('reports 0° when the tumour sits wholly inside the lumen and touches nothing', () => {
    const r = contactAngle({ center: CENTER, radius: R, polygon: rect(-2, -2, 2, 2), tolerance: 1.5 });
    expect(r.angleDeg).toBe(0);
    expect(r.longestArcDeg).toBe(0);
    expect(r.arcs).toEqual([]);
    expect(r.clockFrom).toBeNull();
    expect(r.clockTo).toBeNull();
    expect(clockLabel(r)).toBeNull();
    expect(r.contactMask).toHaveLength(360);
    expect(r.contactMask.some(Boolean)).toBe(false);
    expect(classify(r.angleDeg)).toBe('abutment');
  });

  it('reports a full 360° when the tumour swallows the vessel', () => {
    const r = contactAngle({ center: CENTER, radius: R, polygon: rect(-50, -50, 50, 50), tolerance: 1.5 });
    expect(r.angleDeg).toBe(360);
    expect(r.longestArcDeg).toBe(360);
    expect(r.arcs).toEqual([{ startDeg: 0, endDeg: 360 }]);
    expect(r.clockFrom).toBe(12);
    expect(r.clockTo).toBe(12);
    expect(r.contactMask.every(Boolean)).toBe(true);
    expect(classify(r.angleDeg)).toBe('encasement');
  });

  it('reports 0° for a polygon with too few points or a zero radius', () => {
    expect(contactAngle({ center: CENTER, radius: R, polygon: [[0, 0], [1, 1]] }).angleDeg).toBe(0);
    expect(contactAngle({ center: CENTER, radius: 0, polygon: rect(-50, -50, 50, 50) }).angleDeg).toBe(0);
  });
});

describe('contactAngle — a half-moon of tumour', () => {
  it('gives ~180° for a tumour filling the posterior half-plane', () => {
    const r = contactAngle({
      center: CENTER,
      radius: R,
      polygon: rect(-50, 0, 50, 50), // +y = posterior
      tolerance: 0,
    });
    expect(Math.abs(r.angleDeg - 180)).toBeLessThanOrEqual(2);
    expect(r.arcs).toHaveLength(1);
    expect(Math.abs(r.arcs[0].startDeg - 90)).toBeLessThanOrEqual(2);
    expect(Math.abs(r.longestArcDeg - 180)).toBeLessThanOrEqual(2);
    // posterior contact reads 3 → 9 o'clock going clockwise through 6
    expect(r.clockFrom).toBe(3);
    expect(r.clockTo).toBe(9);
    expect(clockLabel(r)).toBe("3–9 o'clock");
  });

  it('classifies the 180° boundary as partial encasement', () => {
    expect(classify(179.9)).toBe('abutment');
    expect(classify(180)).toBe('partial');
    expect(classify(270)).toBe('partial');
    expect(classify(270.1)).toBe('encasement');
    expect(classify(360)).toBe('encasement');
  });
});

describe('contactAngle — two separate contact arcs', () => {
  // A thin band straight through the vessel touches it on the left and on the
  // right but not anteriorly or posteriorly: the tumour touches in two places.
  const band = rect(-50, -0.5, 50, 0.5);

  it('finds both arcs and does not merge them', () => {
    const r = contactAngle({ center: CENTER, radius: R, polygon: band, tolerance: 0.5 });
    expect(r.arcs).toHaveLength(2);
    // |q_y| ≤ 1 ⇒ |cos θ| ≤ 0.1 ⇒ ±5.74° around 90° and around 270°
    expect(Math.abs(r.angleDeg - 23)).toBeLessThanOrEqual(3);
    expect(Math.abs(r.longestArcDeg - 11.5)).toBeLessThanOrEqual(2);
    expect(r.arcs.every((a) => a.endDeg <= 360)).toBe(true);
    expect(Math.abs(r.arcs[0].startDeg - 84)).toBeLessThanOrEqual(2);
    expect(Math.abs(r.arcs[1].startDeg - 264)).toBeLessThanOrEqual(2);
    // total contact is the sum of the arc extents, exactly
    const sum = r.arcs.reduce((n, a) => n + (a.endDeg - a.startDeg), 0);
    expect(sum).toBeCloseTo(r.angleDeg, 9);
    // the longest arc, not the total, drives the clock range
    expect(r.longestArcDeg).toBeLessThan(r.angleDeg);
  });

  it('grows the contact monotonically with the tolerance', () => {
    const at = (tolerance: number) =>
      contactAngle({ center: CENTER, radius: R, polygon: band, tolerance }).angleDeg;
    const tight = at(0);
    const mid = at(0.5);
    const loose = at(2);
    expect(tight).toBeLessThan(mid);
    expect(mid).toBeLessThan(loose);
    expect(Math.abs(tight - 11.5)).toBeLessThanOrEqual(2);
    expect(Math.abs(loose - 58)).toBeLessThanOrEqual(3);
  });

  it('honours the tolerance as a millimetre gap', () => {
    // nearest edge of the tumour is exactly 2 mm anterior of the circumference
    const plaque = rect(-5, -30, 5, -12);
    expect(contactAngle({ center: CENTER, radius: R, polygon: plaque, tolerance: 1.5 }).angleDeg).toBe(0);
    const touching = contactAngle({ center: CENTER, radius: R, polygon: plaque, tolerance: 2.5 });
    expect(touching.angleDeg).toBeGreaterThan(0);
    // an anterior plaque straddles 12 o'clock: the arc runs 11 → 1
    expect(touching.arcs).toHaveLength(1);
    expect(touching.arcs[0].endDeg).toBeGreaterThan(360);
    expect(touching.clockFrom).toBe(11);
    expect(touching.clockTo).toBe(1);
  });
});

describe('contactAngle — an arc that wraps across 0°', () => {
  it('returns one arc, not two, when the contact straddles anterior', () => {
    const r = contactAngle({
      center: CENTER,
      radius: R,
      polygon: rect(-50, -50, 50, 0), // anterior half-plane
      tolerance: 0,
    });
    expect(r.arcs).toHaveLength(1);
    const [arc] = r.arcs;
    expect(Math.abs(arc.startDeg - 270)).toBeLessThanOrEqual(2);
    expect(arc.endDeg).toBeGreaterThan(360); // the wrap is encoded, not split
    expect(Math.abs(arc.endDeg - arc.startDeg - 180)).toBeLessThanOrEqual(2);
    expect(Math.abs(r.angleDeg - 180)).toBeLessThanOrEqual(2);
    expect(r.clockFrom).toBe(9);
    expect(r.clockTo).toBe(3);
    expect(clockLabel(r)).toBe("9–3 o'clock");
    expect(r.contactMask[0]).toBe(true); // 12 o'clock is inside the wrapped arc
    expect(r.contactMask[180]).toBe(false); // 6 o'clock is not
  });
});

describe('contactAngle — sampling', () => {
  it('respects a coarser sample count', () => {
    const r = contactAngle({
      center: CENTER,
      radius: R,
      polygon: rect(-50, 0, 50, 50),
      tolerance: 0,
      samples: 36,
    });
    expect(r.contactMask).toHaveLength(36);
    expect(Math.abs(r.angleDeg - 180)).toBeLessThanOrEqual(10);
    expect(r.arcs).toHaveLength(1);
  });

  it('is insensitive to the winding direction and to an explicit closing vertex', () => {
    const cw = rect(-50, 0, 50, 50);
    const ccw = [...cw].reverse();
    const closed = [...cw, cw[0]];
    const a = contactAngle({ center: CENTER, radius: R, polygon: cw, tolerance: 0 }).angleDeg;
    const b = contactAngle({ center: CENTER, radius: R, polygon: ccw, tolerance: 0 }).angleDeg;
    const c = contactAngle({ center: CENTER, radius: R, polygon: closed, tolerance: 0 }).angleDeg;
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});

describe('contactAngle — a phantom-like right ICA', () => {
  // Right ICA lumen at x = −22 mm (patient right, −x), 7 mm across. The tumour
  // cups its anteromedial circumference from −10° (just right of 12 o'clock)
  // round to 116°, 1.4 mm off the wall — inside the 1.5 mm contact tolerance.
  it('measures an anteromedial tumour as a sub-180° abutment on a wrapped arc', () => {
    const center: Point2 = [-22, -4];
    const radius = 3.5;
    const inner = radius + 1.4;
    const outer = radius + 12;
    const from = -10;
    const to = 116;

    const polygon: Point2[] = [];
    for (let d = from; d <= to; d += 2) polygon.push(pointOnCircle(center, inner, d));
    for (let d = to; d >= from; d -= 2) polygon.push(pointOnCircle(center, outer, d));

    const r = contactAngle({ center, radius, polygon, tolerance: 1.5 });

    expect(r.angleDeg).toBeGreaterThan(120);
    expect(r.angleDeg).toBeLessThan(175);
    expect(classify(r.angleDeg)).toBe('abutment');
    expect(r.arcs).toHaveLength(1);
    // the traced sector starts just anticlockwise of 12, so the arc wraps
    expect(r.arcs[0].startDeg).toBeGreaterThan(270);
    expect(r.arcs[0].endDeg).toBeGreaterThan(360);
    expect(r.clockFrom).toBe(11);
    expect(r.clockTo).toBe(4);
    // nothing touches the posterolateral wall (7–8 o'clock)
    expect(r.contactMask[225]).toBe(false);
  });
});
