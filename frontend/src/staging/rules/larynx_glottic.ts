/**
 * Larynx, glottis — AJCC 8. rule:lar.glottic.T, rule:common.N.*,
 * rule:common.group.standard
 *
 * `subsite_count` is read here as the number of vocal cords involved, which is
 * what separates T1a (one cord) from T1b (both cords).
 */

import type {
  CategoryResult,
  GroupResult,
  MCategory,
  NCategory,
  SiteRules,
  StagingContext,
  StagingInput,
  TCategory,
} from '../types';
import {
  commonN,
  firstFlag,
  flag,
  num,
  say,
  standardHnStageGroup,
} from './common';

export function stageT(
  input: StagingInput,
  context: StagingContext = 'clinical',
): CategoryResult<TCategory> {
  const p = input.primary ?? {};
  const label = context === 'pathologic' ? 'pT' : 'cT';
  const trace: string[] = [];

  const insitu = flag(p.in_situ, context);
  if (insitu) return { category: 'Tis', trace: [say(`${label}is`, 'carcinoma in situ', insitu)] };

  const t4b = firstFlag(
    [
      [p.prevertebral_fascia_invasion, 'prevertebral space invasion'],
      [p.carotid_encasement, 'carotid artery encasement'],
      [p.mediastinal_structures, 'mediastinal structure invasion'],
    ],
    context,
  );
  if (t4b) return { category: 'T4b', trace: [say(`${label}4b`, t4b.phrase, t4b.obs)] };

  const t4a = firstFlag(
    [
      [p.thyroid_cartilage_through, 'invasion through the thyroid cartilage'],
      [p.trachea_invasion, 'tracheal invasion (beyond the larynx)'],
      [p.extrinsic_tongue_muscle, 'deep extrinsic tongue muscle invasion (beyond the larynx)'],
      [p.strap_muscle_invasion, 'strap muscle invasion (beyond the larynx)'],
      [p.thyroid_gland_invasion, 'thyroid gland invasion (beyond the larynx)'],
      [p.esophagus_invasion, 'oesophageal invasion (beyond the larynx)'],
      [p.soft_tissues_of_neck, 'invasion of the soft tissues of the neck'],
    ],
    context,
  );
  if (t4a) {
    trace.push(say(`${label}4a`, t4a.phrase, t4a.obs));
    return { category: 'T4a', trace };
  }

  const t3 = firstFlag(
    [
      [p.vocal_cord_fixation, 'vocal cord fixation, disease still limited to the larynx'],
      [p.paraglottic_space, 'paraglottic space invasion'],
      [p.thyroid_cartilage_inner_cortex, 'inner cortex of thyroid cartilage invasion'],
    ],
    context,
  );
  if (t3) {
    trace.push(say(`${label}3`, t3.phrase, t3.obs));
    return { category: 'T3', trace };
  }

  const t2 = firstFlag(
    [
      [p.supraglottic_extension, 'extension to the supraglottis'],
      [p.subglottic_extension, 'extension to the subglottis'],
      [p.impaired_vocal_cord_mobility, 'impaired vocal cord mobility'],
    ],
    context,
  );
  if (t2) {
    trace.push(say(`${label}2`, t2.phrase, t2.obs));
    return { category: 'T2', trace };
  }

  const cords = num(p.subsite_count, context);
  const cordInvolved = flag(p.vocal_cord_involvement, context);
  if (cords && cords.value >= 2) {
    trace.push(say(`${label}1b`, 'both vocal cords involved, normal mobility', cords));
    return { category: 'T1b', trace };
  }
  if (cords && cords.value === 1) {
    trace.push(say(`${label}1a`, 'one vocal cord involved, normal mobility', cords));
    return { category: 'T1a', trace };
  }
  if (cordInvolved) {
    trace.push(
      say(`${label}1`, 'limited to the vocal cord(s) with normal mobility; cords involved not specified', cordInvolved),
    );
    return { category: 'T1', trace };
  }
  return {
    category: 'TX',
    trace: [
      say(`${label}X`, 'glottic T needs cord involvement, mobility or an extension descriptor'),
    ],
  };
}

export function stageN(
  input: StagingInput,
  context: StagingContext = 'clinical',
): CategoryResult<NCategory> {
  return commonN(input, context);
}

export function stageGroup(T: TCategory, N: NCategory, M: MCategory): GroupResult {
  return standardHnStageGroup(T, N, M);
}

export const larynxGlotticRules: SiteRules = {
  site: 'larynx_glottic',
  label: 'Larynx, glottis',
  stageT,
  stageN,
  stageGroup,
  ruleIds: ['lar.glottic.T', 'common.N.clinical', 'common.N.pathologic', 'common.group.standard'],
};

export default larynxGlotticRules;
