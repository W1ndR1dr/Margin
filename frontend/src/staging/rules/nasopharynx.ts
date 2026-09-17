/**
 * Nasopharynx — AJCC 8. rule:npx.T, rule:npx.N, rule:npx.group
 *
 * ENE is not part of the nasopharyngeal N category.
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
import { firstFlag, flag, nRank, nasopharynxN, negated, num, say, tRank } from './common';

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
      trace: [say(`${label}0`, 'no primary identified; EBV(+) cervical node assigns this chapter', none)],
    };
  }
  const insitu = flag(p.in_situ, context);
  if (insitu) return { category: 'Tis', trace: [say(`${label}is`, 'carcinoma in situ', insitu)] };

  const t4 = firstFlag(
    [
      [p.intracranial_extension, 'intracranial extension'],
      [p.cranial_nerve_involvement, 'cranial nerve involvement'],
      [p.hypopharynx_involvement, 'hypopharyngeal involvement'],
      [p.orbit, 'orbital involvement'],
      [p.parotid_gland, 'parotid gland involvement'],
      [p.beyond_lateral_pterygoid, 'soft tissue infiltration beyond the lateral surface of the lateral pterygoid muscle'],
    ],
    context,
  );
  if (t4) {
    trace.push(say(`${label}4`, t4.phrase, t4.obs));
    return { category: 'T4', trace };
  }

  const t3 = firstFlag(
    [
      [p.bony_skull_base, 'invasion of bony structures at the skull base'],
      [p.cervical_vertebra, 'cervical vertebra invasion'],
      [p.pterygoid_structures, 'pterygoid structure invasion'],
      [p.paranasal_sinus_involvement, 'paranasal sinus involvement'],
      [p.clivus, 'clival invasion (bony skull base)'],
    ],
    context,
  );
  if (t3) {
    trace.push(say(`${label}3`, t3.phrase, t3.obs));
    return { category: 'T3', trace };
  }

  const t2 = firstFlag(
    [
      [p.parapharyngeal_space, 'parapharyngeal space extension'],
      [p.medial_pterygoid_muscle, 'medial pterygoid muscle involvement (adjacent soft tissue)'],
      [p.lateral_pterygoid_muscle, 'lateral pterygoid muscle involvement (adjacent soft tissue)'],
      [p.prevertebral_muscle, 'prevertebral muscle involvement (adjacent soft tissue)'],
    ],
    context,
  );
  if (t2) {
    trace.push(say(`${label}2`, t2.phrase, t2.obs));
    return { category: 'T2', trace };
  }

  const size = num(p.size_cm, context);
  const mucosaOnly = flag(p.mucosa_only, context);
  if (mucosaOnly || size || negated(p.parapharyngeal_space, context)) {
    trace.push(
      say(
        `${label}1`,
        'confined to the nasopharynx, or extension to the oropharynx and/or nasal cavity, without parapharyngeal involvement',
        mucosaOnly ?? size,
      ),
    );
    return { category: 'T1', trace };
  }
  return {
    category: 'TX',
    trace: [say(`${label}X`, 'no nasopharyngeal T descriptors supplied')],
  };
}

export function stageN(
  input: StagingInput,
  context: StagingContext = 'clinical',
): CategoryResult<NCategory> {
  return nasopharynxN(input, context);
}

/**
 * rule:npx.group
 *   0    Tis N0
 *   I    T1 N0
 *   II   T0-T1 N1, or T2 N0-N1
 *   III  T0-T2 N2, or T3 N0-N2
 *   IVA  T4 N0-N2, or any T N3
 *   IVB  M1
 */
export function stageGroup(T: TCategory, N: NCategory, M: MCategory): GroupResult {
  if (M === 'M1') {
    return { group: 'IVB', trace: [say('Stage IVB', `${T} ${N} M1 — distant metastasis`)] };
  }
  if (T === 'TX' || N === 'NX') {
    return {
      group: 'unknown',
      trace: [say('Stage unknown', `${T} ${N} ${M} — a category could not be assigned`)],
    };
  }
  const t = tRank(T);
  const n = nRank(N);
  if (T === 'T4' || n === 3) {
    return { group: 'IVA', trace: [say('Stage IVA', `${T} ${N} M0 — T4 or N3`)] };
  }
  if (t === 3 || n === 2) {
    return { group: 'III', trace: [say('Stage III', `${T} ${N} M0 — T3 with N0-N2, or N2 with T0-T2`)] };
  }
  if (t === 2 || n === 1) {
    return { group: 'II', trace: [say('Stage II', `${T} ${N} M0 — T2 with N0-N1, or N1 with T0-T1`)] };
  }
  if (T === 'Tis') {
    return { group: '0', trace: [say('Stage 0', 'Tis N0 M0 — carcinoma in situ')] };
  }
  return { group: 'I', trace: [say('Stage I', `${T} N0 M0`)] };
}

export const nasopharynxRules: SiteRules = {
  site: 'nasopharynx',
  label: 'Nasopharynx',
  stageT,
  stageN,
  stageGroup,
  ruleIds: ['npx.T', 'npx.N', 'npx.group'],
};

export default nasopharynxRules;
