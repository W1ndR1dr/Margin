/**
 * Neck level mapper — shared types.
 *
 * All coordinates are DICOM LPS millimetres, matching the world coordinates the
 * viewer reports (see `viewer/ViewerCore.ts` -> `probe.lps`):
 *   +x = patient LEFT      (so the patient's right side has x < midline)
 *   +y = POSTERIOR         (so "anterior to" means a smaller y)
 *   +z = SUPERIOR          (so "above" means a larger z)
 *
 * This module is pure TypeScript: no React, no Cornerstone, no DOM.
 */

/** A point in DICOM LPS millimetres: [x, y, z]. */
export type Point3 = [number, number, number];

/** Landmarks the user clicks once per side, per scan. */
export interface SideLandmarks {
  /**
   * Posterior border of sternocleidomastoid, sampled as a polyline
   * (one point per ~15 slices). Must contain at least one point.
   * Interpolated linearly in z, clamped outside the sampled range.
   */
  scmPosteriorBorder: Point3[];
  /** Posterior border of the submandibular gland (single point). */
  submandibularPosterior: Point3;
  /** Internal jugular vein centre, sampled polyline. At least one point. */
  ijvCenter: Point3[];
  /**
   * Posterior edge of the IJV, sampled polyline. Optional: when absent it is
   * derived from `ijvCenter` by shifting `IJV_POSTERIOR_EDGE_OFFSET_MM`
   * posteriorly (+y). This is the IIa / IIb divider.
   */
  ijvPosteriorEdge?: Point3[];
  /**
   * Anterior belly of digastric, anteromedial corner (single point).
   * Divides Ia from Ib. Optional: without it, level I collapses to Ib.
   */
  digastricAnteriorMedial?: Point3;
  /**
   * Common carotid / ICA medial edge, sampled polyline. Optional: without it
   * the lateral-to-carotid test is skipped and levels VI and RP cannot be
   * assigned.
   */
  carotidMedial?: Point3[];
}

/** All landmarks for one scan. */
export interface Landmarks {
  /** Inferior edge of the hyoid body (z plane). */
  hyoidInferiorZ: number;
  /** Inferior edge of the cricoid cartilage (z plane). */
  cricoidInferiorZ: number;
  /** Skull base / jugular foramen. Optional; default = no superior limit. */
  skullBaseZ?: number;
  /** Clavicle / sternal notch. Optional; default = no inferior limit. */
  clavicleZ?: number;
  /**
   * Midline x. Optional; default = mean of the two carotid medial edges at the
   * node's z, else 0.
   */
  midlineX?: number;
  left: SideLandmarks;
  right: SideLandmarks;
}

/** Robbins 2008 / AJCC neck levels, plus retropharyngeal and a failure value. */
export type NeckLevel =
  | 'Ia'
  | 'Ib'
  | 'IIa'
  | 'IIb'
  | 'III'
  | 'IV'
  | 'Va'
  | 'Vb'
  | 'VI'
  | 'VII'
  | 'RP'
  | 'unclassified';

export type Side = 'left' | 'right' | 'midline';

/** 'boundary' when the node sits within BOUNDARY_MARGIN_MM of any boundary used. */
export type Confidence = 'clear' | 'boundary';

export interface LevelResult {
  level: NeckLevel;
  side: Side;
  confidence: Confidence;
  /** Smallest absolute distance (mm) to any boundary consulted during classification. */
  marginMm: number;
  /** Human-readable trace, e.g. "above hyoid plane by 12.3 mm". */
  reasons: string[];
}

/** The two anatomical sides that carry landmarks (never 'midline'). */
export type AnatomicSide = 'left' | 'right';
