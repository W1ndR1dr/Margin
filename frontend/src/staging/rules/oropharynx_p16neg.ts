/**
 * Oropharynx, p16-negative — AJCC 8 chapter 11 (shared with the hypopharynx).
 * rule:op16neg.T, rule:common.N.*, rule:common.group.standard
 *
 * This chapter has Tis and a T4a/T4b split, and it has no T0: a p16(-) neck
 * node with no primary belongs in the cervical nodes chapter instead.
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
  fmtNum,
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
      [p.lateral_pterygoid_muscle, 'lateral pterygoid muscle invasion'],
      [p.pterygoid_plates, 'pterygoid plate invasion'],
      [p.lateral_nasopharynx, 'lateral nasopharyngeal invasion'],
      [p.skull_base, 'skull base invasion'],
      [p.carotid_encasement, 'carotid artery encasement'],
    ],
    context,
  );
  if (t4b) return { category: 'T4b', trace: [say(`${label}4b`, t4b.phrase, t4b.obs)] };

  const t4a = firstFlag(
    [
      [p.larynx_invasion, 'invasion of the larynx'],
      [p.extrinsic_tongue_muscle, 'extrinsic tongue muscle invasion'],
      [p.medial_pterygoid_muscle, 'medial pterygoid muscle invasion'],
      [p.hard_palate, 'hard palate invasion'],
      [p.mandible_invasion, 'mandible invasion'],
    ],
    context,
  );
  if (t4a) {
    trace.push(say(`${label}4a`, t4a.phrase, t4a.obs));
    return { category: 'T4a', trace };
  }

  const epiglottis = flag(p.epiglottis_lingual_surface, context);
  const size = num(p.size_cm, context);
  if (epiglottis && (!size || size.value <= 4)) {
    trace.push(say(`${label}3`, 'extension to the lingual surface of the epiglottis', epiglottis));
    return { category: 'T3', trace };
  }
  if (!size) {
    return { category: 'TX', trace: [say(`${label}X`, 'greatest dimension not supplied')] };
  }
  const cm = size.value;
  if (cm > 4) {
    trace.push(say(`${label}3`, `${fmtNum(cm, 'cm')} greatest dimension (> 4 cm)`, size));
    return { category: 'T3', trace };
  }
  if (cm > 2) {
    trace.push(say(`${label}2`, `${fmtNum(cm, 'cm')} greatest dimension (> 2 cm, <= 4 cm)`, size));
    return { category: 'T2', trace };
  }
  trace.push(say(`${label}1`, `${fmtNum(cm, 'cm')} greatest dimension (<= 2 cm)`, size));
  return { category: 'T1', trace };
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

export function warnings(input: StagingInput): string[] {
  const p16 = input.patient?.p16;
  if (!p16 || p16 === 'unknown') {
    return [
      'p16 result missing for an oropharyngeal primary. AJCC 8 requires p16 to choose the chapter; ' +
        'both the p16(+) and the p16(-) classification are reported so they can be compared.',
    ];
  }
  if (p16 === 'positive') {
    return [
      'p16 is recorded as positive but the p16(-) chapter was requested — AJCC 8 would stage this ' +
        'in the HPV-mediated (p16+) oropharynx chapter.',
    ];
  }
  return [];
}

export const oropharynxP16NegRules: SiteRules = {
  site: 'oropharynx_p16neg',
  label: 'Oropharynx, p16-negative',
  stageT,
  stageN,
  stageGroup,
  warnings,
  ruleIds: ['op16neg.T', 'common.N.clinical', 'common.N.pathologic', 'common.group.standard'],
};

export default oropharynxP16NegRules;
