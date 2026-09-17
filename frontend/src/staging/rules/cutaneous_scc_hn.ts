/**
 * Cutaneous squamous cell carcinoma of the head and neck — AJCC 8 chapter 15.
 * rule:cut.T, rule:cut.T.pni, rule:cut.N, rule:cut.group
 *
 * Primary sites: skin of the lip (including the vermilion), external ear, face,
 * scalp and neck.
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
import { commonN, firstFlag, flag, fmtNum, nRank, num, say } from './common';

/** Nerve calibre at or above which perineural invasion qualifies for T3, mm. */
export const PNI_CALIBRE_MM = 0.1;

/** Tumour thickness above which invasion counts as "deep invasion" for T3, mm. */
export const DEEP_INVASION_MM = 6;

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
      [p.skull_base, 'skull base invasion'],
      [p.skull_base_foramen, 'skull base foramen involvement'],
    ],
    context,
  );
  if (t4b) return { category: 'T4b', trace: [say(`${label}4b`, t4b.phrase, t4b.obs)] };

  const t4a = firstFlag(
    [
      [p.gross_cortical_bone_marrow_invasion, 'gross cortical bone or marrow invasion'],
      [p.cortical_bone_invasion, 'gross cortical bone invasion'],
    ],
    context,
  );
  if (t4a) {
    trace.push(say(`${label}4a`, t4a.phrase, t4a.obs));
    return { category: 'T4a', trace };
  }

  // T3 risk features (rule:cut.T, rule:cut.T.pni).
  const named = flag(p.named_nerve_invasion, context);
  if (named) {
    trace.push(say(`${label}3`, 'perineural invasion of a named nerve', named));
    return { category: 'T3', trace };
  }
  const calibre = num(p.perineural_nerve_calibre_mm, context);
  if (calibre && calibre.value >= PNI_CALIBRE_MM) {
    trace.push(
      say(
        `${label}3`,
        `perineural invasion of a nerve ${fmtNum(calibre.value, 'mm')} in calibre (>= ${PNI_CALIBRE_MM} mm)`,
        calibre,
      ),
    );
    return { category: 'T3', trace };
  }
  const pni = flag(p.perineural_invasion, context);
  if (pni) {
    trace.push(
      say(
        `${label}3`,
        'perineural invasion (nerve deeper than the dermis or >= 0.1 mm in calibre)',
        pni,
      ),
    );
    return { category: 'T3', trace };
  }
  const beyondFat = flag(p.beyond_subcutaneous_fat, context);
  if (beyondFat) {
    trace.push(say(`${label}3`, 'deep invasion — tumour beyond the subcutaneous fat', beyondFat));
    return { category: 'T3', trace };
  }
  const depth = num(p.dermal_invasion_depth_mm, context);
  if (depth && depth.value > DEEP_INVASION_MM) {
    trace.push(
      say(
        `${label}3`,
        `deep invasion — tumour thickness ${fmtNum(depth.value, 'mm')} (> ${DEEP_INVASION_MM} mm)`,
        depth,
      ),
    );
    return { category: 'T3', trace };
  }
  const minorBone = flag(p.minor_bone_erosion, context);
  if (minorBone) {
    trace.push(say(`${label}3`, 'minor (non-cortical) bone erosion', minorBone));
    return { category: 'T3', trace };
  }

  const size = num(p.size_cm, context);
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

/**
 * rule:cut.group
 *   I   T1 N0
 *   II  T2 N0
 *   III T3 N0, or T1-T3 N1
 *   IV  T4 any N, or T1-T3 N2-N3, or M1
 */
export function stageGroup(T: TCategory, N: NCategory, M: MCategory): GroupResult {
  if (M === 'M1') {
    return { group: 'IV', trace: [say('Stage IV', `${T} ${N} M1 — distant metastasis`)] };
  }
  if (T === 'TX' || N === 'NX') {
    return {
      group: 'unknown',
      trace: [say('Stage unknown', `${T} ${N} ${M} — a category could not be assigned`)],
    };
  }
  const n = nRank(N);
  if (T === 'T4a' || T === 'T4b' || T === 'T4' || n >= 2) {
    return { group: 'IV', trace: [say('Stage IV', `${T} ${N} M0 — T4, or N2 or higher`)] };
  }
  if (n === 1 || T === 'T3') {
    return { group: 'III', trace: [say('Stage III', `${T} ${N} M0 — T3 N0, or N1 with T1-T3`)] };
  }
  if (T === 'T2') return { group: 'II', trace: [say('Stage II', 'T2 N0 M0')] };
  if (T === 'Tis') return { group: '0', trace: [say('Stage 0', 'Tis N0 M0')] };
  return { group: 'I', trace: [say('Stage I', `${T} N0 M0`)] };
}

export const cutaneousSccHnRules: SiteRules = {
  site: 'cutaneous_scc_hn',
  label: 'Cutaneous squamous cell carcinoma of the head and neck',
  stageT,
  stageN,
  stageGroup,
  ruleIds: ['cut.T', 'cut.T.pni', 'cut.N', 'cut.group'],
};

export default cutaneousSccHnRules;
