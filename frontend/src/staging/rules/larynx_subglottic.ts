/**
 * Larynx, subglottis — AJCC 8. rule:lar.subglottic.T, rule:common.N.*,
 * rule:common.group.standard
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
import { commonN, firstFlag, flag, say, standardHnStageGroup } from './common';

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
      [p.cricoid_invasion, 'invasion through the cricoid cartilage'],
      [p.thyroid_cartilage_through, 'invasion through the outer cortex of the thyroid cartilage'],
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
      [p.vocal_cord_involvement, 'extension to the vocal cord(s), mobility normal or impaired'],
      [p.impaired_vocal_cord_mobility, 'extension to the vocal cord(s) with impaired mobility'],
      [p.supraglottic_extension, 'extension to the vocal cord(s) and above'],
    ],
    context,
  );
  if (t2) {
    trace.push(say(`${label}2`, t2.phrase, t2.obs));
    return { category: 'T2', trace };
  }

  const limited = flag(p.limited_to_larynx, context) ?? flag(p.subglottic_extension, context);
  if (limited) {
    trace.push(say(`${label}1`, 'limited to the subglottis', limited));
    return { category: 'T1', trace };
  }
  return {
    category: 'TX',
    trace: [say(`${label}X`, 'subglottic T needs an extension descriptor or "limited to subglottis"')],
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

export const larynxSubglotticRules: SiteRules = {
  site: 'larynx_subglottic',
  label: 'Larynx, subglottis',
  stageT,
  stageN,
  stageGroup,
  ruleIds: ['lar.subglottic.T', 'common.N.clinical', 'common.N.pathologic', 'common.group.standard'],
};

export default larynxSubglotticRules;
