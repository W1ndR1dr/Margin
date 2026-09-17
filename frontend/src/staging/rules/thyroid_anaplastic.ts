/**
 * Thyroid, anaplastic carcinoma — AJCC 8. rule:thy.T, rule:thy.N,
 * rule:thy.group.anaplastic
 *
 * AJCC 8 changed anaplastic staging in two ways: it no longer forces every
 * tumour to T4 (the differentiated T definitions are used instead), and the
 * stage groups now separate IVA from IVB. Every anaplastic carcinoma is still
 * stage IV.
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
import { say, thyroidN } from './common';
import { thyroidT } from './thyroid_differentiated';

export function stageT(
  input: StagingInput,
  context: StagingContext = 'clinical',
): CategoryResult<TCategory> {
  const result = thyroidT(input, context);
  return {
    category: result.category,
    trace: [
      ...result.trace,
      say(
        result.category,
        'anaplastic carcinoma uses the same T definitions as differentiated thyroid carcinoma in AJCC 8 (it is no longer automatically T4)',
      ),
    ],
  };
}

export function stageN(
  input: StagingInput,
  context: StagingContext = 'clinical',
): CategoryResult<NCategory> {
  return thyroidN(input, context);
}

/**
 * rule:thy.group.anaplastic
 *   IVA T1-T3a N0/NX
 *   IVB T1-T3a N1, or T3b any N, or T4a/T4b any N
 *   IVC M1
 */
export function stageGroup(T: TCategory, N: NCategory, M: MCategory): GroupResult {
  if (M === 'M1') {
    return { group: 'IVC', trace: [say('Stage IVC', `${T} ${N} M1 — anaplastic carcinoma with distant metastasis`)] };
  }
  if (T === 'TX') {
    return { group: 'unknown', trace: [say('Stage unknown', `${T} ${N} ${M} — T not assignable`)] };
  }
  if (T === 'T3b' || T === 'T4' || T === 'T4a' || T === 'T4b') {
    return {
      group: 'IVB',
      trace: [say('Stage IVB', `${T} ${N} M0 — gross extrathyroidal extension beyond the thyroid`)],
    };
  }
  if (N === 'N0' || N === 'NX') {
    return {
      group: 'IVA',
      trace: [say('Stage IVA', `${T} ${N} M0 — T1-T3a confined to the thyroid, node-negative`)],
    };
  }
  return { group: 'IVB', trace: [say('Stage IVB', `${T} ${N} M0 — T1-T3a with nodal metastasis`)] };
}

export const thyroidAnaplasticRules: SiteRules = {
  site: 'thyroid_anaplastic',
  label: 'Thyroid, anaplastic',
  stageT,
  stageN,
  stageGroup,
  ruleIds: ['thy.T', 'thy.N', 'thy.group.anaplastic'],
};

export default thyroidAnaplasticRules;
