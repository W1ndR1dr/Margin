/**
 * Cervical lymph nodes and unknown primary tumours of the head and neck —
 * AJCC 8 chapter 6. rule:unk.T, rule:common.N.*, rule:unk.group
 *
 * This chapter is used when neck nodes are involved, no primary is identified,
 * and the tumour is neither EBV-related nor HPV-related. p16 and EBER decide:
 * p16(+) is staged as T0 in the HPV-mediated oropharynx chapter, EBER(+) as T0
 * in the nasopharynx chapter. A physician's assumption about the likely primary
 * site does NOT choose the chapter.
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
import { commonN, nRank, say } from './common';

export function stageT(
  _input: StagingInput,
  context: StagingContext = 'clinical',
): CategoryResult<TCategory> {
  const label = context === 'pathologic' ? 'pT' : 'cT';
  return {
    category: 'T0',
    trace: [
      say(
        `${label}0`,
        'no primary identified; the cervical nodes chapter assigns T0 and the primary site may not be presumed',
      ),
    ],
  };
}

export function stageN(
  input: StagingInput,
  context: StagingContext = 'clinical',
): CategoryResult<NCategory> {
  return commonN(input, context);
}

/** rule:unk.group — III T0 N1; IVA T0 N2; IVB T0 N3; IVC M1. */
export function stageGroup(T: TCategory, N: NCategory, M: MCategory): GroupResult {
  if (M === 'M1') {
    return { group: 'IVC', trace: [say('Stage IVC', `${T} ${N} M1 — distant metastasis`)] };
  }
  if (N === 'NX') {
    return {
      group: 'unknown',
      trace: [say('Stage unknown', `${T} ${N} ${M} — the N category could not be assigned`)],
    };
  }
  const n = nRank(N);
  if (n === 3) return { group: 'IVB', trace: [say('Stage IVB', `T0 ${N} M0`)] };
  if (n === 2) return { group: 'IVA', trace: [say('Stage IVA', `T0 ${N} M0`)] };
  if (n === 1) return { group: 'III', trace: [say('Stage III', `T0 ${N} M0`)] };
  return {
    group: 'unknown',
    trace: [
      say(
        'Stage unknown',
        'T0 N0 — this chapter requires nodal involvement; with no involved node there is nothing to stage here',
      ),
    ],
  };
}

export function warnings(input: StagingInput): string[] {
  const out: string[] = [];
  const p16 = input.patient?.p16;
  const ebv = input.patient?.ebv;
  if (!p16 || p16 === 'unknown') {
    out.push(
      'p16 status missing. AJCC 8 requires p16 (and EBER) before the cervical nodes chapter can be ' +
        'used: a p16(+) node is staged as T0 in the HPV-mediated oropharynx chapter instead.',
    );
  } else if (p16 === 'positive') {
    out.push(
      'p16 is positive, so AJCC 8 stages this as T0 in the HPV-mediated (p16+) oropharynx chapter, ' +
        'not in the cervical nodes chapter.',
    );
  }
  if (!ebv || ebv === 'unknown') {
    out.push(
      'EBER status missing. An EBER(+) node is staged as T0 in the nasopharynx chapter, not here.',
    );
  } else if (ebv === 'positive') {
    out.push('EBER is positive, so AJCC 8 stages this as T0 in the nasopharynx chapter.');
  }
  return out;
}

export const unknownPrimaryRules: SiteRules = {
  site: 'unknown_primary',
  label: 'Cervical nodes with unknown head & neck primary',
  stageT,
  stageN,
  stageGroup,
  warnings,
  ruleIds: ['unk.T', 'common.N.clinical', 'common.N.pathologic', 'unk.group'],
};

export default unknownPrimaryRules;
