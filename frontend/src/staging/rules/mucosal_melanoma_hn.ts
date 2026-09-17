/**
 * Mucosal melanoma of the head and neck — AJCC 8. rule:mm.T, rule:mm.N,
 * rule:mm.group
 *
 * This is the one head & neck chapter whose staging begins at T3: mucosal
 * melanoma is aggressive enough that there is no T1 or T2, and no stage I or
 * stage II. Tumour thickness and greatest dimension are not used.
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
import { firstFlag, flag, mucosalMelanomaN, say } from './common';

export function stageT(
  input: StagingInput,
  context: StagingContext = 'clinical',
): CategoryResult<TCategory> {
  const p = input.primary ?? {};
  const label = context === 'pathologic' ? 'pT' : 'cT';
  const trace: string[] = [];

  const t4b = firstFlag(
    [
      [p.brain, 'brain invasion'],
      [p.dura, 'dural invasion'],
      [p.skull_base, 'skull base invasion'],
      [p.lower_cranial_nerves, 'lower cranial nerve (IX, X, XI, XII) involvement'],
      [p.masticator_space, 'masticator space invasion'],
      [p.carotid_encasement, 'carotid artery involvement'],
      [p.prevertebral_space, 'prevertebral space invasion'],
      [p.prevertebral_fascia_invasion, 'prevertebral space invasion'],
      [p.mediastinal_structures, 'mediastinal structure involvement'],
    ],
    context,
  );
  if (t4b) {
    trace.push(say(`${label}4b`, `${t4b.phrase} — very advanced disease`, t4b.obs));
    return { category: 'T4b', trace };
  }

  const t4a = firstFlag(
    [
      [p.deep_soft_tissue, 'deep soft tissue invasion'],
      [p.cartilage_invasion, 'cartilage invasion'],
      [p.bone_invasion, 'bone invasion'],
      [p.cortical_bone_invasion, 'bone invasion'],
      [p.overlying_skin, 'invasion of the overlying skin'],
      [p.skin_invasion, 'invasion of the overlying skin'],
    ],
    context,
  );
  if (t4a) {
    trace.push(say(`${label}4a`, `${t4a.phrase} — moderately advanced disease`, t4a.obs));
    return { category: 'T4a', trace };
  }

  const mucosaOnly =
    flag(p.mucosa_and_underlying_soft_tissue_only, context) ?? flag(p.mucosa_only, context);
  if (mucosaOnly) {
    trace.push(
      say(
        `${label}3`,
        'limited to the mucosa and immediately underlying soft tissue, regardless of thickness or greatest dimension',
        mucosaOnly,
      ),
    );
    return { category: 'T3', trace };
  }
  return {
    category: 'TX',
    trace: [
      say(
        `${label}X`,
        'mucosal melanoma T needs either "mucosa and underlying soft tissue only" or a deep-invasion descriptor; staging starts at T3',
      ),
    ],
  };
}

export function stageN(
  input: StagingInput,
  context: StagingContext = 'clinical',
): CategoryResult<NCategory> {
  return mucosalMelanomaN(input, context);
}

/** rule:mm.group — III T3 N0; IVA T4a N0 or T3-T4a N1; IVB T4b any N; IVC M1. */
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
  if (T === 'T4b') return { group: 'IVB', trace: [say('Stage IVB', `T4b ${N} M0`)] };
  if (T === 'T4a' || N === 'N1') {
    return {
      group: 'IVA',
      trace: [say('Stage IVA', `${T} ${N} M0 — T4a N0, or T3-T4a with N1`)],
    };
  }
  return { group: 'III', trace: [say('Stage III', 'T3 N0 M0 — staging for this site begins at III')] };
}

export const mucosalMelanomaHnRules: SiteRules = {
  site: 'mucosal_melanoma_hn',
  label: 'Mucosal melanoma of the head and neck',
  stageT,
  stageN,
  stageGroup,
  ruleIds: ['mm.T', 'mm.N', 'mm.group'],
};

export default mucosalMelanomaHnRules;
