/**
 * Major salivary glands — AJCC 8. rule:sal.T, rule:common.N.*,
 * rule:common.group.standard
 *
 * Extraparenchymal extension means clinical or macroscopic soft-tissue
 * invasion; microscopic evidence alone does not count for classification.
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

  const none = flag(p.no_primary_identified, context);
  if (none) {
    return {
      category: 'T0',
      trace: [
        say(`${label}0`, 'no primary identified; salivary histology in a node assigns this chapter', none),
      ],
    };
  }
  const insitu = flag(p.in_situ, context);
  if (insitu) return { category: 'Tis', trace: [say(`${label}is`, 'carcinoma in situ', insitu)] };

  const t4b = firstFlag(
    [
      [p.skull_base, 'skull base invasion'],
      [p.pterygoid_plates, 'pterygoid plate invasion'],
      [p.carotid_encasement, 'carotid artery encasement'],
    ],
    context,
  );
  if (t4b) return { category: 'T4b', trace: [say(`${label}4b`, t4b.phrase, t4b.obs)] };

  const t4a = firstFlag(
    [
      [p.skin_invasion, 'skin invasion'],
      [p.mandible_invasion, 'mandible invasion'],
      [p.ear_canal, 'external auditory canal invasion'],
      [p.facial_nerve, 'facial nerve invasion'],
    ],
    context,
  );
  if (t4a) {
    trace.push(say(`${label}4a`, t4a.phrase, t4a.obs));
    return { category: 'T4a', trace };
  }

  const epe = flag(p.extraparenchymal_extension, context);
  const size = num(p.size_cm, context);
  if (epe) {
    trace.push(
      say(
        `${label}3`,
        'extraparenchymal extension (clinical or macroscopic soft-tissue invasion; microscopic alone would not count)',
        epe,
      ),
    );
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
    trace.push(
      say(`${label}2`, `${fmtNum(cm, 'cm')} greatest dimension (> 2 cm, <= 4 cm) without extraparenchymal extension`, size),
    );
    return { category: 'T2', trace };
  }
  trace.push(
    say(`${label}1`, `${fmtNum(cm, 'cm')} greatest dimension (<= 2 cm) without extraparenchymal extension`, size),
  );
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

export const majorSalivaryRules: SiteRules = {
  site: 'major_salivary',
  label: 'Major salivary glands',
  stageT,
  stageN,
  stageGroup,
  ruleIds: ['sal.T', 'common.N.clinical', 'common.N.pathologic', 'common.group.standard'],
};

export default majorSalivaryRules;
