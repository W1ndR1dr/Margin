/**
 * The rule table: one row per staging rule this engine implements, with the
 * source it was taken from and a confidence marker.
 *
 * `confidence: 'verify'` means the rule has NOT been confirmed against the
 * printed AJCC Cancer Staging Manual, 8th edition, or that published summaries
 * disagree. Those rules still run — the engine never silently guesses — but
 * `stage()` surfaces them so the surgeon knows which line of the trace to
 * check. Anything marked `'high'` was cross-checked against at least one of the
 * AJCC-published sources below.
 *
 * Sources (all public, none behind a licence):
 *   AJCC-P2P   AJCC "Physician to Physician, 8th Edition, Head and Neck"
 *              (W.M. Lydiatt), American College of Surgeons.
 *              https://www.facs.org/media/i2kn34ed/head-and-neck-8th-ed.pdf
 *   AJCC-WEB   AJCC "8th Edition Staging — Head & Neck Staging" webinar
 *              (D.M. Gress), including the oral cavity "before / after
 *              correction" T table and the ENE criteria.
 *              https://www.facs.org/media/flipxyxh/8th-edition_headneck-staging.pdf
 *   LYDIATT17  Lydiatt WM et al. "Head and neck cancers — major changes in the
 *              AJCC eighth edition cancer staging manual." CA Cancer J Clin
 *              2017;67:122-137. https://doi.org/10.3322/caac.21389
 *   TUTTLE17   Tuttle RM, Haugen B, Perrier ND. "Updated AJCC/TNM staging
 *              system for differentiated and anaplastic thyroid cancer (8th
 *              edition)." Thyroid 2017. https://doi.org/10.1089/thy.2017.0102
 *   CALIFANO   Califano JA et al. Cutaneous SCC of the head and neck, in AJCC
 *              Cancer Staging Manual 8th ed., pp. 171-181 (as reproduced with
 *              ACS permission on the BWH/AJCC-8 staging card).
 *   CAP        College of American Pathologists cancer protocols, head & neck
 *              (synoptic field names used by `capParser`).
 *              https://documents.cap.org/protocols/
 */

import type { Site } from '../types';

export type RuleConfidence = 'high' | 'verify';

export interface RuleEntry {
  /** Stable id, referenced from the rule modules as `rule:<id>`. */
  id: string;
  site: Site | 'all';
  category: 'T' | 'N' | 'M' | 'group' | 'parser';
  statement: string;
  source: string;
  confidence: RuleConfidence;
  /** Why it is marked `verify`, or what the caveat is. */
  note?: string;
}

export const SOURCES: Record<string, string> = {
  'AJCC-P2P': 'https://www.facs.org/media/i2kn34ed/head-and-neck-8th-ed.pdf',
  'AJCC-WEB': 'https://www.facs.org/media/flipxyxh/8th-edition_headneck-staging.pdf',
  LYDIATT17: 'https://doi.org/10.3322/caac.21389',
  TUTTLE17: 'https://doi.org/10.1089/thy.2017.0102',
  CALIFANO: 'AJCC Cancer Staging Manual, 8th ed., ch. 15 (cutaneous SCC of head and neck)',
  CAP: 'https://documents.cap.org/protocols/',
  AJCC8: 'AJCC Cancer Staging Manual, 8th ed. (Amin MB et al., Springer 2017)',
};

export const RULE_TABLE: RuleEntry[] = [
  /* ---------------- shared ---------------- */
  {
    id: 'common.N.clinical',
    site: 'all',
    category: 'N',
    statement:
      'cN1 single ipsilateral <= 3 cm ENE(-); cN2a single ipsilateral > 3 cm and <= 6 cm ENE(-); ' +
      'cN2b multiple ipsilateral <= 6 cm ENE(-); cN2c bilateral or contralateral <= 6 cm ENE(-); ' +
      'cN3a any node > 6 cm ENE(-); cN3b any node(s) with clinically overt ENE(+).',
    source: 'AJCC-WEB, LYDIATT17',
    confidence: 'high',
  },
  {
    id: 'common.N.pathologic',
    site: 'all',
    category: 'N',
    statement:
      'pN1 single ipsilateral <= 3 cm ENE(-); pN2a single ipsilateral <= 3 cm ENE(+) or ' +
      '> 3 cm and <= 6 cm ENE(-); pN2b multiple ipsilateral <= 6 cm ENE(-); pN2c bilateral or ' +
      'contralateral <= 6 cm ENE(-); pN3a > 6 cm ENE(-); pN3b single ipsilateral > 3 cm ENE(+), ' +
      'or multiple nodes any ENE(+), or a single contralateral node of any size ENE(+).',
    source: 'AJCC-WEB, LYDIATT17',
    confidence: 'high',
    note:
      'Equivalent to the AJCC statement "pathologic ENE(+) increases the N category by one full ' +
      'step". Both ENEmi (<= 2 mm) and ENEma (> 2 mm) count as ENE(+).',
  },
  {
    id: 'common.N.ene_extent',
    site: 'all',
    category: 'N',
    statement:
      'ENEmi is extension <= 2 mm beyond the capsule, ENEma > 2 mm or grossly apparent. Both are ' +
      'ENE(+) for pN; the distinction is recorded, not staged. If in doubt, assign ENE(-).',
    source: 'AJCC-WEB',
    confidence: 'high',
  },
  {
    id: 'common.N.clinical_ene_definition',
    site: 'all',
    category: 'N',
    statement:
      'Clinical ENE(+) requires unambiguous gross ENE on examination (skin invasion, infiltration ' +
      'of musculature, dense tethering, nerve invasion with dysfunction), supported by imaging. ' +
      'Radiographic evidence alone is insufficient.',
    source: 'AJCC-WEB',
    confidence: 'high',
  },
  {
    id: 'common.group.standard',
    site: 'all',
    category: 'group',
    statement:
      'Stage 0 Tis N0; I T1 N0; II T2 N0; III T3 N0 or T1-T3 N1; IVA T4a N0-N1 or T1-T4a N2; ' +
      'IVB T4b any N or any T N3; IVC any T any N M1.',
    source: 'AJCC8, LYDIATT17',
    confidence: 'high',
  },

  /* ---------------- oral cavity ---------------- */
  {
    id: 'oral.T.grid',
    site: 'oral_cavity',
    category: 'T',
    statement:
      'Corrected AJCC 8 size x DOI grid: T1 <= 2 cm and DOI <= 5 mm; T2 <= 2 cm with DOI > 5 mm, ' +
      'or > 2-4 cm with DOI <= 10 mm; T3 > 2-4 cm with DOI > 10 mm, or > 4 cm with DOI <= 10 mm; ' +
      'T4a > 4 cm with DOI > 10 mm.',
    source: 'AJCC-WEB (slide "Oral Cavity Change Highlights", after-correction column)',
    confidence: 'verify',
    note:
      'AJCC 8 was printed with a different oral cavity T table and corrected twice. The ORIGINAL ' +
      'printing (still reproduced by many summaries and by AJCC-P2P) reads: T2 <= 2 cm with DOI ' +
      '> 5 and <= 10 mm, or > 2-4 cm with DOI <= 10 mm; T3 > 4 cm OR any tumour with DOI > 10 mm. ' +
      'This engine implements the CORRECTED table and warns whenever the two disagree for the ' +
      'case in hand. The corrected table also leaves a tumour <= 2 cm with DOI > 10 mm as T2, ' +
      'which is the literal reading but is the cell least likely to be intended.',
  },
  {
    id: 'oral.T.t4a',
    site: 'oral_cavity',
    category: 'T',
    statement:
      'T4a (moderately advanced local disease): invasion through the cortical bone of the mandible ' +
      'or maxilla, or involvement of the maxillary sinus or the skin of the face.',
    source: 'AJCC-WEB, AJCC-P2P',
    confidence: 'high',
  },
  {
    id: 'oral.T.t4b',
    site: 'oral_cavity',
    category: 'T',
    statement:
      'T4b (very advanced local disease): invasion of the masticator space, pterygoid plates or ' +
      'skull base, and/or encasement of the internal carotid artery.',
    source: 'AJCC8',
    confidence: 'high',
  },
  {
    id: 'oral.T.gingival_exception',
    site: 'oral_cavity',
    category: 'T',
    statement:
      'Superficial erosion of bone or a tooth socket alone by a gingival primary is not sufficient ' +
      'to classify a tumour as T4.',
    source: 'AJCC8',
    confidence: 'high',
  },
  {
    id: 'oral.T.extrinsic_muscle',
    site: 'oral_cavity',
    category: 'T',
    statement:
      'Extrinsic tongue muscle infiltration was removed as a T4 criterion in AJCC 8; DOI supersedes it.',
    source: 'AJCC-P2P',
    confidence: 'high',
  },

  /* ---------------- oropharynx p16+ ---------------- */
  {
    id: 'op16.T',
    site: 'oropharynx_p16pos',
    category: 'T',
    statement:
      'T0 no primary identified; T1 <= 2 cm; T2 > 2-4 cm; T3 > 4 cm or extension to the lingual ' +
      'surface of the epiglottis; T4 invasion of the larynx, extrinsic tongue muscle, medial ' +
      'pterygoid, hard palate or mandible, or beyond. There is no Tis and no T4b in this chapter.',
    source: 'AJCC-P2P, LYDIATT17',
    confidence: 'high',
  },
  {
    id: 'op16.N.clinical',
    site: 'oropharynx_p16pos',
    category: 'N',
    statement:
      'cN1 unilateral node(s) <= 6 cm; cN2 contralateral or bilateral node(s) <= 6 cm; cN3 node(s) ' +
      '> 6 cm. ENE is not part of this N category.',
    source: 'AJCC-P2P, LYDIATT17',
    confidence: 'high',
  },
  {
    id: 'op16.N.pathologic',
    site: 'oropharynx_p16pos',
    category: 'N',
    statement: 'pN1 <= 4 positive nodes; pN2 > 4 positive nodes.',
    source: 'AJCC-P2P, LYDIATT17',
    confidence: 'high',
  },
  {
    id: 'op16.group.clinical',
    site: 'oropharynx_p16pos',
    category: 'group',
    statement:
      'Clinical: I T0-T2 N0-N1; II T0-T2 N2 or T3 N0-N2; III T4 any N or any T N3; IV M1.',
    source: 'AJCC-P2P (clinical TNM stage grouping grid)',
    confidence: 'high',
  },
  {
    id: 'op16.group.pathologic',
    site: 'oropharynx_p16pos',
    category: 'group',
    statement: 'Pathologic: I T0-T2 N0-N1; II T0-T2 N2 or T3-T4 N0-N1; III T3-T4 N2; IV M1.',
    source: 'AJCC-P2P (pathological TNM stage grouping grid)',
    confidence: 'high',
  },

  /* ---------------- oropharynx p16- ---------------- */
  {
    id: 'op16neg.T',
    site: 'oropharynx_p16neg',
    category: 'T',
    statement:
      'Tis; T1 <= 2 cm; T2 > 2-4 cm; T3 > 4 cm or extension to the lingual surface of the ' +
      'epiglottis; T4a larynx, extrinsic tongue muscle, medial pterygoid, hard palate or mandible; ' +
      'T4b lateral pterygoid muscle, pterygoid plates, lateral nasopharynx, skull base, or carotid ' +
      'encasement. There is no T0 in this chapter.',
    source: 'AJCC8, AJCC-P2P',
    confidence: 'high',
  },

  /* ---------------- hypopharynx ---------------- */
  {
    id: 'hypo.T',
    site: 'hypopharynx',
    category: 'T',
    statement:
      'T1 limited to one subsite and/or <= 2 cm; T2 more than one subsite or an adjacent site, or ' +
      '> 2-4 cm, without fixation of hemilarynx; T3 > 4 cm, or fixation of hemilarynx, or ' +
      'extension to oesophageal mucosa; T4a thyroid/cricoid cartilage, hyoid, thyroid gland, ' +
      'oesophageal muscle or central compartment soft tissue; T4b prevertebral fascia, carotid ' +
      'encasement or mediastinal structures.',
    source: 'AJCC8',
    confidence: 'verify',
    note:
      'AJCC 8 uses "fixation of hemilarynx" for T2/T3 where the 7th edition used "impaired vocal ' +
      'cord mobility", and several public summaries still quote the 7th-edition wording. The ' +
      'engine uses hemilarynx fixation and falls back to vocal cord fixation when only that is given.',
  },

  /* ---------------- larynx ---------------- */
  {
    id: 'lar.supraglottic.T',
    site: 'larynx_supraglottic',
    category: 'T',
    statement:
      'T1 one subsite, normal cord mobility; T2 mucosa of more than one adjacent supraglottic ' +
      'subsite or of the glottis or a region outside the supraglottis, without laryngeal fixation; ' +
      'T3 limited to larynx with vocal cord fixation and/or postcricoid, pre-epiglottic or ' +
      'paraglottic space or inner cortex of thyroid cartilage; T4a through the outer cortex of the ' +
      'thyroid cartilage and/or beyond the larynx; T4b prevertebral space, carotid encasement or ' +
      'mediastinal structures.',
    source: 'AJCC8',
    confidence: 'high',
  },
  {
    id: 'lar.glottic.T',
    site: 'larynx_glottic',
    category: 'T',
    statement:
      'T1 limited to the vocal cord(s) with normal mobility (T1a one cord, T1b both cords); T2 ' +
      'extends to supraglottis and/or subglottis and/or impaired cord mobility; T3 limited to ' +
      'larynx with cord fixation and/or paraglottic space and/or inner cortex of thyroid ' +
      'cartilage; T4a through the thyroid cartilage and/or beyond the larynx; T4b prevertebral ' +
      'space, carotid encasement or mediastinal structures.',
    source: 'AJCC8',
    confidence: 'high',
  },
  {
    id: 'lar.subglottic.T',
    site: 'larynx_subglottic',
    category: 'T',
    statement:
      'T1 limited to the subglottis; T2 extends to the vocal cord(s) with normal or impaired ' +
      'mobility; T3 limited to larynx with cord fixation and/or paraglottic space and/or inner ' +
      'cortex of thyroid cartilage; T4a through the cricoid or thyroid cartilage and/or beyond the ' +
      'larynx; T4b prevertebral space, carotid encasement or mediastinal structures.',
    source: 'AJCC8',
    confidence: 'high',
  },

  /* ---------------- nasopharynx ---------------- */
  {
    id: 'npx.T',
    site: 'nasopharynx',
    category: 'T',
    statement:
      'T0 no tumour identified but EBV-positive cervical node; T1 nasopharynx, oropharynx or nasal ' +
      'cavity without parapharyngeal involvement; T2 parapharyngeal extension and/or adjacent soft ' +
      'tissue (medial pterygoid, lateral pterygoid, prevertebral muscles); T3 bony structures of ' +
      'the skull base, cervical vertebra, pterygoid structures and/or paranasal sinuses; T4 ' +
      'intracranial extension, cranial nerve involvement, hypopharynx, orbit, parotid gland and/or ' +
      'soft tissue infiltration beyond the lateral surface of the lateral pterygoid muscle.',
    source: 'AJCC-P2P, LYDIATT17',
    confidence: 'high',
  },
  {
    id: 'npx.N',
    site: 'nasopharynx',
    category: 'N',
    statement:
      'N1 unilateral cervical and/or unilateral or bilateral retropharyngeal node(s) <= 6 cm above ' +
      'the caudal border of the cricoid; N2 bilateral cervical node(s) <= 6 cm above the cricoid; ' +
      'N3 node(s) > 6 cm and/or extension below the caudal border of the cricoid. N3a and N3b were ' +
      'merged into N3 in the 8th edition.',
    source: 'AJCC-P2P, LYDIATT17',
    confidence: 'high',
  },
  {
    id: 'npx.group',
    site: 'nasopharynx',
    category: 'group',
    statement:
      '0 Tis N0; I T1 N0; II T0-T1 N1 or T2 N0-N1; III T0-T2 N2 or T3 N0-N2; IVA T4 N0-N2 or any ' +
      'T N3; IVB M1.',
    source: 'AJCC8',
    confidence: 'high',
  },

  /* ---------------- major salivary ---------------- */
  {
    id: 'sal.T',
    site: 'major_salivary',
    category: 'T',
    statement:
      'T0 no primary identified (salivary histology in a node); T1 <= 2 cm without ' +
      'extraparenchymal extension; T2 > 2-4 cm without extraparenchymal extension; T3 > 4 cm ' +
      'and/or extraparenchymal extension; T4a skin, mandible, ear canal and/or facial nerve; ' +
      'T4b skull base and/or pterygoid plates and/or carotid encasement.',
    source: 'AJCC8',
    confidence: 'high',
    note:
      'Extraparenchymal extension means clinical or macroscopic soft-tissue invasion; microscopic ' +
      'evidence alone does not count.',
  },

  /* ---------------- nasal cavity / paranasal sinus ---------------- */
  {
    id: 'sinus.maxillary.T',
    site: 'nasal_cavity_paranasal',
    category: 'T',
    statement:
      'Maxillary sinus: T1 mucosa only, no bone erosion; T2 bone erosion or destruction including ' +
      'the hard palate and/or middle nasal meatus, except the posterior wall and pterygoid plates; ' +
      'T3 posterior bony wall, subcutaneous tissues, floor or medial wall of orbit, pterygoid ' +
      'fossa or ethmoid sinuses; T4a anterior orbital contents, skin of cheek, pterygoid plates, ' +
      'infratemporal fossa, cribriform plate, sphenoid or frontal sinuses; T4b orbital apex, dura, ' +
      'brain, middle cranial fossa, cranial nerves other than V2, nasopharynx or clivus.',
    source: 'AJCC8',
    confidence: 'verify',
    note: 'Transcribed from the 8th edition tables but not re-checked against the printed manual.',
  },
  {
    id: 'sinus.nasoethmoid.T',
    site: 'nasal_cavity_paranasal',
    category: 'T',
    statement:
      'Nasal cavity and ethmoid sinus: T1 restricted to any one subsite, with or without bony ' +
      'invasion; T2 two subsites in a single region or extension to an adjacent region within the ' +
      'nasoethmoidal complex, with or without bony invasion; T3 medial wall or floor of the orbit, ' +
      'maxillary sinus, palate or cribriform plate; T4a anterior orbital contents, skin of nose or ' +
      'cheek, minimal extension to the anterior cranial fossa, pterygoid plates, sphenoid or ' +
      'frontal sinuses; T4b orbital apex, dura, brain, middle cranial fossa, cranial nerves other ' +
      'than V2, nasopharynx or clivus.',
    source: 'AJCC8',
    confidence: 'verify',
    note: 'Transcribed from the 8th edition tables but not re-checked against the printed manual.',
  },

  /* ---------------- thyroid ---------------- */
  {
    id: 'thy.T',
    site: 'thyroid_differentiated',
    category: 'T',
    statement:
      'T1a <= 1 cm; T1b > 1-2 cm; T2 > 2-4 cm, all limited to the thyroid; T3a > 4 cm limited to ' +
      'the thyroid; T3b gross extrathyroidal extension into strap muscles only, any size; T4a ' +
      'gross ETE into subcutaneous soft tissue, larynx, trachea, oesophagus or recurrent laryngeal ' +
      'nerve; T4b gross ETE into prevertebral fascia, or encasing the carotid artery or ' +
      'mediastinal vessels. Anaplastic carcinoma uses the same T definitions in the 8th edition.',
    source: 'TUTTLE17',
    confidence: 'high',
  },
  {
    id: 'thy.N',
    site: 'thyroid_differentiated',
    category: 'N',
    statement:
      'N1a metastasis to level VI or VII (pretracheal, paratracheal, prelaryngeal/Delphian or ' +
      'upper mediastinal), unilateral or bilateral; N1b metastasis to unilateral, bilateral or ' +
      'contralateral lateral neck (levels I-V) or retropharyngeal nodes.',
    source: 'TUTTLE17',
    confidence: 'high',
  },
  {
    id: 'thy.group.diff',
    site: 'thyroid_differentiated',
    category: 'group',
    statement:
      'Differentiated, age < 55 at diagnosis: I any T any N M0; II any T any N M1. Age >= 55: ' +
      'I T1-T2 N0/NX; II T1-T2 N1 or T3a/T3b any N; III T4a any N; IVA T4b any N; IVB M1.',
    source: 'TUTTLE17',
    confidence: 'high',
    note: 'The age cut-off moved from 45 to 55 years in the 8th edition.',
  },
  {
    id: 'thy.group.medullary',
    site: 'thyroid_medullary',
    category: 'group',
    statement:
      'Medullary (no age cut-off): I T1 N0; II T2-T3 N0; III T1-T3 N1a; IVA T4a any N or T1-T3 ' +
      'N1b; IVB T4b any N; IVC M1.',
    source: 'AJCC8',
    confidence: 'verify',
    note:
      'The T1-T3 N1a = III and T1-T3 N1b = IVA split is from the 8th edition medullary table; not ' +
      're-checked against the printed manual.',
  },
  {
    id: 'thy.group.anaplastic',
    site: 'thyroid_anaplastic',
    category: 'group',
    statement:
      'Anaplastic (all stage IV): IVA T1-T3a N0/NX; IVB T1-T3a N1, or T3b any N, or T4 any N; ' +
      'IVC M1.',
    source: 'TUTTLE17',
    confidence: 'high',
  },

  /* ---------------- cutaneous SCC ---------------- */
  {
    id: 'cut.T',
    site: 'cutaneous_scc_hn',
    category: 'T',
    statement:
      'T1 <= 2 cm; T2 > 2-4 cm; T3 > 4 cm, or minor (non-cortical) bone erosion, or perineural ' +
      'invasion, or deep invasion (> 6 mm thickness or invasion beyond the subcutaneous fat); ' +
      'T4a gross cortical bone or marrow invasion; T4b skull base invasion and/or skull base ' +
      'foramen involvement.',
    source: 'CALIFANO',
    confidence: 'high',
  },
  {
    id: 'cut.T.pni',
    site: 'cutaneous_scc_hn',
    category: 'T',
    statement:
      'Perineural invasion for T3 means tumour cells within the nerve sheath of a nerve lying ' +
      'deeper than the dermis, or a nerve of >= 0.1 mm calibre, or clinical / radiographic ' +
      'involvement of a named nerve.',
    source: 'CALIFANO',
    confidence: 'verify',
    note:
      'The 0.1 mm calibre threshold and the "deeper than dermis" alternative are widely quoted but ' +
      'have not been re-checked word for word against the printed chapter.',
  },
  {
    id: 'cut.N',
    site: 'cutaneous_scc_hn',
    category: 'N',
    statement: 'The head & neck nodal table with ENE, as for the mucosal sites.',
    source: 'CALIFANO, AJCC-P2P',
    confidence: 'verify',
    note:
      'The AJCC-8 cutaneous chapter is presented in some summaries as a single merged N1/N2/N3 ' +
      'table (N2 = single ipsilateral <= 3 cm ENE(+) OR > 3-6 cm ENE(-) OR multiple <= 6 cm ' +
      'ENE(-)) rather than as separate clinical and pathologic tables with a/b/c subdivisions. ' +
      'This engine uses the mucosal clinical/pathologic pair and reports subcategories; the merged ' +
      'presentation gives the same major category in every case the tests cover.',
  },
  {
    id: 'cut.group',
    site: 'cutaneous_scc_hn',
    category: 'group',
    statement:
      'I T1 N0; II T2 N0; III T3 N0 or T1-T3 N1; IV T4 any N, or T1-T3 N2-N3, or M1.',
    source: 'CALIFANO',
    confidence: 'high',
  },

  /* ---------------- unknown primary ---------------- */
  {
    id: 'unk.T',
    site: 'unknown_primary',
    category: 'T',
    statement:
      'Cervical nodes with an unidentified head & neck primary are staged T0 in the cervical nodes ' +
      'chapter. p16 and EBER decide the chapter: p16(+) goes to HPV-mediated oropharynx, EBER(+) ' +
      'to nasopharynx, and EBER(-)/p16(-) stays here. The physician may not choose a primary site.',
    source: 'AJCC-WEB, AJCC-P2P',
    confidence: 'high',
  },
  {
    id: 'unk.group',
    site: 'unknown_primary',
    category: 'group',
    statement: 'III T0 N1; IVA T0 N2; IVB T0 N3; IVC M1.',
    source: 'AJCC-WEB (worked example: cT0 cN1 cM0 = clinical stage III)',
    confidence: 'verify',
    note:
      'The stage III / IVA / IVB mapping follows the standard head & neck grouping with T0 treated ' +
      'as T1-T3; only the N1 = stage III cell is directly confirmed by the AJCC worked example.',
  },

  /* ---------------- mucosal melanoma ---------------- */
  {
    id: 'mm.T',
    site: 'mucosal_melanoma_hn',
    category: 'T',
    statement:
      'Staging begins at T3. T3 tumour limited to the mucosa and immediately underlying soft ' +
      'tissue regardless of thickness or greatest dimension; T4a deep soft tissue, cartilage, bone ' +
      'or overlying skin; T4b brain, dura, skull base, lower cranial nerves (IX, X, XI, XII), ' +
      'masticator space, carotid artery, prevertebral space or mediastinal structures.',
    source: 'AJCC8',
    confidence: 'verify',
    note:
      'At least one published summary puts the lower cranial nerves, masticator space, carotid, ' +
      'prevertebral space and mediastinal structures in T4a rather than T4b. This engine follows ' +
      'the assignment above (those structures are T4b).',
  },
  {
    id: 'mm.N',
    site: 'mucosal_melanoma_hn',
    category: 'N',
    statement: 'N0 no regional node metastasis; N1 regional node metastasis present. ENE is not used.',
    source: 'AJCC8',
    confidence: 'high',
  },
  {
    id: 'mm.group',
    site: 'mucosal_melanoma_hn',
    category: 'group',
    statement: 'III T3 N0; IVA T4a N0 or T3-T4a N1; IVB T4b any N; IVC M1.',
    source: 'AJCC8',
    confidence: 'high',
  },

  /* ---------------- parser ---------------- */
  {
    id: 'parser.cap',
    site: 'all',
    category: 'parser',
    statement:
      'Tolerant regexes over CAP synoptic field labels (Tumor Size, Depth of Invasion, Perineural ' +
      'Invasion, Lymphovascular Invasion, Margins, Number of Lymph Nodes Examined / Involved, ' +
      'Extranodal Extension, Size of Largest Metastatic Deposit, Laterality, p16, HPV, ' +
      'Extrathyroidal Extension, Histologic Type). Everything parsed is tagged source "pathology".',
    source: 'CAP',
    confidence: 'verify',
    note:
      'CAP protocol wording changes between versions; the parser matches the common phrasings and ' +
      'returns every line it could not interpret so nothing is silently dropped.',
  },
];

const BY_ID = new Map(RULE_TABLE.map((r) => [r.id, r]));

export function rule(id: string): RuleEntry | undefined {
  return BY_ID.get(id);
}

/** Rules that still need checking against the printed manual. */
export function rulesToVerify(): RuleEntry[] {
  return RULE_TABLE.filter((r) => r.confidence === 'verify');
}

/** Source citations for a set of rule ids, de-duplicated and stable-ordered. */
export function sourcesFor(ruleIds: string[]): string[] {
  const keys: string[] = [];
  for (const id of ruleIds) {
    const entry = BY_ID.get(id);
    if (!entry) continue;
    for (const key of entry.source.split(',').map((s) => s.trim())) {
      const bare = key.replace(/\s*\(.*\)\s*$/, '');
      if (bare && !keys.includes(bare)) keys.push(bare);
    }
  }
  return keys.map((k) => (SOURCES[k] ? `${k} — ${SOURCES[k]}` : k));
}
