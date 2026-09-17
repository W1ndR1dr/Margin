/**
 * Hypopharynx — AJCC 8 chapter 11 (shared with p16-negative oropharynx).
 * rule:hypo.T, rule:common.N.*, rule:common.group.standard
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
      [p.prevertebral_fascia_invasion, 'prevertebral fascia invasion'],
      [p.carotid_encasement, 'carotid artery encasement'],
      [p.mediastinal_structures, 'mediastinal structure involvement'],
    ],
    context,
  );
  if (t4b) return { category: 'T4b', trace: [say(`${label}4b`, t4b.phrase, t4b.obs)] };

  const t4a = firstFlag(
    [
      [p.thyroid_cartilage_through, 'thyroid cartilage invasion'],
      [p.cricoid_invasion, 'cricoid cartilage invasion'],
      [p.hyoid_invasion, 'hyoid bone invasion'],
      [p.thyroid_gland_invasion, 'thyroid gland invasion'],
      [p.esophagus_invasion, 'oesophageal muscle invasion'],
      [p.central_compartment_soft_tissue, 'central compartment soft tissue invasion (strap muscles / subcutaneous fat)'],
      [p.strap_muscle_invasion, 'prelaryngeal strap muscle invasion (central compartment soft tissue)'],
    ],
    context,
  );
  if (t4a) {
    trace.push(say(`${label}4a`, t4a.phrase, t4a.obs));
    return { category: 'T4a', trace };
  }

  // AJCC 8 uses fixation of hemilarynx here; vocal cord fixation is accepted as
  // a stand-in when that is the only descriptor recorded.
  const fixation =
    flag(p.hemilarynx_fixation, context) ?? flag(p.vocal_cord_fixation, context);
  const esophMucosa = flag(p.esophageal_mucosa_extension, context);
  const size = num(p.size_cm, context);
  const subsites = num(p.subsite_count, context);
  const adjacent = flag(p.adjacent_site_extension, context);

  if (fixation) {
    trace.push(say(`${label}3`, 'fixation of hemilarynx', fixation));
    return { category: 'T3', trace };
  }
  if (esophMucosa) {
    trace.push(say(`${label}3`, 'extension to oesophageal mucosa', esophMucosa));
    return { category: 'T3', trace };
  }
  if (size && size.value > 4) {
    trace.push(say(`${label}3`, `${fmtNum(size.value, 'cm')} greatest dimension (> 4 cm)`, size));
    return { category: 'T3', trace };
  }
  if (size && size.value > 2) {
    trace.push(
      say(`${label}2`, `${fmtNum(size.value, 'cm')} greatest dimension (> 2 cm, <= 4 cm) without hemilarynx fixation`, size),
    );
    return { category: 'T2', trace };
  }
  if (subsites && subsites.value > 1) {
    trace.push(
      say(`${label}2`, `${subsites.value} hypopharyngeal subsites involved without hemilarynx fixation`, subsites),
    );
    return { category: 'T2', trace };
  }
  if (adjacent) {
    trace.push(say(`${label}2`, 'extension to an adjacent site without hemilarynx fixation', adjacent));
    return { category: 'T2', trace };
  }
  if (size) {
    trace.push(
      say(`${label}1`, `limited to one subsite and ${fmtNum(size.value, 'cm')} (<= 2 cm)`, size),
    );
    return { category: 'T1', trace };
  }
  if (subsites && subsites.value === 1) {
    trace.push(say(`${label}1`, 'limited to one hypopharyngeal subsite', subsites));
    return { category: 'T1', trace };
  }
  return { category: 'TX', trace: [say(`${label}X`, 'no hypopharyngeal T descriptors supplied')] };
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

export const hypopharynxRules: SiteRules = {
  site: 'hypopharynx',
  label: 'Hypopharynx',
  stageT,
  stageN,
  stageGroup,
  ruleIds: ['hypo.T', 'common.N.clinical', 'common.N.pathologic', 'common.group.standard'],
};

export default hypopharynxRules;
