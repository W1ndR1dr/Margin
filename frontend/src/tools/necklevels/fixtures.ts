/**
 * Neck level mapper — a synthetic but anatomically plausible landmark set.
 *
 * Used by the unit tests and by the UI as a demo / smoke-test scan. LPS mm:
 * +x = patient left, +y = posterior, +z = superior. The right side therefore
 * carries negative x, and the left side is its exact mirror through x = 0.
 */

import type { Landmarks, Point3, SideLandmarks } from './types';

/** Mirror a point through the midline plane x = 0. */
export function mirrorPoint(p: Point3): Point3 {
  return [-p[0], p[1], p[2]];
}

/** Mirror a whole side through the midline plane x = 0. */
export function mirrorSide(s: SideLandmarks): SideLandmarks {
  return {
    scmPosteriorBorder: s.scmPosteriorBorder.map(mirrorPoint),
    submandibularPosterior: mirrorPoint(s.submandibularPosterior),
    ijvCenter: s.ijvCenter.map(mirrorPoint),
    ijvPosteriorEdge: s.ijvPosteriorEdge?.map(mirrorPoint),
    digastricAnteriorMedial: s.digastricAnteriorMedial
      ? mirrorPoint(s.digastricAnteriorMedial)
      : undefined,
    carotidMedial: s.carotidMedial?.map(mirrorPoint),
  };
}

/** Right side (x negative). Polylines are sampled at z = 20 and z = 150. */
export const RIGHT_SIDE: SideLandmarks = {
  scmPosteriorBorder: [
    [-52, 38, 20],
    [-58, 30, 150],
  ],
  submandibularPosterior: [-30, -10, 105],
  ijvCenter: [
    [-36, 8, 20],
    [-30, 2, 150],
  ],
  // ijvPosteriorEdge intentionally omitted: exercises the +5 mm fallback.
  digastricAnteriorMedial: [-12, -40, 100],
  carotidMedial: [
    [-22, 6, 20],
    [-18, 0, 150],
  ],
};

/** Left side (x positive): the exact mirror of the right. */
export const LEFT_SIDE: SideLandmarks = mirrorSide(RIGHT_SIDE);

/** A complete synthetic neck. */
export const SYNTHETIC_LANDMARKS: Landmarks = {
  hyoidInferiorZ: 90,
  cricoidInferiorZ: 50,
  skullBaseZ: 180,
  clavicleZ: 5,
  midlineX: 0,
  right: RIGHT_SIDE,
  left: LEFT_SIDE,
};

/** Fresh deep copy, so a test or the UI can mutate one without side effects. */
export function makeSyntheticLandmarks(): Landmarks {
  return structuredClone(SYNTHETIC_LANDMARKS);
}
