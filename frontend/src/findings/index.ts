/**
 * The Findings module's public surface.
 *
 * Pure derivation only: no JSX, no store, no Cornerstone. The panel imports
 * `deriveFindings` and treats it as a `useMemo`.
 */
export type {
  Finding,
  FindingKind,
  FindingMetric,
  FindingSeverity,
  FindingStatementPart,
  FindingTarget,
  PaneId,
  Triple,
} from './types';

export {
  AIRWAY_CAUTION_MM,
  AIRWAY_PATENT_MM,
  MAX_STRUCTURE_ROWS,
  deriveFindings,
  findingsSummary,
  scrubberMarkers,
  severityRank,
  sortFindings,
} from './derive';

export type {
  CompletedCheck,
  FindingsInput,
  FindingsSummary,
  ScrubberMarker,
} from './derive';
