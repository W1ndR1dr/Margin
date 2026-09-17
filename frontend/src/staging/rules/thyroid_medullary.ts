/**
 * Thyroid, medullary carcinoma — AJCC 8. Same T and N tables as the
 * differentiated chapter, different stage groups, and no age cut-off.
 * rule:thy.T, rule:thy.N, rule:thy.group.medullary
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
import { say, tRank, thyroidN } from './common';
import { thyroidT } from './thyroid_differentiated';

export function stageT(
  input: StagingInput,
  context: StagingContext = 'clinical',
): CategoryResult<TCategory> {
  return thyroidT(input, context);
}

export function stageN(
  input: StagingInput,
  context: StagingContext = 'clinical',
): CategoryResult<NCategory> {
  return thyroidN(input, context);
}

/**
 * rule:thy.group.medullary
 *   I   T1 N0
 *   II  T2-T3 N0
 *   III T1-T3 N1a
 *   IVA T4a any N, or T1-T3 N1b
 *   IVB T4b any N
 *   IVC M1
 */
export function stageGroup(T: TCategory, N: NCategory, M: MCategory): GroupResult {
  if (M === 'M1') {
    return { group: 'IVC', trace: [say('Stage IVC', `${T} ${N} M1 — distant metastasis`)] };
  }
  if (T === 'TX' || N === 'NX') {
    return {
      group: 'unknown',
      trace: [say('Stage unknown', `${T} ${N} ${M} — a category could not be assigned`)],
    };
  }
  if (T === 'T4b') {
    return { group: 'IVB', trace: [say('Stage IVB', `T4b ${N} M0`)] };
  }
  if (T === 'T4a') {
    return { group: 'IVA', trace: [say('Stage IVA', `T4a ${N} M0`)] };
  }
  if (N === 'N1b' || N === 'N1') {
    const why = N === 'N1b' ? 'lateral neck nodes' : 'nodal compartment not specified, treated as N1b';
    return { group: 'IVA', trace: [say('Stage IVA', `${T} ${N} M0 — ${why}`)] };
  }
  if (N === 'N1a') {
    return { group: 'III', trace: [say('Stage III', `${T} N1a M0 — central compartment nodes`)] };
  }
  if (tRank(T) >= 2) {
    return { group: 'II', trace: [say('Stage II', `${T} N0 M0 — T2 or T3`)] };
  }
  return { group: 'I', trace: [say('Stage I', `${T} N0 M0`)] };
}

export const thyroidMedullaryRules: SiteRules = {
  site: 'thyroid_medullary',
  label: 'Thyroid, medullary',
  stageT,
  stageN,
  stageGroup,
  ruleIds: ['thy.T', 'thy.N', 'thy.group.medullary'],
};

export default thyroidMedullaryRules;
