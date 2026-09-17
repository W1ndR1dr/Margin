/**
 * Margin staging engine — shared types.
 *
 * AJCC Cancer Staging Manual, 8th edition, head & neck chapters. Pure
 * TypeScript: no React, no Cornerstone, no DOM, no network. Every rule that is
 * implemented has an entry in `rules/ruleTable.ts` with a source and a
 * confidence marker; anything marked `'verify'` there has not been confirmed
 * against the printed manual and must be checked before it is trusted.
 *
 * Nothing in this module is a clinical decision. It restates a published
 * classification from the descriptors it is given, and shows its work.
 */

/* ------------------------------------------------------------------ */
/* sites                                                               */
/* ------------------------------------------------------------------ */

/**
 * One value per AJCC 8 head & neck staging chapter, plus the subsite splits
 * that carry their own T table. `oropharynx_p16pos` is chapter 10
 * (HPV-mediated), `oropharynx_p16neg` shares chapter 11 with the hypopharynx,
 * and `unknown_primary` is chapter 6 (cervical nodes, EBER- and p16-).
 */
export type Site =
  | 'oral_cavity'
  | 'oropharynx_p16pos'
  | 'oropharynx_p16neg'
  | 'hypopharynx'
  | 'larynx_supraglottic'
  | 'larynx_glottic'
  | 'larynx_subglottic'
  | 'nasopharynx'
  | 'major_salivary'
  | 'nasal_cavity_paranasal'
  | 'thyroid_differentiated'
  | 'thyroid_medullary'
  | 'thyroid_anaplastic'
  | 'cutaneous_scc_hn'
  | 'unknown_primary'
  | 'mucosal_melanoma_hn';

export const SITES: readonly Site[] = [
  'oral_cavity',
  'oropharynx_p16pos',
  'oropharynx_p16neg',
  'hypopharynx',
  'larynx_supraglottic',
  'larynx_glottic',
  'larynx_subglottic',
  'nasopharynx',
  'major_salivary',
  'nasal_cavity_paranasal',
  'thyroid_differentiated',
  'thyroid_medullary',
  'thyroid_anaplastic',
  'cutaneous_scc_hn',
  'unknown_primary',
  'mucosal_melanoma_hn',
] as const;

/* ------------------------------------------------------------------ */
/* provenance                                                          */
/* ------------------------------------------------------------------ */

/**
 * Where an observation came from. `clinical` is the catch-all for a descriptor
 * asserted without saying whether it came from the scan or the chair (a
 * referral letter, an outside report).
 */
export type Provenance = 'imaging' | 'exam' | 'pathology' | 'clinical';

/** Which classification is being computed. */
export type StagingContext = 'clinical' | 'pathologic';

/** A single observation of one descriptor, with where it came from. */
export interface Observation<T> {
  value: T;
  source: Provenance;
  /** Free text appended to the trace, e.g. "inner cortex only". */
  note?: string;
}

/**
 * A descriptor may be observed more than once from different sources — that is
 * how `stage()` finds imaging/pathology conflicts. A bare `Observation` is the
 * single-source case.
 */
export type Observed<T> = Observation<T> | Observation<T>[];

export type NumObs = Observed<number>;
export type BoolObs = Observed<boolean>;

/* ------------------------------------------------------------------ */
/* primary tumour descriptors                                          */
/* ------------------------------------------------------------------ */

/**
 * Primary-tumour descriptors. Every field is optional; a site's `stageT` reads
 * only the fields its own T table names, and reports `TX` when they are all
 * absent. Names are shared wherever AJCC uses the same descriptor
 * (`carotid_encasement` is a T4b criterion in six chapters), so a descriptor
 * entered once is reused.
 */
export interface PrimaryInput {
  /** Greatest dimension, centimetres. */
  size_cm?: NumObs;
  /** Depth of invasion (NOT tumour thickness), millimetres. Oral cavity. */
  depth_of_invasion_mm?: NumObs;
  /** Number of subsites involved. Hypopharynx T1/T2, sinonasal T1/T2. */
  subsite_count?: NumObs;

  /* -- bone / soft tissue, oral cavity and shared ------------------- */
  /** Invasion through cortical bone of the mandible or maxilla (oral T4a). */
  cortical_bone_invasion?: BoolObs;
  /** Marrow / medullary bone invasion. Not itself an AJCC 8 T criterion. */
  medullary_bone_invasion?: BoolObs;
  /**
   * Gingival primary whose only bone finding is superficial erosion of bone or
   * a tooth socket. AJCC 8: that alone is NOT sufficient for T4.
   */
  gingival_superficial_bone_erosion?: BoolObs;
  maxillary_sinus_invasion?: BoolObs;
  extrinsic_tongue_muscle?: BoolObs;
  skin_invasion?: BoolObs;
  masticator_space?: BoolObs;
  pterygoid_plates?: BoolObs;
  medial_pterygoid_muscle?: BoolObs;
  lateral_pterygoid_muscle?: BoolObs;
  hard_palate?: BoolObs;
  mandible_invasion?: BoolObs;
  skull_base?: BoolObs;
  carotid_encasement?: BoolObs;
  prevertebral_fascia_invasion?: BoolObs;
  mediastinal_structures?: BoolObs;
  lateral_nasopharynx?: BoolObs;
  /** Oropharynx T3: extension to the lingual surface of the epiglottis. */
  epiglottis_lingual_surface?: BoolObs;
  /** Oropharynx T4a: invasion of the larynx. */
  larynx_invasion?: BoolObs;

  /* -- larynx / hypopharynx ---------------------------------------- */
  thyroid_cartilage_inner_cortex?: BoolObs;
  thyroid_cartilage_through?: BoolObs;
  cricoid_invasion?: BoolObs;
  vocal_cord_fixation?: BoolObs;
  impaired_vocal_cord_mobility?: BoolObs;
  paraglottic_space?: BoolObs;
  pre_epiglottic_space?: BoolObs;
  postcricoid_invasion?: BoolObs;
  subglottic_extension?: BoolObs;
  supraglottic_extension?: BoolObs;
  vocal_cord_involvement?: BoolObs;
  /** Supraglottic T2: mucosa of more than one adjacent supraglottic subsite. */
  supraglottis_multiple_subsites?: BoolObs;
  /** Supraglottic T2: mucosa outside the supraglottis (BOT, vallecula, medial pyriform wall). */
  outside_supraglottis_mucosa?: BoolObs;
  /** Hypopharynx T2: more than one hypopharyngeal subsite, or an adjacent site. */
  adjacent_site_extension?: BoolObs;
  /** Hypopharynx T3 (AJCC 8 wording). */
  hemilarynx_fixation?: BoolObs;
  esophageal_mucosa_extension?: BoolObs;
  esophagus_invasion?: BoolObs;
  hyoid_invasion?: BoolObs;
  thyroid_gland_invasion?: BoolObs;
  /** Hypopharynx T4a: prelaryngeal strap muscles / subcutaneous fat. */
  central_compartment_soft_tissue?: BoolObs;
  trachea_invasion?: BoolObs;
  soft_tissues_of_neck?: BoolObs;
  /** Larynx T3: disease still confined to the larynx. */
  limited_to_larynx?: BoolObs;

  /* -- thyroid (gross extrathyroidal extension categories) ---------- */
  /** T3b: gross ETE into strap muscles only. */
  strap_muscle_invasion?: BoolObs;
  /** T4a: gross ETE into larynx, trachea, oesophagus or recurrent laryngeal nerve. */
  larynx_trachea_rln_invasion?: BoolObs;
  /** T4a: gross ETE into subcutaneous soft tissue. */
  subcutaneous_soft_tissue_invasion?: BoolObs;
  /** T4b: mediastinal vessel encasement. */
  mediastinal_vessel_encasement?: BoolObs;

  /* -- nasopharynx -------------------------------------------------- */
  parapharyngeal_space?: BoolObs;
  prevertebral_muscle?: BoolObs;
  cranial_nerve_involvement?: BoolObs;
  bony_skull_base?: BoolObs;
  cervical_vertebra?: BoolObs;
  pterygoid_structures?: BoolObs;
  paranasal_sinus_involvement?: BoolObs;
  intracranial_extension?: BoolObs;
  hypopharynx_involvement?: BoolObs;
  orbit?: BoolObs;
  parotid_gland?: BoolObs;
  /** NPC T4: soft tissue infiltration beyond the lateral surface of lateral pterygoid. */
  beyond_lateral_pterygoid?: BoolObs;

  /* -- major salivary ----------------------------------------------- */
  /** Clinical or macroscopic soft-tissue invasion. Microscopic alone does NOT count. */
  extraparenchymal_extension?: BoolObs;
  facial_nerve?: BoolObs;
  ear_canal?: BoolObs;

  /* -- cutaneous SCC ------------------------------------------------ */
  /** PNI of a nerve deeper than dermis or >= 0.1 mm calibre, or a named nerve. */
  perineural_invasion?: BoolObs;
  /** Calibre of the involved nerve, millimetres (T3 threshold 0.1 mm). */
  perineural_nerve_calibre_mm?: NumObs;
  /** PNI of a named nerve — always qualifies for T3. */
  named_nerve_invasion?: BoolObs;
  minor_bone_erosion?: BoolObs;
  gross_cortical_bone_marrow_invasion?: BoolObs;
  skull_base_foramen?: BoolObs;
  /** Tumour thickness / depth from the granular layer, millimetres (T3 > 6 mm). */
  dermal_invasion_depth_mm?: NumObs;
  beyond_subcutaneous_fat?: BoolObs;

  /* -- nasal cavity and paranasal sinuses --------------------------- */
  /** Which sinonasal T table applies. Missing -> nasal cavity / ethmoid, with a warning. */
  sinonasal_subsite?: 'maxillary_sinus' | 'nasal_cavity_ethmoid';
  mucosa_only?: BoolObs;
  bone_erosion?: BoolObs;
  /** Maxillary T2: hard palate and/or middle nasal meatus. */
  hard_palate_or_middle_meatus?: BoolObs;
  posterior_maxillary_wall?: BoolObs;
  subcutaneous_tissue?: BoolObs;
  orbit_floor_or_medial_wall?: BoolObs;
  pterygoid_fossa?: BoolObs;
  ethmoid_sinus?: BoolObs;
  /** Nasal/ethmoid T2: two subsites in one region, or an adjacent nasoethmoidal region. */
  adjacent_nasoethmoidal_region?: BoolObs;
  cribriform_plate?: BoolObs;
  anterior_orbital_contents?: BoolObs;
  skin_of_nose_or_cheek?: BoolObs;
  minimal_anterior_cranial_fossa?: BoolObs;
  infratemporal_fossa?: BoolObs;
  sphenoid_or_frontal_sinus?: BoolObs;
  orbital_apex?: BoolObs;
  dura?: BoolObs;
  brain?: BoolObs;
  middle_cranial_fossa?: BoolObs;
  cranial_nerves_other_than_v2?: BoolObs;
  nasopharynx_invasion?: BoolObs;
  clivus?: BoolObs;

  /* -- mucosal melanoma --------------------------------------------- */
  mucosa_and_underlying_soft_tissue_only?: BoolObs;
  deep_soft_tissue?: BoolObs;
  cartilage_invasion?: BoolObs;
  bone_invasion?: BoolObs;
  overlying_skin?: BoolObs;
  /** Lower cranial nerves IX, X, XI, XII (mucosal melanoma T4b). */
  lower_cranial_nerves?: BoolObs;
  prevertebral_space?: BoolObs;

  /* -- shared ------------------------------------------------------- */
  /** Carcinoma in situ. */
  in_situ?: BoolObs;
  /** Primary not identified (unknown primary; NPC and p16+ OPC T0). */
  no_primary_identified?: BoolObs;
}

/* ------------------------------------------------------------------ */
/* nodal descriptors                                                   */
/* ------------------------------------------------------------------ */

export type NodeSide = 'ipsilateral' | 'contralateral' | 'bilateral' | 'midline';

/** One node, or one matted mass treated as one node. */
export interface NodeRecord {
  side?: NodeSide;
  /** Greatest dimension, centimetres. */
  size_cm?: NumObs;
  /** Robbins level, e.g. 'IIa', 'VI', 'VII', 'RP'. */
  level?: Observed<string>;
  /** Clinically overt ENE (AJCC 8: radiology alone is never enough). */
  ene_clinical?: BoolObs;
  /** Histologic ENE. */
  ene_pathologic?: BoolObs;
  /** Extent beyond the capsule, mm. <= 2 is ENEmi, > 2 is ENEma. */
  ene_extent_mm?: NumObs;
  retropharyngeal?: BoolObs;
  midline?: BoolObs;
  /** Nasopharynx N3: any part of the node below the caudal border of cricoid. */
  below_cricoid?: BoolObs;
}

export interface NodesInput {
  /** Per-node detail. An empty array means "the neck was assessed and is N0". */
  nodes?: NodeRecord[];
  count_positive?: NumObs;
  count_examined?: NumObs;
  largest_metastasis_cm?: NumObs;
  /** Aggregate ENE when the report does not say which node. */
  ene_present?: BoolObs;
  ene_extent_mm?: NumObs;
  /** Laterality of the involved neck when per-node side is absent. */
  laterality?: NodeSide;
  /** Thyroid: central compartment (level VI/VII) involvement. */
  central_compartment_nodes?: BoolObs;
  /** Thyroid: lateral neck (I-V) or retropharyngeal involvement. */
  lateral_neck_nodes?: BoolObs;
}

/* ------------------------------------------------------------------ */
/* metastasis, patient                                                 */
/* ------------------------------------------------------------------ */

export interface MetastasisInput {
  m1?: BoolObs;
}

export interface PatientInput {
  /** Age at diagnosis, years. Drives the thyroid 55-year stage cut-off. */
  age?: number;
  histology?: string;
  p16?: 'positive' | 'negative' | 'unknown';
  hpv?: 'positive' | 'negative' | 'unknown';
  /** EBV / EBER status; picks the nasopharynx chapter for an unknown primary. */
  ebv?: 'positive' | 'negative' | 'unknown';
}

/* ------------------------------------------------------------------ */
/* the whole input                                                     */
/* ------------------------------------------------------------------ */

export interface StagingInput {
  primary?: PrimaryInput;
  nodes?: NodesInput;
  metastasis?: MetastasisInput;
  patient?: PatientInput;
  /**
   * True when resection pathology is available, so `stage()` also computes the
   * pathologic classification. `capParser` sets it.
   */
  contextPathologic?: boolean;
}

/* ------------------------------------------------------------------ */
/* outputs                                                             */
/* ------------------------------------------------------------------ */

export type TCategory =
  | 'TX'
  | 'T0'
  | 'Tis'
  | 'T1'
  | 'T1a'
  | 'T1b'
  | 'T2'
  | 'T3'
  | 'T3a'
  | 'T3b'
  | 'T4'
  | 'T4a'
  | 'T4b';

export type NCategory =
  | 'NX'
  | 'N0'
  | 'N1'
  | 'N1a'
  | 'N1b'
  | 'N2'
  | 'N2a'
  | 'N2b'
  | 'N2c'
  | 'N3'
  | 'N3a'
  | 'N3b';

export type MCategory = 'M0' | 'M1';

export type StageGroup = '0' | 'I' | 'II' | 'III' | 'IVA' | 'IVB' | 'IVC' | 'IV' | 'unknown';

/** What every `stageT` / `stageN` returns: a category plus how it got there. */
export interface CategoryResult<C extends string = string> {
  category: C;
  trace: string[];
}

export interface GroupResult {
  group: StageGroup;
  trace: string[];
}

/** One classification (clinical or pathologic). */
export interface Classification {
  T: TCategory;
  N: NCategory;
  M: MCategory;
  group: StageGroup;
  trace: string[];
}

/** A descriptor observed differently by imaging/exam and by pathology. */
export interface Conflict {
  field: string;
  imaging: string;
  pathology: string;
  note: string;
}

export interface StageResult {
  site: Site;
  clinical: Classification;
  pathologic?: Classification;
  conflicts: Conflict[];
  warnings: string[];
  sources: string[];
  /**
   * The other p16 chapter, filled in when the oropharynx is staged without a
   * known p16 result (AJCC requires p16 to pick the chapter, so both are shown).
   */
  alternate?: {
    site: Site;
    label: string;
    clinical: Classification;
    pathologic?: Classification;
  };
}

/** The interface every `rules/<site>.ts` implements. */
export interface SiteRules {
  site: Site;
  label: string;
  stageT(input: StagingInput, context?: StagingContext): CategoryResult<TCategory>;
  stageN(input: StagingInput, context?: StagingContext): CategoryResult<NCategory>;
  stageGroup(
    T: TCategory,
    N: NCategory,
    M: MCategory,
    patient?: PatientInput,
    context?: StagingContext,
  ): GroupResult;
  /** Extra warnings this site raises (missing age, missing subsite, ...). */
  warnings?(input: StagingInput): string[];
  /** Rule-table ids this site relies on, for the `sources` list. */
  ruleIds: string[];
}
