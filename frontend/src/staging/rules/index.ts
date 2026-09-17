/** Site registry: one `SiteRules` per AJCC 8 head & neck chapter. */

import type { Site, SiteRules } from '../types';

import cutaneousSccHnRules from './cutaneous_scc_hn';
import hypopharynxRules from './hypopharynx';
import larynxGlotticRules from './larynx_glottic';
import larynxSubglotticRules from './larynx_subglottic';
import larynxSupraglotticRules from './larynx_supraglottic';
import majorSalivaryRules from './major_salivary';
import mucosalMelanomaHnRules from './mucosal_melanoma_hn';
import nasalCavityParanasalRules from './nasal_cavity_paranasal';
import nasopharynxRules from './nasopharynx';
import oralCavityRules from './oral_cavity';
import oropharynxP16NegRules from './oropharynx_p16neg';
import oropharynxP16PosRules from './oropharynx_p16pos';
import thyroidAnaplasticRules from './thyroid_anaplastic';
import thyroidDifferentiatedRules from './thyroid_differentiated';
import thyroidMedullaryRules from './thyroid_medullary';
import unknownPrimaryRules from './unknown_primary';

export const SITE_RULES: Record<Site, SiteRules> = {
  oral_cavity: oralCavityRules,
  oropharynx_p16pos: oropharynxP16PosRules,
  oropharynx_p16neg: oropharynxP16NegRules,
  hypopharynx: hypopharynxRules,
  larynx_supraglottic: larynxSupraglotticRules,
  larynx_glottic: larynxGlotticRules,
  larynx_subglottic: larynxSubglotticRules,
  nasopharynx: nasopharynxRules,
  major_salivary: majorSalivaryRules,
  nasal_cavity_paranasal: nasalCavityParanasalRules,
  thyroid_differentiated: thyroidDifferentiatedRules,
  thyroid_medullary: thyroidMedullaryRules,
  thyroid_anaplastic: thyroidAnaplasticRules,
  cutaneous_scc_hn: cutaneousSccHnRules,
  unknown_primary: unknownPrimaryRules,
  mucosal_melanoma_hn: mucosalMelanomaHnRules,
};

export function rulesFor(site: Site): SiteRules {
  return SITE_RULES[site];
}

export {
  cutaneousSccHnRules,
  hypopharynxRules,
  larynxGlotticRules,
  larynxSubglotticRules,
  larynxSupraglotticRules,
  majorSalivaryRules,
  mucosalMelanomaHnRules,
  nasalCavityParanasalRules,
  nasopharynxRules,
  oralCavityRules,
  oropharynxP16NegRules,
  oropharynxP16PosRules,
  thyroidAnaplasticRules,
  thyroidDifferentiatedRules,
  thyroidMedullaryRules,
  unknownPrimaryRules,
};
