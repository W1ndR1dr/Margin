/**
 * Nasal cavity and paranasal sinuses — AJCC 8. Two T tables live in this
 * chapter: maxillary sinus, and nasal cavity / ethmoid sinus. Set
 * `primary.sinonasal_subsite` to pick one; without it the nasal cavity /
 * ethmoid table is used and a warning is raised.
 *
 * rule:sinus.maxillary.T, rule:sinus.nasoethmoid.T, rule:common.N.*,
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
  num,
  say,
  standardHnStageGroup,
} from './common';

/** T4b is the same for both sinonasal tables. */
function sinonasalT4b(
  p: NonNullable<StagingInput['primary']>,
  context: StagingContext,
): ReturnType<typeof firstFlag> {
  return firstFlag(
    [
      [p.orbital_apex, 'orbital apex invasion'],
      [p.dura, 'dural invasion'],
      [p.brain, 'brain invasion'],
      [p.middle_cranial_fossa, 'middle cranial fossa invasion'],
      [p.cranial_nerves_other_than_v2, 'cranial nerve involvement other than V2'],
      [p.nasopharynx_invasion, 'nasopharyngeal invasion'],
      [p.clivus, 'clival invasion'],
      [p.carotid_encasement, 'carotid artery encasement'],
    ],
    context,
  );
}

function maxillaryT(
  p: NonNullable<StagingInput['primary']>,
  context: StagingContext,
  label: string,
): CategoryResult<TCategory> {
  const trace: string[] = [];
  const t4b = sinonasalT4b(p, context);
  if (t4b) return { category: 'T4b', trace: [say(`${label}4b`, t4b.phrase, t4b.obs)] };

  const t4a = firstFlag(
    [
      [p.anterior_orbital_contents, 'anterior orbital contents invasion'],
      [p.skin_of_nose_or_cheek, 'skin of the cheek invasion'],
      [p.pterygoid_plates, 'pterygoid plate invasion'],
      [p.infratemporal_fossa, 'infratemporal fossa invasion'],
      [p.cribriform_plate, 'cribriform plate invasion'],
      [p.sphenoid_or_frontal_sinus, 'sphenoid or frontal sinus invasion'],
    ],
    context,
  );
  if (t4a) {
    trace.push(say(`${label}4a`, t4a.phrase, t4a.obs));
    return { category: 'T4a', trace };
  }

  const t3 = firstFlag(
    [
      [p.posterior_maxillary_wall, 'posterior bony wall of the maxillary sinus invasion'],
      [p.subcutaneous_tissue, 'subcutaneous tissue invasion'],
      [p.orbit_floor_or_medial_wall, 'floor or medial wall of the orbit invasion'],
      [p.pterygoid_fossa, 'pterygoid fossa invasion'],
      [p.ethmoid_sinus, 'ethmoid sinus invasion'],
    ],
    context,
  );
  if (t3) {
    trace.push(say(`${label}3`, t3.phrase, t3.obs));
    return { category: 'T3', trace };
  }

  const t2 = firstFlag(
    [
      [p.hard_palate_or_middle_meatus, 'bone erosion involving the hard palate and/or middle nasal meatus'],
      [p.bone_erosion, 'bone erosion or destruction'],
      [p.hard_palate, 'hard palate involvement with bone erosion'],
    ],
    context,
  );
  if (t2) {
    trace.push(
      say(`${label}2`, `${t2.phrase} (posterior wall and pterygoid plates excluded)`, t2.obs),
    );
    return { category: 'T2', trace };
  }

  const mucosaOnly = flag(p.mucosa_only, context);
  if (mucosaOnly) {
    trace.push(say(`${label}1`, 'limited to the maxillary sinus mucosa with no bone erosion', mucosaOnly));
    return { category: 'T1', trace };
  }
  return {
    category: 'TX',
    trace: [say(`${label}X`, 'no maxillary sinus T descriptors supplied')],
  };
}

function nasoethmoidT(
  p: NonNullable<StagingInput['primary']>,
  context: StagingContext,
  label: string,
): CategoryResult<TCategory> {
  const trace: string[] = [];
  const t4b = sinonasalT4b(p, context);
  if (t4b) return { category: 'T4b', trace: [say(`${label}4b`, t4b.phrase, t4b.obs)] };

  const t4a = firstFlag(
    [
      [p.anterior_orbital_contents, 'anterior orbital contents invasion'],
      [p.skin_of_nose_or_cheek, 'skin of the nose or cheek invasion'],
      [p.minimal_anterior_cranial_fossa, 'minimal extension to the anterior cranial fossa'],
      [p.pterygoid_plates, 'pterygoid plate invasion'],
      [p.sphenoid_or_frontal_sinus, 'sphenoid or frontal sinus invasion'],
    ],
    context,
  );
  if (t4a) {
    trace.push(say(`${label}4a`, t4a.phrase, t4a.obs));
    return { category: 'T4a', trace };
  }

  const t3 = firstFlag(
    [
      [p.orbit_floor_or_medial_wall, 'invasion of the medial wall or floor of the orbit'],
      [p.maxillary_sinus_invasion, 'maxillary sinus invasion'],
      [p.hard_palate, 'palate invasion'],
      [p.cribriform_plate, 'cribriform plate invasion'],
    ],
    context,
  );
  if (t3) {
    trace.push(say(`${label}3`, t3.phrase, t3.obs));
    return { category: 'T3', trace };
  }

  const subsites = num(p.subsite_count, context);
  const adjacentRegion = flag(p.adjacent_nasoethmoidal_region, context);
  if (adjacentRegion) {
    trace.push(
      say(`${label}2`, 'extension to an adjacent region within the nasoethmoidal complex, with or without bony invasion', adjacentRegion),
    );
    return { category: 'T2', trace };
  }
  if (subsites && subsites.value > 1) {
    trace.push(
      say(`${label}2`, `${subsites.value} subsites in a single region, with or without bony invasion`, subsites),
    );
    return { category: 'T2', trace };
  }
  if (subsites && subsites.value === 1) {
    trace.push(
      say(`${label}1`, 'restricted to one subsite, with or without bony invasion', subsites),
    );
    return { category: 'T1', trace };
  }
  const mucosaOnly = flag(p.mucosa_only, context);
  if (mucosaOnly) {
    trace.push(say(`${label}1`, 'restricted to one subsite', mucosaOnly));
    return { category: 'T1', trace };
  }
  return {
    category: 'TX',
    trace: [say(`${label}X`, 'no nasal cavity / ethmoid T descriptors supplied')],
  };
}

export function stageT(
  input: StagingInput,
  context: StagingContext = 'clinical',
): CategoryResult<TCategory> {
  const p = input.primary ?? {};
  const label = context === 'pathologic' ? 'pT' : 'cT';
  const insitu = flag(p.in_situ, context);
  if (insitu) return { category: 'Tis', trace: [say(`${label}is`, 'carcinoma in situ', insitu)] };
  return p.sinonasal_subsite === 'maxillary_sinus'
    ? maxillaryT(p, context, label)
    : nasoethmoidT(p, context, label);
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
  if (!input.primary?.sinonasal_subsite) {
    return [
      'Sinonasal subsite not specified. AJCC 8 has separate T tables for the maxillary sinus and ' +
        'for the nasal cavity / ethmoid sinus; the nasal cavity / ethmoid table was used.',
    ];
  }
  return [];
}

export const nasalCavityParanasalRules: SiteRules = {
  site: 'nasal_cavity_paranasal',
  label: 'Nasal cavity and paranasal sinuses',
  stageT,
  stageN,
  stageGroup,
  warnings,
  ruleIds: [
    'sinus.maxillary.T',
    'sinus.nasoethmoid.T',
    'common.N.clinical',
    'common.N.pathologic',
    'common.group.standard',
  ],
};

export default nasalCavityParanasalRules;
