/**
 * Airway result → words and grades.
 *
 * Pure: no Cornerstone, no store, so it is unit testable on its own.
 */
import type { AirwayResult } from '../../api/client';

export type MyerCotton = 'I' | 'II' | 'III' | 'IV';

/** Myer–Cotton grade → severity colour (DESIGN.md ok / warn / danger). */
export type GradeSeverity = 'ok' | 'warn' | 'danger';

export const GRADE_SEVERITY: Record<MyerCotton, GradeSeverity> = {
  I: 'ok',
  II: 'warn',
  III: 'danger',
  IV: 'danger',
};

export const GRADE_RANGE: Record<MyerCotton, string> = {
  I: 'up to 50 % obstruction',
  II: '51 – 70 % obstruction',
  III: '71 – 99 % obstruction',
  IV: 'no detectable lumen',
};

/** Equivalent circular diameter of a cross-sectional area. */
export function equivalentDiameterMm(csaMm2: number): number {
  return 2 * Math.sqrt(Math.max(csaMm2, 0) / Math.PI);
}

/**
 * Equivalent diameter at the narrowest point. The backend already publishes
 * `eq_diameter_mm` per sample (CONTRACT.md: 2·sqrt(CSA/pi)); prefer its value
 * so the sentence and the chart can never disagree.
 */
export function minEquivalentDiameterMm(r: AirwayResult): number {
  const fromApi = r.eq_diameter_mm?.[r.min_csa_index];
  return typeof fromApi === 'number' && Number.isFinite(fromApi)
    ? fromApi
    : equivalentDiameterMm(r.min_csa_mm2);
}

/** The narrative sentence for the measurement list and the report. */
export function narrative(r: AirwayResult): string {
  const parts = [
    `Min CSA ${r.min_csa_mm2.toFixed(1)} mm² (eq. ⌀ ${minEquivalentDiameterMm(r).toFixed(1)} mm)`,
    `${Math.round(r.stenosis_pct)}% reduction over ${Math.round(r.stenosis_length_mm)} mm`,
  ];
  if (r.distance_from_glottis_mm !== null && r.distance_from_glottis_mm !== undefined) {
    parts.push(`${Math.round(r.distance_from_glottis_mm)} mm below glottis`);
  }
  if (r.myer_cotton_grade) parts.push(`Myer–Cotton ${r.myer_cotton_grade}`);
  return parts.join(', ');
}
