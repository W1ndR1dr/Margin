/**
 * Neck level mapper — transverse band boundaries for the sagittal / coronal
 * overlay. The UI draws each band as a translucent horizontal strip between
 * zFrom (inferior edge) and zTo (superior edge), both in LPS mm.
 *
 * Only the z (cranio-caudal) divisions are described here: the anterior /
 * posterior and medial / lateral divisions vary with z and per side, so they
 * belong to the axial overlay, not to a band.
 */

import type { Landmarks } from './types';

/** Fallback superior extent above the hyoid when skullBaseZ is not supplied. */
export const DEFAULT_SKULL_BASE_ABOVE_HYOID_MM = 90;

/** Fallback inferior extent below the cricoid when clavicleZ is not supplied. */
export const DEFAULT_CLAVICLE_BELOW_CRICOID_MM = 45;

/** How far below the clavicle the level VII band is drawn. */
export const VII_BAND_DEPTH_MM = 60;

export interface LevelBand {
  /** Band label, e.g. 'I/II' — several levels share one z range. */
  level: string;
  /** Inferior edge, LPS mm (always <= zTo). */
  zFrom: number;
  /** Superior edge, LPS mm. */
  zTo: number;
}

export interface LevelBands {
  z: LevelBand[];
}

/**
 * Band boundaries, ordered superior to inferior:
 *   I/II  hyoid -> skull base
 *   III   cricoid -> hyoid
 *   IV    clavicle -> cricoid
 *   VII   below the clavicle
 *
 * Level V shares the III (Va) and IV (Vb) z ranges and so has no band of its
 * own; it is separated from III / IV by the SCM posterior border in the axial
 * plane, which a sagittal band cannot express.
 */
export function levelBands(lm: Landmarks): LevelBands {
  const hyoid = lm.hyoidInferiorZ;
  const cricoid = lm.cricoidInferiorZ;
  const skullBase =
    typeof lm.skullBaseZ === 'number' ? lm.skullBaseZ : hyoid + DEFAULT_SKULL_BASE_ABOVE_HYOID_MM;
  const clavicle =
    typeof lm.clavicleZ === 'number'
      ? lm.clavicleZ
      : cricoid - DEFAULT_CLAVICLE_BELOW_CRICOID_MM;

  return {
    z: [
      { level: 'I/II', zFrom: hyoid, zTo: skullBase },
      { level: 'III', zFrom: cricoid, zTo: hyoid },
      { level: 'IV', zFrom: clavicle, zTo: cricoid },
      { level: 'VII', zFrom: clavicle - VII_BAND_DEPTH_MM, zTo: clavicle },
    ],
  };
}

/** The band whose z range contains `z`, or null when none does. */
export function bandAtZ(bands: LevelBands, z: number): LevelBand | null {
  for (const b of bands.z) {
    if (z >= b.zFrom && z <= b.zTo) return b;
  }
  return null;
}
