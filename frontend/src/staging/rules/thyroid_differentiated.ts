/**
 * Thyroid, differentiated (papillary, follicular, oncocytic/Hurthle cell,
 * poorly differentiated) — AJCC 8. rule:thy.T, rule:thy.N, rule:thy.group.diff
 *
 * The T and N tables here are shared by all three thyroid histologies in AJCC 8
 * (including anaplastic, which no longer forces T4); only the stage groups
 * differ, so `thyroid_medullary.ts` and `thyroid_anaplastic.ts` import
 * `thyroidT` and `stageN` from this module.
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
import { firstFlag, flag, fmtNum, num, say, thyroidN } from './common';

/** The thyroid age cut-off changed from 45 to 55 years in AJCC 8. */
export const THYROID_AGE_CUTOFF = 55;

/** Shared thyroid T table (rule:thy.T). */
export function thyroidT(
  input: StagingInput,
  context: StagingContext = 'clinical',
): CategoryResult<TCategory> {
  const p = input.primary ?? {};
  const label = context === 'pathologic' ? 'pT' : 'cT';
  const trace: string[] = [];

  const t4b = firstFlag(
    [
      [p.prevertebral_fascia_invasion, 'gross extrathyroidal extension into the prevertebral fascia'],
      [p.carotid_encasement, 'carotid artery encasement'],
      [p.mediastinal_vessel_encasement, 'mediastinal vessel encasement'],
      [p.mediastinal_structures, 'mediastinal vessel involvement'],
    ],
    context,
  );
  if (t4b) return { category: 'T4b', trace: [say(`${label}4b`, t4b.phrase, t4b.obs)] };

  const t4a = firstFlag(
    [
      [p.larynx_trachea_rln_invasion, 'gross extrathyroidal extension into larynx, trachea, oesophagus or recurrent laryngeal nerve'],
      [p.subcutaneous_soft_tissue_invasion, 'gross extrathyroidal extension into subcutaneous soft tissue'],
      [p.larynx_invasion, 'gross extrathyroidal extension into the larynx'],
      [p.trachea_invasion, 'gross extrathyroidal extension into the trachea'],
      [p.esophagus_invasion, 'gross extrathyroidal extension into the oesophagus'],
    ],
    context,
  );
  if (t4a) {
    trace.push(say(`${label}4a`, t4a.phrase, t4a.obs));
    return { category: 'T4a', trace };
  }

  const strap = flag(p.strap_muscle_invasion, context);
  if (strap) {
    trace.push(
      say(`${label}3b`, 'gross extrathyroidal extension into strap muscles only, any tumour size', strap),
    );
    return { category: 'T3b', trace };
  }

  const size = num(p.size_cm, context);
  if (!size) {
    return { category: 'TX', trace: [say(`${label}X`, 'greatest dimension not supplied')] };
  }
  const cm = size.value;
  if (cm > 4) {
    trace.push(say(`${label}3a`, `${fmtNum(cm, 'cm')} (> 4 cm), limited to the thyroid`, size));
    return { category: 'T3a', trace };
  }
  if (cm > 2) {
    trace.push(say(`${label}2`, `${fmtNum(cm, 'cm')} (> 2 cm, <= 4 cm), limited to the thyroid`, size));
    return { category: 'T2', trace };
  }
  if (cm > 1) {
    trace.push(say(`${label}1b`, `${fmtNum(cm, 'cm')} (> 1 cm, <= 2 cm), limited to the thyroid`, size));
    return { category: 'T1b', trace };
  }
  trace.push(say(`${label}1a`, `${fmtNum(cm, 'cm')} (<= 1 cm), limited to the thyroid`, size));
  return { category: 'T1a', trace };
}

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
 * rule:thy.group.diff
 *   age < 55:  I any T any N M0; II any T any N M1
 *   age >= 55: I T1-T2 N0/NX; II T1-T2 N1 or T3a/T3b any N; III T4a any N;
 *              IVA T4b any N; IVB M1
 */
export function stageGroup(
  T: TCategory,
  N: NCategory,
  M: MCategory,
  patient?: PatientInput,
): GroupResult {
  const age = patient?.age;
  if (typeof age !== 'number') {
    return {
      group: 'unknown',
      trace: [
        say(
          'Stage unknown',
          `${T} ${N} ${M} — differentiated thyroid stage groups need the age at diagnosis (cut-off ${THYROID_AGE_CUTOFF} years)`,
        ),
      ],
    };
  }
  if (age < THYROID_AGE_CUTOFF) {
    if (M === 'M1') {
      return {
        group: 'II',
        trace: [say('Stage II', `age ${age} (< ${THYROID_AGE_CUTOFF}) with M1 — any T, any N`)],
      };
    }
    return {
      group: 'I',
      trace: [say('Stage I', `age ${age} (< ${THYROID_AGE_CUTOFF}) with M0 — any T, any N`)],
    };
  }
  if (M === 'M1') {
    return {
      group: 'IVB',
      trace: [say('Stage IVB', `age ${age} (>= ${THYROID_AGE_CUTOFF}) with M1`)],
    };
  }
  if (T === 'TX') {
    return { group: 'unknown', trace: [say('Stage unknown', `${T} ${N} ${M} — T not assignable`)] };
  }
  if (T === 'T4b') {
    return { group: 'IVA', trace: [say('Stage IVA', `T4b ${N} M0, age ${age}`)] };
  }
  if (T === 'T4a') {
    return { group: 'III', trace: [say('Stage III', `T4a ${N} M0, age ${age}`)] };
  }
  if (T === 'T3a' || T === 'T3b' || T === 'T3') {
    return { group: 'II', trace: [say('Stage II', `${T} ${N} M0, age ${age} — T3a or T3b, any N`)] };
  }
  if (N === 'N0' || N === 'NX') {
    return { group: 'I', trace: [say('Stage I', `${T} ${N} M0, age ${age} — T1-T2 with N0/NX`)] };
  }
  return { group: 'II', trace: [say('Stage II', `${T} ${N} M0, age ${age} — T1-T2 with N1`)] };
}

export function warnings(input: StagingInput): string[] {
  if (typeof input.patient?.age !== 'number') {
    return [
      `Age at diagnosis missing. Differentiated thyroid carcinoma stage groups depend on the ` +
        `${THYROID_AGE_CUTOFF}-year cut-off, so no stage group can be assigned.`,
    ];
  }
  return [];
}

export const thyroidDifferentiatedRules: SiteRules = {
  site: 'thyroid_differentiated',
  label: 'Thyroid, differentiated',
  stageT,
  stageN,
  stageGroup,
  warnings,
  ruleIds: ['thy.T', 'thy.N', 'thy.group.diff'],
};

export default thyroidDifferentiatedRules;
