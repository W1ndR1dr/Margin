/**
 * Staging engine tests. All pathology text below is synthetic — invented for
 * these tests, no patient data of any kind.
 *
 *   cd C:\Users\o948145\hnrad\frontend
 *   npx vitest run src/staging
 */

import { describe, expect, it } from 'vitest';

import { parseCapReport } from './capParser';
import { commonN } from './rules/common';
import { RULE_TABLE, rulesToVerify } from './rules/ruleTable';
import { SITE_RULES, rulesFor } from './rules';
import { stage } from './stage';
import { SITES } from './types';
import type {
  NodeRecord,
  Observation,
  PrimaryInput,
  Provenance,
  Site,
  StagingInput,
} from './types';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const obs =
  (source: Provenance) =>
  <T,>(value: T, note?: string): Observation<T> =>
    note ? { value, source, note } : { value, source };

const img = obs('imaging');
const exam = obs('exam');
const path = obs('pathology');

function primary(p: PrimaryInput): StagingInput {
  return { primary: p };
}

function T(site: Site, p: PrimaryInput, context: 'clinical' | 'pathologic' = 'clinical'): string {
  return rulesFor(site).stageT(primary(p), context).category;
}

function nodesInput(list: NodeRecord[]): StagingInput {
  return { nodes: { nodes: list } };
}

/* ================================================================== */
/* 1. oral cavity T — the corrected size x DOI grid                    */
/* ================================================================== */

describe('oral cavity T: size x depth-of-invasion grid', () => {
  const cases: Array<[number, number, string]> = [
    [1.4, 3, 'T1'],
    [2.0, 5, 'T1'], // both boundaries inclusive
    [2.0, 5.1, 'T2'],
    [2.1, 4, 'T2'],
    [3.5, 6, 'T2'],
    [4.0, 10, 'T2'],
    [4.0, 10.1, 'T3'],
    [4.1, 10, 'T3'],
    [4.1, 10.1, 'T4a'],
    [6.0, 14, 'T4a'],
  ];
  for (const [size, doi, expected] of cases) {
    it(`${size} cm with DOI ${doi} mm is ${expected}`, () => {
      expect(T('oral_cavity', { size_cm: exam(size), depth_of_invasion_mm: exam(doi) })).toBe(
        expected,
      );
    });
  }

  it('reports the driving value and its provenance in the trace', () => {
    const r = rulesFor('oral_cavity').stageT(
      primary({ size_cm: img(3.5), depth_of_invasion_mm: img(6) }),
    );
    expect(r.trace.join(' | ')).toContain('3.5 cm');
    expect(r.trace.join(' | ')).toContain('(imaging)');
  });

  it('a tumour <= 2 cm with DOI > 10 mm is T2 on the corrected table and is warned about', () => {
    const input: StagingInput = {
      primary: { size_cm: exam(1.8), depth_of_invasion_mm: path(12) },
      nodes: { nodes: [] },
      contextPathologic: true,
    };
    expect(rulesFor('oral_cavity').stageT(input, 'pathologic').category).toBe('T2');
    const result = stage('oral_cavity', input);
    expect(result.warnings.some((w) => w.includes('least likely to be intended') || w.includes('widely reported as T3'))).toBe(
      true,
    );
  });

  it('warns when the original and corrected printings of AJCC 8 disagree', () => {
    // 5 cm with DOI 4 mm: corrected T3, original printing also T3 -> no warning.
    const same = stage('oral_cavity', {
      primary: { size_cm: exam(5), depth_of_invasion_mm: exam(4) },
      nodes: { nodes: [] },
    });
    expect(same.warnings.some((w) => w.includes('original printing'))).toBe(false);
    // 1.5 cm with DOI 12 mm: corrected T2, original T3.
    const differ = stage('oral_cavity', {
      primary: { size_cm: exam(1.5), depth_of_invasion_mm: exam(12) },
      nodes: { nodes: [] },
    });
    expect(differ.warnings.some((w) => w.includes('original printing gives T3'))).toBe(true);
  });
});

describe('oral cavity T: local invasion', () => {
  it('cortical mandible invasion is T4a and names the provenance', () => {
    const r = rulesFor('oral_cavity').stageT(
      primary({ size_cm: exam(2), depth_of_invasion_mm: exam(3), cortical_bone_invasion: img(true) }),
    );
    expect(r.category).toBe('T4a');
    expect(r.trace.some((line) => /cT4a: invasion through cortical bone .*\(imaging\)/.test(line))).toBe(
      true,
    );
  });

  it('maxillary sinus and facial skin invasion are T4a', () => {
    expect(T('oral_cavity', { size_cm: exam(2), maxillary_sinus_invasion: img(true) })).toBe('T4a');
    expect(T('oral_cavity', { size_cm: exam(2), skin_invasion: exam(true) })).toBe('T4a');
  });

  it('masticator space, pterygoid plates, skull base and ICA encasement are T4b', () => {
    expect(T('oral_cavity', { masticator_space: img(true) })).toBe('T4b');
    expect(T('oral_cavity', { pterygoid_plates: img(true) })).toBe('T4b');
    expect(T('oral_cavity', { skull_base: img(true) })).toBe('T4b');
    expect(T('oral_cavity', { carotid_encasement: img(true) })).toBe('T4b');
  });

  it('superficial erosion of bone / tooth socket alone by a gingival primary is not T4', () => {
    const r = rulesFor('oral_cavity').stageT(
      primary({
        size_cm: path(1.6),
        depth_of_invasion_mm: path(4),
        cortical_bone_invasion: path(true, 'erosion of the alveolar crest'),
        gingival_superficial_bone_erosion: path(true),
      }),
      'pathologic',
    );
    expect(r.category).toBe('T1');
    expect(r.trace.join(' | ')).toContain('AJCC 8 exception');
  });

  it('extrinsic tongue muscle invasion is noted but is no longer a T4 criterion', () => {
    const r = rulesFor('oral_cavity').stageT(
      primary({
        size_cm: exam(3),
        depth_of_invasion_mm: exam(8),
        extrinsic_tongue_muscle: img(true),
      }),
    );
    expect(r.category).toBe('T2');
    expect(r.trace.join(' | ')).toContain('no longer a T4 criterion');
  });
});

/* ================================================================== */
/* 2. the shared N table                                               */
/* ================================================================== */

describe('common N — clinical', () => {
  const cN = (list: NodeRecord[]) => commonN(nodesInput(list), 'clinical').category;

  it('N0 when the neck was assessed and is negative', () => {
    expect(cN([])).toBe('N0');
  });
  it('NX when nothing is known about the neck', () => {
    expect(commonN({}, 'clinical').category).toBe('NX');
  });
  it('single ipsilateral node exactly 3.0 cm is N1', () => {
    expect(cN([{ side: 'ipsilateral', size_cm: exam(3.0) }])).toBe('N1');
  });
  it('single ipsilateral node 3.1 cm is N2a', () => {
    expect(cN([{ side: 'ipsilateral', size_cm: exam(3.1) }])).toBe('N2a');
  });
  it('single ipsilateral node exactly 6.0 cm is N2a', () => {
    expect(cN([{ side: 'ipsilateral', size_cm: exam(6.0) }])).toBe('N2a');
  });
  it('single node 6.1 cm is N3a', () => {
    expect(cN([{ side: 'ipsilateral', size_cm: exam(6.1) }])).toBe('N3a');
  });
  it('multiple ipsilateral nodes <= 6 cm are N2b', () => {
    expect(cN([{ side: 'ipsilateral', size_cm: exam(2) }, { side: 'ipsilateral', size_cm: exam(1.5) }])).toBe(
      'N2b',
    );
  });
  it('contralateral or bilateral nodes <= 6 cm are N2c', () => {
    expect(cN([{ side: 'contralateral', size_cm: exam(2) }])).toBe('N2c');
    expect(cN([{ side: 'bilateral', size_cm: exam(2) }])).toBe('N2c');
  });
  it('clinically overt ENE is N3b whatever the size', () => {
    const r = commonN(
      nodesInput([{ side: 'ipsilateral', size_cm: exam(1.2), ene_clinical: exam(true) }]),
      'clinical',
    );
    expect(r.category).toBe('N3b');
    expect(r.trace.join(' | ')).toContain('clinically overt extranodal extension');
  });
});

describe('common N — pathologic', () => {
  const pN = (list: NodeRecord[]) => commonN(nodesInput(list), 'pathologic').category;

  it('single ipsilateral node <= 3 cm with ENE(+) is pN2a, not pN3b', () => {
    expect(pN([{ side: 'ipsilateral', size_cm: path(2.4), ene_pathologic: path(true) }])).toBe('N2a');
  });
  it('single ipsilateral node > 3 cm with ENE(+) is pN3b', () => {
    expect(pN([{ side: 'ipsilateral', size_cm: path(3.6), ene_pathologic: path(true) }])).toBe('N3b');
  });
  it('multiple nodes with any ENE(+) are pN3b', () => {
    expect(
      pN([
        { side: 'ipsilateral', size_cm: path(1.1) },
        { side: 'ipsilateral', size_cm: path(2.2), ene_pathologic: path(true) },
      ]),
    ).toBe('N3b');
  });
  it('a single contralateral node of any size with ENE(+) is pN3b', () => {
    expect(pN([{ side: 'contralateral', size_cm: path(1.0), ene_pathologic: path(true) }])).toBe(
      'N3b',
    );
  });
  it('ENEmi (<= 2 mm) and ENEma (> 2 mm) are both ENE(+), and are labelled in the trace', () => {
    const mi = commonN(
      nodesInput([
        { side: 'ipsilateral', size_cm: path(2.0), ene_pathologic: path(true), ene_extent_mm: path(1.4) },
      ]),
      'pathologic',
    );
    const ma = commonN(
      nodesInput([
        { side: 'ipsilateral', size_cm: path(2.0), ene_pathologic: path(true), ene_extent_mm: path(4.0) },
      ]),
      'pathologic',
    );
    expect(mi.category).toBe('N2a');
    expect(ma.category).toBe('N2a');
    expect(mi.trace.join(' | ')).toContain('ENEmi');
    expect(ma.trace.join(' | ')).toContain('ENEma');
  });
  it('a clinical classification ignores pathology-sourced descriptors', () => {
    const input = nodesInput([{ side: 'ipsilateral', size_cm: path(4.2) }]);
    expect(commonN(input, 'clinical').category).toBe('NX');
    expect(commonN(input, 'pathologic').category).toBe('N2a');
  });
});

/* ================================================================== */
/* 3. oropharynx, p16+ vs p16-                                         */
/* ================================================================== */

describe('oropharynx: identical inputs, p16+ vs p16-', () => {
  const shared: StagingInput = {
    primary: { size_cm: exam(3.5) },
    nodes: { nodes: [{ side: 'contralateral', size_cm: exam(4.0) }] },
    patient: { p16: 'positive' },
  };

  it('p16+ gives cT2 cN2 stage II', () => {
    const r = stage('oropharynx_p16pos', shared);
    expect([r.clinical.T, r.clinical.N, r.clinical.group]).toEqual(['T2', 'N2', 'II']);
  });

  it('p16- gives the same T but cN2c and stage IVA', () => {
    const r = stage('oropharynx_p16neg', { ...shared, patient: { p16: 'negative' } });
    expect([r.clinical.T, r.clinical.N, r.clinical.group]).toEqual(['T2', 'N2c', 'IVA']);
  });

  it('missing p16 computes both chapters and says so', () => {
    const r = stage('oropharynx_p16pos', { ...shared, patient: {} });
    expect(r.alternate?.site).toBe('oropharynx_p16neg');
    expect(r.alternate?.clinical.group).toBe('IVA');
    expect(r.warnings.some((w) => w.includes('p16 result missing'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('Both oropharyngeal chapters were computed'))).toBe(true);
  });

  it('p16+ T4 has no T4b, and carotid encasement still lands in T4', () => {
    expect(T('oropharynx_p16pos', { size_cm: exam(2), carotid_encasement: img(true) })).toBe('T4');
    expect(T('oropharynx_p16neg', { size_cm: exam(2), carotid_encasement: img(true) })).toBe('T4b');
  });

  it('p16+ clinical grouping: N3 is stage III, T4 is stage III', () => {
    const big = stage('oropharynx_p16pos', {
      primary: { size_cm: exam(2) },
      nodes: { nodes: [{ side: 'ipsilateral', size_cm: exam(7) }] },
      patient: { p16: 'positive' },
    });
    expect([big.clinical.N, big.clinical.group]).toEqual(['N3', 'III']);
  });

  it('p16+ pathologic grouping: pN1 (<= 4 nodes) T2 is stage I, pN2 (> 4) is stage II', () => {
    const few = stage('oropharynx_p16pos', {
      primary: { size_cm: path(3) },
      nodes: { count_positive: path(4), count_examined: path(30) },
      patient: { p16: 'positive' },
      contextPathologic: true,
    });
    expect([few.pathologic?.N, few.pathologic?.group]).toEqual(['N1', 'I']);
    const many = stage('oropharynx_p16pos', {
      primary: { size_cm: path(3) },
      nodes: { count_positive: path(5), count_examined: path(30) },
      patient: { p16: 'positive' },
      contextPathologic: true,
    });
    expect([many.pathologic?.N, many.pathologic?.group]).toEqual(['N2', 'II']);
  });

  it('p16+ pathologic T3-T4 with pN0-pN1 is stage II, with pN2 is stage III', () => {
    const rules = rulesFor('oropharynx_p16pos');
    expect(rules.stageGroup('T4', 'N1', 'M0', undefined, 'pathologic').group).toBe('II');
    expect(rules.stageGroup('T4', 'N2', 'M0', undefined, 'pathologic').group).toBe('III');
  });
});

/* ================================================================== */
/* 4. hypopharynx and larynx                                           */
/* ================================================================== */

describe('hypopharynx T', () => {
  it('one subsite and <= 2 cm is T1', () => {
    expect(T('hypopharynx', { size_cm: exam(1.8), subsite_count: exam(1) })).toBe('T1');
  });
  it('> 2-4 cm without hemilarynx fixation is T2', () => {
    expect(T('hypopharynx', { size_cm: exam(3.0) })).toBe('T2');
  });
  it('> 4 cm is T3', () => {
    expect(T('hypopharynx', { size_cm: exam(4.5) })).toBe('T3');
  });
  it('hemilarynx fixation is T3 whatever the size', () => {
    expect(T('hypopharynx', { size_cm: exam(1.5), hemilarynx_fixation: exam(true) })).toBe('T3');
  });
  it('oesophageal mucosal extension is T3, oesophageal muscle invasion is T4a', () => {
    expect(T('hypopharynx', { size_cm: exam(2), esophageal_mucosa_extension: img(true) })).toBe('T3');
    expect(T('hypopharynx', { size_cm: exam(2), esophagus_invasion: img(true) })).toBe('T4a');
  });
  it('prevertebral fascia, carotid encasement and mediastinal structures are T4b', () => {
    expect(T('hypopharynx', { prevertebral_fascia_invasion: img(true) })).toBe('T4b');
    expect(T('hypopharynx', { carotid_encasement: img(true) })).toBe('T4b');
    expect(T('hypopharynx', { mediastinal_structures: img(true) })).toBe('T4b');
  });
});

describe('larynx T by subsite', () => {
  it('supraglottis: one subsite T1, more than one T2, pre-epiglottic space T3, through cartilage T4a', () => {
    expect(T('larynx_supraglottic', { subsite_count: exam(1) })).toBe('T1');
    expect(T('larynx_supraglottic', { supraglottis_multiple_subsites: exam(true) })).toBe('T2');
    expect(T('larynx_supraglottic', { pre_epiglottic_space: img(true) })).toBe('T3');
    expect(T('larynx_supraglottic', { thyroid_cartilage_through: img(true) })).toBe('T4a');
    expect(T('larynx_supraglottic', { carotid_encasement: img(true) })).toBe('T4b');
  });

  it('glottis: one cord T1a, both cords T1b, impaired mobility T2, fixation T3', () => {
    expect(T('larynx_glottic', { subsite_count: exam(1) })).toBe('T1a');
    expect(T('larynx_glottic', { subsite_count: exam(2) })).toBe('T1b');
    expect(T('larynx_glottic', { impaired_vocal_cord_mobility: exam(true) })).toBe('T2');
    expect(T('larynx_glottic', { vocal_cord_fixation: exam(true) })).toBe('T3');
    expect(T('larynx_glottic', { thyroid_cartilage_inner_cortex: img(true) })).toBe('T3');
    expect(T('larynx_glottic', { thyroid_cartilage_through: img(true) })).toBe('T4a');
  });

  it('subglottis: limited to subglottis T1, cord extension T2, paraglottic space T3, cricoid T4a', () => {
    expect(T('larynx_subglottic', { limited_to_larynx: exam(true) })).toBe('T1');
    expect(T('larynx_subglottic', { vocal_cord_involvement: exam(true) })).toBe('T2');
    expect(T('larynx_subglottic', { paraglottic_space: img(true) })).toBe('T3');
    expect(T('larynx_subglottic', { cricoid_invasion: img(true) })).toBe('T4a');
  });

  it('inner cortex is T3 and through the outer cortex is T4a — the distinction Margin measures', () => {
    const inner = rulesFor('larynx_glottic').stageT(
      primary({ thyroid_cartilage_inner_cortex: img(true, 'sclerosis with inner cortex erosion') }),
    );
    expect(inner.category).toBe('T3');
    expect(inner.trace.join(' | ')).toContain('inner cortex erosion');
  });
});

/* ================================================================== */
/* 5. nasopharynx                                                      */
/* ================================================================== */

describe('nasopharynx', () => {
  it('T1 without parapharyngeal extension, T2 with it, T3 for skull base bone, T4 for cranial nerve', () => {
    expect(T('nasopharynx', { mucosa_only: img(true) })).toBe('T1');
    expect(T('nasopharynx', { parapharyngeal_space: img(true) })).toBe('T2');
    expect(T('nasopharynx', { prevertebral_muscle: img(true) })).toBe('T2');
    expect(T('nasopharynx', { bony_skull_base: img(true) })).toBe('T3');
    expect(T('nasopharynx', { cranial_nerve_involvement: exam(true) })).toBe('T4');
  });

  it('N1 unilateral <= 6 cm, N2 bilateral, N3 > 6 cm or below the cricoid', () => {
    const n = (list: NodeRecord[]) =>
      rulesFor('nasopharynx').stageN(nodesInput(list), 'clinical').category;
    expect(n([{ side: 'ipsilateral', size_cm: exam(3) }])).toBe('N1');
    expect(n([{ side: 'ipsilateral', retropharyngeal: exam(true), size_cm: exam(1.5) }])).toBe('N1');
    expect(n([{ side: 'ipsilateral', size_cm: exam(2) }, { side: 'contralateral', size_cm: exam(2) }])).toBe(
      'N2',
    );
    expect(n([{ side: 'ipsilateral', size_cm: exam(6.5) }])).toBe('N3');
    expect(n([{ side: 'ipsilateral', size_cm: exam(2), below_cricoid: img(true) }])).toBe('N3');
  });

  it('stage groups: T2 N1 is II, T3 N2 is III, T4 N0 is IVA, N3 is IVA', () => {
    const g = rulesFor('nasopharynx').stageGroup;
    expect(g('T2', 'N1', 'M0').group).toBe('II');
    expect(g('T3', 'N2', 'M0').group).toBe('III');
    expect(g('T4', 'N0', 'M0').group).toBe('IVA');
    expect(g('T1', 'N3', 'M0').group).toBe('IVA');
    expect(g('T1', 'N0', 'M1').group).toBe('IVB');
  });
});

/* ================================================================== */
/* 6. salivary and sinonasal                                           */
/* ================================================================== */

describe('major salivary gland T', () => {
  it('2.0 cm is T1 and 2.1 cm is T2', () => {
    expect(T('major_salivary', { size_cm: exam(2.0) })).toBe('T1');
    expect(T('major_salivary', { size_cm: exam(2.1) })).toBe('T2');
  });
  it('extraparenchymal extension is T3 whatever the size', () => {
    expect(T('major_salivary', { size_cm: exam(1.2), extraparenchymal_extension: exam(true) })).toBe(
      'T3',
    );
  });
  it('facial nerve, ear canal, skin and mandible are T4a; skull base and carotid are T4b', () => {
    expect(T('major_salivary', { size_cm: exam(2), facial_nerve: exam(true) })).toBe('T4a');
    expect(T('major_salivary', { size_cm: exam(2), ear_canal: img(true) })).toBe('T4a');
    expect(T('major_salivary', { size_cm: exam(2), skull_base: img(true) })).toBe('T4b');
    expect(T('major_salivary', { size_cm: exam(2), carotid_encasement: img(true) })).toBe('T4b');
  });
});

describe('nasal cavity and paranasal sinus T', () => {
  it('maxillary sinus table: mucosa T1, bone erosion T2, orbital floor T3, cribriform T4a, dura T4b', () => {
    const max = (p: PrimaryInput) => T('nasal_cavity_paranasal', { sinonasal_subsite: 'maxillary_sinus', ...p });
    expect(max({ mucosa_only: img(true) })).toBe('T1');
    expect(max({ bone_erosion: img(true) })).toBe('T2');
    expect(max({ orbit_floor_or_medial_wall: img(true) })).toBe('T3');
    expect(max({ cribriform_plate: img(true) })).toBe('T4a');
    expect(max({ dura: img(true) })).toBe('T4b');
  });

  it('nasal cavity / ethmoid table: one subsite T1, two T2, orbital wall T3, anterior fossa T4a', () => {
    const ne = (p: PrimaryInput) =>
      T('nasal_cavity_paranasal', { sinonasal_subsite: 'nasal_cavity_ethmoid', ...p });
    expect(ne({ subsite_count: img(1) })).toBe('T1');
    expect(ne({ subsite_count: img(2) })).toBe('T2');
    expect(ne({ orbit_floor_or_medial_wall: img(true) })).toBe('T3');
    expect(ne({ minimal_anterior_cranial_fossa: img(true) })).toBe('T4a');
    expect(ne({ orbital_apex: img(true) })).toBe('T4b');
  });

  it('warns when the sinonasal subsite is not given', () => {
    const r = stage('nasal_cavity_paranasal', {
      primary: { subsite_count: img(1) },
      nodes: { nodes: [] },
    });
    expect(r.warnings.some((w) => w.includes('Sinonasal subsite not specified'))).toBe(true);
  });
});

/* ================================================================== */
/* 7. thyroid                                                          */
/* ================================================================== */

describe('thyroid T and N', () => {
  it('T1a <= 1 cm, T1b > 1-2 cm, T2 > 2-4 cm, T3a > 4 cm', () => {
    expect(T('thyroid_differentiated', { size_cm: exam(0.8) })).toBe('T1a');
    expect(T('thyroid_differentiated', { size_cm: exam(1.0) })).toBe('T1a');
    expect(T('thyroid_differentiated', { size_cm: exam(1.1) })).toBe('T1b');
    expect(T('thyroid_differentiated', { size_cm: exam(2.0) })).toBe('T1b');
    expect(T('thyroid_differentiated', { size_cm: exam(2.1) })).toBe('T2');
    expect(T('thyroid_differentiated', { size_cm: exam(4.0) })).toBe('T2');
    expect(T('thyroid_differentiated', { size_cm: exam(4.1) })).toBe('T3a');
  });

  it('gross ETE categories: strap muscles T3b, larynx/trachea/RLN T4a, prevertebral/carotid T4b', () => {
    expect(T('thyroid_differentiated', { size_cm: exam(1.2), strap_muscle_invasion: exam(true) })).toBe(
      'T3b',
    );
    expect(
      T('thyroid_differentiated', { size_cm: exam(1.2), larynx_trachea_rln_invasion: img(true) }),
    ).toBe('T4a');
    expect(
      T('thyroid_differentiated', { size_cm: exam(1.2), prevertebral_fascia_invasion: img(true) }),
    ).toBe('T4b');
    expect(T('thyroid_differentiated', { size_cm: exam(1.2), carotid_encasement: img(true) })).toBe(
      'T4b',
    );
  });

  it('N1a is level VI/VII, N1b is lateral neck or retropharyngeal', () => {
    const n = (i: StagingInput) => rulesFor('thyroid_differentiated').stageN(i, 'pathologic').category;
    expect(n({ nodes: { nodes: [{ side: 'ipsilateral', level: path('VI'), size_cm: path(0.6) }] } })).toBe(
      'N1a',
    );
    expect(n({ nodes: { nodes: [{ side: 'ipsilateral', level: path('III'), size_cm: path(1.2) }] } })).toBe(
      'N1b',
    );
    expect(n({ nodes: { nodes: [{ side: 'ipsilateral', retropharyngeal: path(true) }] } })).toBe('N1b');
  });
});

describe('thyroid stage groups', () => {
  const base = (age: number, p: PrimaryInput): StagingInput => ({
    primary: p,
    nodes: { nodes: [] },
    patient: { age },
  });

  it('differentiated: a 5 cm T3a is stage I at 54 and stage II at 55', () => {
    expect(stage('thyroid_differentiated', base(54, { size_cm: exam(5) })).clinical.group).toBe('I');
    expect(stage('thyroid_differentiated', base(55, { size_cm: exam(5) })).clinical.group).toBe('II');
  });

  it('differentiated under 55: even T4b N1b M0 is stage I, and M1 is stage II', () => {
    const t4b = stage('thyroid_differentiated', {
      primary: { size_cm: exam(3), carotid_encasement: img(true) },
      nodes: { nodes: [{ side: 'ipsilateral', level: exam('III'), size_cm: exam(2) }] },
      patient: { age: 40 },
    });
    expect([t4b.clinical.T, t4b.clinical.group]).toEqual(['T4b', 'I']);
    const m1 = stage('thyroid_differentiated', {
      primary: { size_cm: exam(1) },
      nodes: { nodes: [] },
      metastasis: { m1: img(true) },
      patient: { age: 40 },
    });
    expect(m1.clinical.group).toBe('II');
  });

  it('differentiated at 55+: T4a is III, T4b is IVA, M1 is IVB', () => {
    const g = rulesFor('thyroid_differentiated').stageGroup;
    expect(g('T4a', 'N1a', 'M0', { age: 70 }).group).toBe('III');
    expect(g('T4b', 'N0', 'M0', { age: 70 }).group).toBe('IVA');
    expect(g('T1a', 'N0', 'M1', { age: 70 }).group).toBe('IVB');
    expect(g('T2', 'N1b', 'M0', { age: 70 }).group).toBe('II');
    expect(g('T2', 'N0', 'M0', { age: 70 }).group).toBe('I');
  });

  it('differentiated without an age cannot be grouped, and says so', () => {
    const r = stage('thyroid_differentiated', {
      primary: { size_cm: exam(3) },
      nodes: { nodes: [] },
    });
    expect(r.clinical.group).toBe('unknown');
    expect(r.warnings.some((w) => w.includes('Age at diagnosis missing'))).toBe(true);
  });

  it('anaplastic uses the same T table and is always stage IV', () => {
    const r = rulesFor('thyroid_anaplastic');
    expect(r.stageT(primary({ size_cm: exam(3) })).category).toBe('T2');
    expect(r.stageT(primary({ size_cm: exam(3) })).trace.join(' | ')).toContain(
      'no longer automatically T4',
    );
    expect(r.stageGroup('T2', 'N0', 'M0').group).toBe('IVA');
    expect(r.stageGroup('T2', 'N1a', 'M0').group).toBe('IVB');
    expect(r.stageGroup('T3b', 'N0', 'M0').group).toBe('IVB');
    expect(r.stageGroup('T4a', 'N0', 'M0').group).toBe('IVB');
    expect(r.stageGroup('T2', 'N0', 'M1').group).toBe('IVC');
  });

  it('medullary uses the same T but its own groups, with no age cut-off', () => {
    const r = rulesFor('thyroid_medullary');
    expect(r.stageT(primary({ size_cm: exam(0.7) })).category).toBe('T1a');
    expect(r.stageGroup('T1a', 'N0', 'M0').group).toBe('I');
    expect(r.stageGroup('T2', 'N0', 'M0').group).toBe('II');
    expect(r.stageGroup('T3a', 'N0', 'M0').group).toBe('II');
    expect(r.stageGroup('T2', 'N1a', 'M0').group).toBe('III');
    expect(r.stageGroup('T2', 'N1b', 'M0').group).toBe('IVA');
    expect(r.stageGroup('T4a', 'N0', 'M0').group).toBe('IVA');
    expect(r.stageGroup('T4b', 'N0', 'M0').group).toBe('IVB');
    expect(r.stageGroup('T1a', 'N0', 'M1').group).toBe('IVC');
  });
});

/* ================================================================== */
/* 8. cutaneous SCC                                                    */
/* ================================================================== */

describe('cutaneous SCC of the head and neck', () => {
  it('T1 <= 2 cm, T2 > 2-4 cm, T3 > 4 cm', () => {
    expect(T('cutaneous_scc_hn', { size_cm: exam(2.0) })).toBe('T1');
    expect(T('cutaneous_scc_hn', { size_cm: exam(2.1) })).toBe('T2');
    expect(T('cutaneous_scc_hn', { size_cm: exam(4.0) })).toBe('T2');
    expect(T('cutaneous_scc_hn', { size_cm: exam(4.1) })).toBe('T3');
  });

  it('perineural invasion of a >= 0.1 mm nerve makes a small tumour T3', () => {
    const r = rulesFor('cutaneous_scc_hn').stageT(
      primary({ size_cm: path(1.1), perineural_nerve_calibre_mm: path(0.1) }),
      'pathologic',
    );
    expect(r.category).toBe('T3');
    expect(r.trace.join(' | ')).toContain('>= 0.1 mm');
    expect(
      T('cutaneous_scc_hn', { size_cm: path(1.1), perineural_nerve_calibre_mm: path(0.05) }, 'pathologic'),
    ).toBe('T1');
    expect(T('cutaneous_scc_hn', { size_cm: exam(1.1), named_nerve_invasion: exam(true) })).toBe('T3');
  });

  it('deep invasion is > 6 mm thickness or beyond the subcutaneous fat', () => {
    const p = (x: PrimaryInput) => T('cutaneous_scc_hn', x, 'pathologic');
    expect(p({ size_cm: path(1.5), dermal_invasion_depth_mm: path(6) })).toBe('T1');
    expect(p({ size_cm: path(1.5), dermal_invasion_depth_mm: path(6.1) })).toBe('T3');
    expect(p({ size_cm: path(1.5), beyond_subcutaneous_fat: path(true) })).toBe('T3');
  });

  it('minor bone erosion is T3, gross cortical/marrow invasion T4a, skull base T4b', () => {
    expect(T('cutaneous_scc_hn', { size_cm: exam(1.5), minor_bone_erosion: img(true) })).toBe('T3');
    expect(
      T('cutaneous_scc_hn', { size_cm: exam(1.5), gross_cortical_bone_marrow_invasion: img(true) }),
    ).toBe('T4a');
    expect(T('cutaneous_scc_hn', { size_cm: exam(1.5), skull_base_foramen: img(true) })).toBe('T4b');
  });

  it('stage groups: T3 N0 is III, N1 is III, N2 or above is IV', () => {
    const g = rulesFor('cutaneous_scc_hn').stageGroup;
    expect(g('T1', 'N0', 'M0').group).toBe('I');
    expect(g('T2', 'N0', 'M0').group).toBe('II');
    expect(g('T3', 'N0', 'M0').group).toBe('III');
    expect(g('T1', 'N1', 'M0').group).toBe('III');
    expect(g('T1', 'N2a', 'M0').group).toBe('IV');
    expect(g('T4a', 'N0', 'M0').group).toBe('IV');
  });
});

/* ================================================================== */
/* 9. unknown primary and mucosal melanoma                             */
/* ================================================================== */

describe('cervical nodes with unknown primary', () => {
  it('is always T0 and is grouped by N alone', () => {
    const r = stage('unknown_primary', {
      nodes: { nodes: [{ side: 'ipsilateral', size_cm: exam(2.0) }] },
      patient: { p16: 'negative', ebv: 'negative' },
    });
    expect([r.clinical.T, r.clinical.N, r.clinical.group]).toEqual(['T0', 'N1', 'III']);
    const g = rulesFor('unknown_primary').stageGroup;
    expect(g('T0', 'N2b', 'M0').group).toBe('IVA');
    expect(g('T0', 'N3b', 'M0').group).toBe('IVB');
    expect(g('T0', 'N1', 'M1').group).toBe('IVC');
  });

  it('warns that a p16-positive node belongs in the HPV-mediated oropharynx chapter', () => {
    const r = stage('unknown_primary', {
      nodes: { nodes: [{ side: 'ipsilateral', size_cm: exam(2.0) }] },
      patient: { p16: 'positive', ebv: 'negative' },
    });
    expect(r.warnings.some((w) => w.includes('HPV-mediated (p16+) oropharynx chapter'))).toBe(true);
  });
});

describe('mucosal melanoma of the head and neck', () => {
  it('staging starts at T3 and skips stages I and II', () => {
    expect(T('mucosal_melanoma_hn', { mucosa_and_underlying_soft_tissue_only: exam(true) })).toBe('T3');
    expect(T('mucosal_melanoma_hn', { bone_invasion: img(true) })).toBe('T4a');
    expect(T('mucosal_melanoma_hn', { deep_soft_tissue: img(true) })).toBe('T4a');
    expect(T('mucosal_melanoma_hn', { dura: img(true) })).toBe('T4b');
    expect(T('mucosal_melanoma_hn', { lower_cranial_nerves: exam(true) })).toBe('T4b');
    const g = rulesFor('mucosal_melanoma_hn').stageGroup;
    expect(g('T3', 'N0', 'M0').group).toBe('III');
    expect(g('T4a', 'N0', 'M0').group).toBe('IVA');
    expect(g('T3', 'N1', 'M0').group).toBe('IVA');
    expect(g('T4b', 'N0', 'M0').group).toBe('IVB');
    expect(g('T3', 'N0', 'M1').group).toBe('IVC');
  });

  it('N is N0 / N1 only, with no size or ENE subdivision', () => {
    const n = (list: NodeRecord[]) =>
      rulesFor('mucosal_melanoma_hn').stageN(nodesInput(list), 'clinical').category;
    expect(n([])).toBe('N0');
    expect(n([{ side: 'ipsilateral', size_cm: exam(7), ene_clinical: exam(true) }])).toBe('N1');
  });
});

/* ================================================================== */
/* 10. conflicts and warnings                                          */
/* ================================================================== */

describe('imaging vs pathology conflicts', () => {
  it('imaging says cortical bone invasion, pathology says none: cT4a, pT2, one conflict', () => {
    const input: StagingInput = {
      primary: {
        size_cm: [img(3.2), path(2.9)],
        depth_of_invasion_mm: [img(9), path(7)],
        cortical_bone_invasion: [img(true), path(false)],
      },
      nodes: { nodes: [] },
      contextPathologic: true,
    };
    const r = stage('oral_cavity', input);
    expect(r.clinical.T).toBe('T4a');
    expect(r.pathologic?.T).toBe('T2');
    const bone = r.conflicts.find((c) => c.field === 'primary.cortical_bone_invasion');
    expect(bone).toBeDefined();
    expect(bone?.imaging).toContain('present');
    expect(bone?.pathology).toContain('absent');
    expect(r.conflicts.map((c) => c.field)).toContain('primary.size_cm');
  });

  it('agreeing observations are not reported as conflicts', () => {
    const r = stage('oral_cavity', {
      primary: { size_cm: [img(3.0), path(3.0)], depth_of_invasion_mm: [img(8), path(8)] },
      nodes: { nodes: [] },
      contextPathologic: true,
    });
    expect(r.conflicts).toHaveLength(0);
  });
});

describe('warnings', () => {
  it('flags depth of invasion taken from imaging', () => {
    const r = stage('oral_cavity', {
      primary: { size_cm: img(3), depth_of_invasion_mm: img(8) },
      nodes: { nodes: [] },
    });
    expect(r.warnings.some((w) => w.includes('imaging DOI overestimates histologic DOI'))).toBe(true);
  });

  it('flags ENE recorded from imaging only', () => {
    const r = stage('oral_cavity', {
      primary: { size_cm: exam(3), depth_of_invasion_mm: exam(4) },
      nodes: { nodes: [{ side: 'ipsilateral', size_cm: exam(2.5), ene_clinical: img(true) }] },
    });
    expect(r.warnings.some((w) => w.includes('radiologic ENE is not cENE'))).toBe(true);
  });

  it('does not flag ENE when the surgeon recorded it on examination', () => {
    const r = stage('oral_cavity', {
      primary: { size_cm: exam(3), depth_of_invasion_mm: exam(4) },
      nodes: { nodes: [{ side: 'ipsilateral', size_cm: exam(2.5), ene_clinical: exam(true) }] },
    });
    expect(r.warnings.some((w) => w.includes('radiologic ENE is not cENE'))).toBe(false);
  });

  it("lists the rules used here that are marked 'verify'", () => {
    const r = stage('oral_cavity', {
      primary: { size_cm: exam(3), depth_of_invasion_mm: exam(4) },
      nodes: { nodes: [] },
    });
    expect(r.warnings.some((w) => w.includes("marked 'verify'") && w.includes('oral.T.grid'))).toBe(
      true,
    );
  });

  it('cites its sources', () => {
    const r = stage('oral_cavity', {
      primary: { size_cm: exam(3), depth_of_invasion_mm: exam(4) },
      nodes: { nodes: [] },
    });
    expect(r.sources.join(' ')).toContain('facs.org');
  });
});

/* ================================================================== */
/* 11. end-to-end stage groups for the standard head & neck table      */
/* ================================================================== */

describe('standard head & neck stage grouping', () => {
  const g = rulesFor('oral_cavity').stageGroup;
  it('maps the whole table', () => {
    expect(g('T1', 'N0', 'M0').group).toBe('I');
    expect(g('T2', 'N0', 'M0').group).toBe('II');
    expect(g('T3', 'N0', 'M0').group).toBe('III');
    expect(g('T1', 'N1', 'M0').group).toBe('III');
    expect(g('T4a', 'N0', 'M0').group).toBe('IVA');
    expect(g('T2', 'N2b', 'M0').group).toBe('IVA');
    expect(g('T4b', 'N0', 'M0').group).toBe('IVB');
    expect(g('T1', 'N3b', 'M0').group).toBe('IVB');
    expect(g('T1', 'N0', 'M1').group).toBe('IVC');
    expect(g('TX', 'N0', 'M0').group).toBe('unknown');
  });
});

/* ================================================================== */
/* 12. CAP synoptic parser — six synthetic reports                     */
/* ================================================================== */

const ORAL_TONGUE_REPORT = `
SURGICAL PATHOLOGY - SYNOPTIC SUMMARY (synthetic, not a real patient)
Specimen: Left partial glossectomy and left selective neck dissection, levels I-IV
Procedure: Partial glossectomy with neck dissection
Tumor Site: Left oral tongue
Histologic Type: Squamous cell carcinoma, conventional
Histologic Grade: G2, moderately differentiated
Tumor Size: Greatest dimension: 2.7 cm
Depth of Invasion: 6 mm
Perineural Invasion: Present
Lymphovascular Invasion: Not identified
Bone Invasion: Not identified
Margins: Invasive carcinoma: Uninvolved by invasive carcinoma
Margins: Distance from invasive carcinoma to closest margin: 4 mm
Number of Lymph Nodes Examined: 34
Number of Lymph Nodes Involved: 2
Laterality: Left
Size of Largest Metastatic Deposit: Greatest dimension: 1.8 cm
Extranodal Extension: Not identified
Distant Metastasis: Not applicable
Pathologic Stage Classification (pTNM, AJCC 8th Edition): pT2 pN2b
`;

const TONSIL_P16_REPORT = `
SYNOPTIC REPORT (synthetic)
Procedure: Transoral robotic resection, right palatine tonsil, and right selective neck dissection levels II-IV
Tumor Site: Right palatine tonsil, oropharynx
Histologic Type: Squamous cell carcinoma, non-keratinizing
Tumor Size: Greatest dimension: 3.1 cm
p16 Immunohistochemistry (surrogate for high-risk HPV): Positive, diffuse nuclear and cytoplasmic staining
High-Risk HPV by in situ hybridization: Detected
Lymphovascular Invasion: Present
Perineural Invasion: Not identified
Margins: Uninvolved by invasive carcinoma
Number of Lymph Nodes Examined: 28
Number of Lymph Nodes Involved: 3
Laterality: Right
Size of Largest Metastatic Deposit: 2.4 cm
Extranodal Extension: Present, greater than 2 mm (ENEma)
`;

const LARYNX_REPORT = `
SYNOPTIC REPORT (synthetic)
Procedure: Total laryngectomy with bilateral selective neck dissection
Tumor Site: Supraglottic larynx, false cord and epiglottis
Histologic Type: Squamous cell carcinoma, keratinizing
Tumor Size: Greatest dimension: 4.4 cm
Tumor Extension: Tumor invades the pre-epiglottic space and the paraglottic space
Thyroid Cartilage Invasion: Present, inner cortex only
Perineural Invasion: Present
Lymphovascular Invasion: Present
Margins: Distance from invasive carcinoma to closest margin: 3 mm
Number of Lymph Nodes Examined: 42
Number of Lymph Nodes Involved: 1
Laterality: Right
Size of Largest Metastatic Deposit: 2.1 cm
Extranodal Extension: Not identified
`;

const PAROTID_REPORT = `
SYNOPTIC REPORT (synthetic)
Procedure: Right total parotidectomy with modified radical neck dissection
Tumor Site: Right parotid gland, deep and superficial lobes
Histologic Type: Salivary duct carcinoma
Tumor Size: Greatest dimension: 3.6 cm
Extraparenchymal Extension: Present
Perineural Invasion: Present, involving a named nerve, main trunk of the facial nerve
Lymphovascular Invasion: Present
Margins: Invasive carcinoma: Involved
Number of Lymph Nodes Examined: 21
Number of Lymph Nodes Involved: 4
Laterality: Right
Size of Largest Metastatic Deposit: 3.2 cm
Extranodal Extension: Present, less than or equal to 2 mm (ENEmi)
`;

const THYROID_REPORT = `
SYNOPTIC REPORT (synthetic)
Procedure: Total thyroidectomy with central compartment neck dissection
Tumor Site: Thyroid gland, right lobe
Histologic Type: Papillary thyroid carcinoma, classic type
Tumor Size: Greatest dimension: 4.6 cm
Extrathyroidal Extension: Present, gross, into strap muscles, sternothyroid
Margins: Uninvolved
Number of Lymph Nodes Examined: 11
Number of Lymph Nodes Involved: 3
Level VI: 3/11
Laterality: Right
Size of Largest Metastatic Deposit: 0.9 cm
Extranodal Extension: Not identified
`;

const SCALP_SCC_REPORT = `
SYNOPTIC REPORT (synthetic)
Procedure: Wide local excision of scalp lesion with parotidectomy and neck dissection
Tumor Site: Skin of the right posterior scalp
Histologic Type: Squamous cell carcinoma, moderately differentiated
Tumor Size: Greatest dimension: 3.4 cm
Tumor Thickness: 9 mm
Perineural Invasion: Present, nerve calibre 0.4 mm
Lymphovascular Invasion: Not identified
Bone Invasion: Not identified
Margins: Distance from invasive carcinoma to closest peripheral margin: 6 mm
Number of Lymph Nodes Examined: 19
Number of Lymph Nodes Involved: 1
Laterality: Right
Size of Largest Metastatic Deposit: 2.2 cm
Extranodal Extension: Present, greater than 2 mm (ENEma)
`;

describe('CAP synoptic parser', () => {
  it('parses an oral tongue report and reproduces the reported pT2 pN2b', () => {
    const r = parseCapReport(ORAL_TONGUE_REPORT);
    expect(r.site).toBe('oral_cavity');
    expect(r.input.primary?.size_cm).toEqual({ value: 2.7, source: 'pathology' });
    expect(r.input.primary?.depth_of_invasion_mm).toEqual({ value: 6, source: 'pathology' });
    expect(r.input.nodes?.count_examined).toEqual({ value: 34, source: 'pathology' });
    expect(r.input.nodes?.count_positive).toEqual({ value: 2, source: 'pathology' });
    expect(r.input.nodes?.largest_metastasis_cm).toEqual({ value: 1.8, source: 'pathology' });
    expect(r.reportedStage).toContain('pT2');
    const staged = stage('oral_cavity', r.input);
    expect([staged.pathologic?.T, staged.pathologic?.N]).toEqual(['T2', 'N2b']);
    expect(staged.pathologic?.group).toBe('IVA');
  });

  it('records perineural invasion, margin distance and the absence of bone invasion', () => {
    const r = parseCapReport(ORAL_TONGUE_REPORT);
    expect(r.fields.find((f) => f.field === 'primary.perineural_invasion')?.value).toBe(true);
    expect(r.fields.find((f) => f.field === 'pathology.closest_margin_mm')?.value).toBe(4);
    expect(r.input.primary?.cortical_bone_invasion).toEqual(
      expect.objectContaining({ value: false, source: 'pathology' }),
    );
  });

  it('returns unparsed lines rather than dropping them', () => {
    const r = parseCapReport(ORAL_TONGUE_REPORT);
    expect(r.unparsed.some((l) => l.startsWith('Histologic Grade'))).toBe(true);
    expect(r.unparsed.some((l) => l.startsWith('Tumor Size'))).toBe(false);
  });

  it('parses a p16-positive tonsil report into the HPV-mediated chapter', () => {
    const r = parseCapReport(TONSIL_P16_REPORT);
    expect(r.site).toBe('oropharynx_p16pos');
    expect(r.input.patient?.p16).toBe('positive');
    expect(r.input.patient?.hpv).toBe('positive');
    expect(r.input.nodes?.ene_present?.valueOf()).toBeTruthy();
    const staged = stage('oropharynx_p16pos', r.input);
    // 3 positive nodes: pN1 in this chapter, ENE is not used.
    expect([staged.pathologic?.T, staged.pathologic?.N, staged.pathologic?.group]).toEqual([
      'T2',
      'N1',
      'I',
    ]);
  });

  it('prefers the tumour site line over the specimen line for the laryngeal subsite', () => {
    const r = parseCapReport(LARYNX_REPORT);
    expect(r.site).toBe('larynx_supraglottic');
    expect(r.input.primary?.size_cm).toEqual({ value: 4.4, source: 'pathology' });
    expect(r.unparsed.some((l) => l.startsWith('Thyroid Cartilage Invasion'))).toBe(true);
  });

  it('parses a parotid report: pT3 with ENEmi in four nodes is pN3b, stage IVB', () => {
    const r = parseCapReport(PAROTID_REPORT);
    expect(r.site).toBe('major_salivary');
    expect(r.input.primary?.extraparenchymal_extension).toEqual(
      expect.objectContaining({ value: true, source: 'pathology' }),
    );
    expect(r.input.nodes?.ene_extent_mm).toEqual({ value: 2, source: 'pathology' });
    const staged = stage('major_salivary', r.input);
    expect([staged.pathologic?.T, staged.pathologic?.N, staged.pathologic?.group]).toEqual([
      'T3',
      'N3b',
      'IVB',
    ]);
  });

  it('parses a thyroid report: gross ETE into strap muscles is pT3b with level VI nodes pN1a', () => {
    const r = parseCapReport(THYROID_REPORT);
    expect(r.site).toBe('thyroid_differentiated');
    expect(r.input.primary?.strap_muscle_invasion).toEqual(
      expect.objectContaining({ value: true, source: 'pathology' }),
    );
    expect(r.input.nodes?.central_compartment_nodes).toEqual(
      expect.objectContaining({ value: true, source: 'pathology' }),
    );
    const withAge: StagingInput = { ...r.input, patient: { ...r.input.patient, age: 62 } };
    const staged = stage('thyroid_differentiated', withAge);
    expect([staged.pathologic?.T, staged.pathologic?.N, staged.pathologic?.group]).toEqual([
      'T3b',
      'N1a',
      'II',
    ]);
  });

  it('parses a scalp SCC report: perineural invasion of a 0.4 mm nerve is pT3', () => {
    const r = parseCapReport(SCALP_SCC_REPORT);
    expect(r.site).toBe('cutaneous_scc_hn');
    expect(r.input.primary?.perineural_nerve_calibre_mm).toEqual({ value: 0.4, source: 'pathology' });
    expect(r.input.primary?.dermal_invasion_depth_mm).toEqual({ value: 9, source: 'pathology' });
    const staged = stage('cutaneous_scc_hn', r.input);
    expect([staged.pathologic?.T, staged.pathologic?.N, staged.pathologic?.group]).toEqual([
      'T3',
      'N2a',
      'IV',
    ]);
  });

  it('a pasted report alone gives a pathologic classification and an explicitly unknown clinical one', () => {
    const r = parseCapReport(ORAL_TONGUE_REPORT);
    const staged = stage('oral_cavity', r.input);
    expect(staged.clinical.T).toBe('TX');
    expect(staged.clinical.N).toBe('NX');
    expect(staged.pathologic?.T).toBe('T2');
  });

  it('infers N0 from a negative neck dissection', () => {
    const r = parseCapReport(`
Tumor Site: Right buccal mucosa
Tumor Size: Greatest dimension: 1.4 cm
Depth of Invasion: 3 mm
Number of Lymph Nodes Examined: 26
Extranodal Extension: Not identified
`);
    expect(r.input.nodes?.count_positive).toEqual({ value: 0, source: 'pathology' });
    const staged = stage('oral_cavity', r.input);
    expect([staged.pathologic?.T, staged.pathologic?.N, staged.pathologic?.group]).toEqual([
      'T1',
      'N0',
      'I',
    ]);
  });
});

/* ================================================================== */
/* 13. module invariants                                               */
/* ================================================================== */

describe('module invariants', () => {
  it('every site has a rule module', () => {
    for (const site of SITES) {
      expect(SITE_RULES[site]).toBeDefined();
      expect(SITE_RULES[site].site).toBe(site);
    }
  });

  it('every rule id a site claims exists in the rule table', () => {
    const ids = new Set(RULE_TABLE.map((r) => r.id));
    for (const site of SITES) {
      for (const id of SITE_RULES[site].ruleIds) {
        expect(ids.has(id), `${site} references unknown rule ${id}`).toBe(true);
      }
    }
  });

  it("every rule marked 'verify' explains why", () => {
    for (const entry of rulesToVerify()) {
      expect(entry.note, `${entry.id} has no note`).toBeTruthy();
    }
  });

  it('every classification carries a trace that names the site and the categories', () => {
    const r = stage('oral_cavity', {
      primary: { size_cm: img(3.2), depth_of_invasion_mm: img(7) },
      nodes: { nodes: [{ side: 'ipsilateral', size_cm: img(2.1) }] },
    });
    expect(r.clinical.trace[0]).toContain('Lip and oral cavity');
    expect(r.clinical.trace.join(' | ')).toContain('cT2');
    expect(r.clinical.trace.join(' | ')).toContain('cN1');
    expect(r.clinical.trace.join(' | ')).toContain('Stage III');
  });
});
