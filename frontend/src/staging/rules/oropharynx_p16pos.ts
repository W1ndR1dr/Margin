/**
 * HPV-mediated (p16-positive) oropharyngeal carcinoma — AJCC 8 chapter 10.
 * rule:op16.T, rule:op16.N.clinical, rule:op16.N.pathologic,
 * rule:op16.group.clinical, rule:op16.group.pathologic
 *
 * This chapter has no Tis and no T4b, and ENE plays no part in N.
 */

import type {
  CategoryResult,
  GroupResult,
  MCategory,
  NCategory,
  PatientInput,
  SiteRules,
  StagingContext,
  StagingInput,
  TCategory,
} from '../types';
import { firstFlag, flag, fmtNum, nRank, num, p16OropharynxN, say, tRank } from './common';

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
        say(`${label}0`, 'no primary identified; p16(+) node assigns this chapter', none),
      ],
    };
  }

  // T4 — moderately advanced local disease. There is no T4a/T4b split here, so
  // the very-advanced descriptors of the p16- chapter also land in T4.
  const t4 = firstFlag(
    [
      [p.larynx_invasion, 'invasion of the larynx'],
      [p.extrinsic_tongue_muscle, 'extrinsic tongue muscle invasion'],
      [p.medial_pterygoid_muscle, 'medial pterygoid muscle invasion'],
      [p.hard_palate, 'hard palate invasion'],
      [p.mandible_invasion, 'mandible invasion'],
      [p.lateral_pterygoid_muscle, 'lateral pterygoid muscle invasion (beyond T4 structures)'],
      [p.pterygoid_plates, 'pterygoid plate invasion (beyond T4 structures)'],
      [p.lateral_nasopharynx, 'lateral nasopharyngeal invasion (beyond T4 structures)'],
      [p.skull_base, 'skull base invasion (beyond T4 structures)'],
      [p.carotid_encasement, 'carotid encasement (beyond T4 structures)'],
    ],
    context,
  );
  if (t4) {
    trace.push(say(`${label}4`, `${t4.phrase}; this chapter has no T4b`, t4.obs));
    return { category: 'T4', trace };
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
  return p16OropharynxN(input, context);
}

/**
 * Clinical (rule:op16.group.clinical):
 *   I   T0-T2 N0-N1
 *   II  T0-T2 N2, or T3 N0-N2
 *   III T4 any N, or any T N3
 *   IV  M1
 *
 * Pathologic (rule:op16.group.pathologic):
 *   I   T0-T2 N0-N1
 *   II  T0-T2 N2, or T3-T4 N0-N1
 *   III T3-T4 N2
 *   IV  M1
 */
export function stageGroup(
  T: TCategory,
  N: NCategory,
  M: MCategory,
  _patient?: PatientInput,
  context: StagingContext = 'clinical',
): GroupResult {
  if (M === 'M1') {
    return { group: 'IV', trace: [say('Stage IV', `${T} ${N} M1 — distant metastasis`)] };
  }
  if (T === 'TX' || N === 'NX') {
    return {
      group: 'unknown',
      trace: [say('Stage unknown', `${T} ${N} ${M} — a category could not be assigned`)],
    };
  }
  const t = tRank(T);
  const n = nRank(N);

  if (context === 'pathologic') {
    if (t >= 3 && n === 2) {
      return { group: 'III', trace: [say('Stage III (pathologic)', `${T} ${N} M0 — T3-T4 with pN2`)] };
    }
    if (t >= 3) {
      return {
        group: 'II',
        trace: [say('Stage II (pathologic)', `${T} ${N} M0 — T3-T4 with pN0-pN1`)],
      };
    }
    if (n === 2) {
      return {
        group: 'II',
        trace: [say('Stage II (pathologic)', `${T} ${N} M0 — T0-T2 with pN2`)],
      };
    }
    return { group: 'I', trace: [say('Stage I (pathologic)', `${T} ${N} M0 — T0-T2 with pN0-pN1`)] };
  }

  if (T === 'T4' || n === 3) {
    return { group: 'III', trace: [say('Stage III', `${T} ${N} M0 — T4 or N3`)] };
  }
  if (t === 3 || n === 2) {
    return { group: 'II', trace: [say('Stage II', `${T} ${N} M0 — T3 with N0-N2, or T0-T2 with N2`)] };
  }
  return { group: 'I', trace: [say('Stage I', `${T} ${N} M0 — T0-T2 with N0-N1`)] };
}

export function warnings(input: StagingInput): string[] {
  const out: string[] = [];
  const p16 = input.patient?.p16;
  if (!p16 || p16 === 'unknown') {
    out.push(
      'p16 result missing for an oropharyngeal primary. AJCC 8 requires p16 to choose the chapter; ' +
        'both the p16(+) and the p16(-) classification are reported so they can be compared.',
    );
  } else if (p16 === 'negative') {
    out.push(
      'p16 is recorded as negative but the p16(+) chapter was requested. AJCC 8 is absolute that ' +
        'p16 must be positive to use the HPV-mediated chapter.',
    );
  }
  if (input.patient?.hpv === 'negative' && p16 === 'positive') {
    out.push(
      'p16(+) with HPV testing negative: AJCC 8 states p16 is the decider, so the HPV-mediated ' +
        'chapter still applies.',
    );
  }
  return out;
}

export const oropharynxP16PosRules: SiteRules = {
  site: 'oropharynx_p16pos',
  label: 'Oropharynx, HPV-mediated (p16+)',
  stageT,
  stageN,
  stageGroup,
  warnings,
  ruleIds: ['op16.T', 'op16.N.clinical', 'op16.N.pathologic', 'op16.group.clinical', 'op16.group.pathologic'],
};

export default oropharynxP16PosRules;
