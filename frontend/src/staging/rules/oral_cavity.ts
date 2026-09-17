/**
 * Lip and oral cavity — AJCC 8. rule:oral.T.grid, rule:oral.T.t4a,
 * rule:oral.T.t4b, rule:oral.T.gingival_exception, rule:common.N.*,
 * rule:common.group.standard
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

/** DOI in mm above which the oral cavity T category steps up. */
export const DOI_STEPS_MM = [5, 10] as const;

/**
 * The corrected AJCC 8 size x depth-of-invasion grid (rule:oral.T.grid).
 *
 *   size \ DOI    <= 5 mm    > 5-10 mm   > 10 mm
 *   <= 2 cm       T1         T2          T2
 *   > 2-4 cm      T2         T2          T3
 *   > 4 cm        T3         T3          T4a
 */
export function oralCavityGridCorrected(sizeCm: number, doiMm: number): TCategory {
  if (sizeCm <= 2) return doiMm <= 5 ? 'T1' : 'T2';
  if (sizeCm <= 4) return doiMm <= 10 ? 'T2' : 'T3';
  return doiMm <= 10 ? 'T3' : 'T4a';
}

/**
 * The oral cavity T table as AJCC 8 was originally printed, kept so `stage()`
 * can warn when the two published versions disagree for a given tumour.
 */
export function oralCavityGridOriginal(sizeCm: number, doiMm: number): TCategory {
  if (sizeCm <= 2 && doiMm <= 5) return 'T1';
  if (sizeCm > 4 || doiMm > 10) return 'T3';
  return 'T2';
}

function sizeOnly(sizeCm: number): TCategory {
  if (sizeCm <= 2) return 'T1';
  if (sizeCm <= 4) return 'T2';
  return 'T3';
}

function doiOnly(doiMm: number): TCategory {
  if (doiMm <= 5) return 'T1';
  if (doiMm <= 10) return 'T2';
  return 'T3';
}

export function stageT(
  input: StagingInput,
  context: StagingContext = 'clinical',
): CategoryResult<TCategory> {
  const p = input.primary ?? {};
  const trace: string[] = [];
  const label = context === 'pathologic' ? 'pT' : 'cT';

  const insitu = flag(p.in_situ, context);
  if (insitu) return { category: 'Tis', trace: [say(`${label}is`, 'carcinoma in situ', insitu)] };

  // T4b — very advanced local disease.
  const t4b = firstFlag(
    [
      [p.masticator_space, 'masticator space invasion'],
      [p.pterygoid_plates, 'pterygoid plate invasion'],
      [p.skull_base, 'skull base invasion'],
      [p.carotid_encasement, 'internal carotid artery encasement'],
    ],
    context,
  );
  if (t4b) return { category: 'T4b', trace: [say(`${label}4b`, t4b.phrase, t4b.obs)] };

  // The gingival exception: superficial erosion of bone or a tooth socket alone
  // by a gingival primary is not enough for T4 (rule:oral.T.gingival_exception).
  const superficial = flag(p.gingival_superficial_bone_erosion, context);
  const cortical = flag(p.cortical_bone_invasion, context);
  if (superficial && cortical) {
    trace.push(
      say(
        label,
        'gingival primary with superficial erosion of bone / tooth socket only — AJCC 8 exception, ' +
          'not sufficient for T4',
        superficial,
      ),
    );
  } else if (superficial) {
    trace.push(
      say(
        label,
        'superficial erosion of bone / tooth socket alone by a gingival primary is not T4',
        superficial,
      ),
    );
  }
  const boneCountsForT4 = Boolean(cortical) && !superficial;

  const t4a = firstFlag(
    [
      [boneCountsForT4 ? p.cortical_bone_invasion : undefined, 'invasion through cortical bone (mandible or maxilla)'],
      [p.maxillary_sinus_invasion, 'maxillary sinus invasion'],
      [p.skin_invasion, 'invasion of the skin of the face'],
    ],
    context,
  );
  if (t4a) {
    trace.push(say(`${label}4a`, t4a.phrase, t4a.obs));
    return { category: 'T4a', trace };
  }

  const extrinsic = flag(p.extrinsic_tongue_muscle, context);
  if (extrinsic) {
    trace.push(
      say(
        label,
        'extrinsic tongue muscle infiltration recorded — no longer a T4 criterion in AJCC 8; ' +
          'depth of invasion supersedes it',
        extrinsic,
      ),
    );
  }

  const size = num(p.size_cm, context);
  const doi = num(p.depth_of_invasion_mm, context);

  if (size && doi) {
    const category = oralCavityGridCorrected(size.value, doi.value);
    trace.push(
      say(
        `${label}${category.slice(1)}`,
        `${fmtNum(size.value, 'cm')} greatest dimension with depth of invasion ${fmtNum(doi.value, 'mm')}`,
        size,
      ),
    );
    trace.push(say(`${label}${category.slice(1)}`, `depth of invasion ${fmtNum(doi.value, 'mm')}`, doi));
    return { category, trace };
  }
  if (size) {
    const category = sizeOnly(size.value);
    trace.push(
      say(
        `${label}${category.slice(1)}`,
        `${fmtNum(size.value, 'cm')} greatest dimension; depth of invasion not supplied, so the ` +
          'size-only row of the table was used and the category may be understated',
        size,
      ),
    );
    return { category, trace };
  }
  if (doi) {
    const category = doiOnly(doi.value);
    trace.push(
      say(
        `${label}${category.slice(1)}`,
        `depth of invasion ${fmtNum(doi.value, 'mm')}; greatest dimension not supplied`,
        doi,
      ),
    );
    return { category, trace };
  }
  trace.push(say(`${label}X`, 'neither greatest dimension nor depth of invasion supplied'));
  return { category: 'TX', trace };
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

export function warnings(input: StagingInput): string[] {
  const out: string[] = [];
  const contexts: StagingContext[] = input.contextPathologic
    ? ['clinical', 'pathologic']
    : ['clinical'];
  for (const context of contexts) {
    const size = num(input.primary?.size_cm, context);
    const doi = num(input.primary?.depth_of_invasion_mm, context);
    if (size && doi) {
      const corrected = oralCavityGridCorrected(size.value, doi.value);
      const original = oralCavityGridOriginal(size.value, doi.value);
      if (corrected !== original) {
        out.push(
          `Oral cavity T depends on which printing of AJCC 8 is used: the corrected table gives ` +
            `${corrected}, the original printing gives ${original} for ${fmtNum(size.value, 'cm')} ` +
            `with DOI ${fmtNum(doi.value, 'mm')}. This engine reports the corrected table ` +
            `(rule oral.T.grid, marked 'verify').`,
        );
      }
      if (size.value <= 2 && doi.value > 10) {
        out.push(
          'A tumour <= 2 cm with DOI > 10 mm falls in the one cell where the corrected AJCC 8 ' +
            'oral cavity table is literally T2 but is widely reported as T3. Confirm against the manual.',
        );
      }
    }
    if (doi && doi.source === 'imaging') {
      out.push(
        'Depth of invasion was taken from imaging: imaging DOI overestimates histologic DOI, so ' +
          'the clinical T may be higher than the pathologic T.',
      );
    }
  }
  return out;
}

export const oralCavityRules: SiteRules = {
  site: 'oral_cavity',
  label: 'Lip and oral cavity',
  stageT,
  stageN,
  stageGroup,
  warnings,
  ruleIds: [
    'oral.T.grid',
    'oral.T.t4a',
    'oral.T.t4b',
    'oral.T.gingival_exception',
    'oral.T.extrinsic_muscle',
    'common.N.clinical',
    'common.N.pathologic',
    'common.group.standard',
  ],
};

export default oralCavityRules;
