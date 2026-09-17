/**
 * Margin staging engine — AJCC 8 head & neck TNM with a rule trace, plus a
 * local CAP synoptic parser.
 *
 * Pure TypeScript: no React, no Cornerstone, no DOM, no network. The UI wires
 * it in separately and only ever hands it descriptors.
 */

export type {
  BoolObs,
  CategoryResult,
  Classification,
  Conflict,
  GroupResult,
  MCategory,
  MetastasisInput,
  NCategory,
  NodeRecord,
  NodeSide,
  NodesInput,
  NumObs,
  Observation,
  Observed,
  PatientInput,
  PrimaryInput,
  Provenance,
  Site,
  SiteRules,
  StageGroup,
  StageResult,
  StagingContext,
  StagingInput,
  TCategory,
} from './types';
export { SITES } from './types';

export { findConflicts, generalWarnings, stage } from './stage';

export type { CapParseResult, ParsedField } from './capParser';
export { parseCapReport } from './capParser';

export { SITE_RULES, rulesFor } from './rules';

export {
  CLINICAL_PRIORITY,
  PATHOLOGIC_PRIORITY,
  commonN,
  eneLabel,
  flattenNodes,
  mucosalMelanomaN,
  nasopharynxN,
  nRank,
  observations,
  p16OropharynxN,
  resolve,
  say,
  stageM,
  standardHnStageGroup,
  tRank,
  thyroidN,
} from './rules/common';

export type { RuleConfidence, RuleEntry } from './rules/ruleTable';
export { RULE_TABLE, SOURCES, rule, rulesToVerify, sourcesFor } from './rules/ruleTable';

export {
  DOI_STEPS_MM,
  oralCavityGridCorrected,
  oralCavityGridOriginal,
} from './rules/oral_cavity';
export { DEEP_INVASION_MM, PNI_CALIBRE_MM } from './rules/cutaneous_scc_hn';
export { THYROID_AGE_CUTOFF, thyroidT } from './rules/thyroid_differentiated';
