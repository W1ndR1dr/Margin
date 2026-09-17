/**
 * Neck level mapper (TOOLS-SPEC.md section 3). Pure TypeScript, no React and
 * no Cornerstone: the UI imports from here and supplies LPS-mm coordinates.
 */

export type {
  AnatomicSide,
  Confidence,
  Landmarks,
  LevelResult,
  NeckLevel,
  Point3,
  Side,
  SideLandmarks,
} from './types';

export {
  BOUNDARY_MARGIN_MM,
  IJV_POSTERIOR_EDGE_OFFSET_MM,
  MIDLINE_TOLERANCE_MM,
  classifyNode,
  classifyNodes,
  ijvPosteriorEdgeAtZ,
  interpolateAtZ,
  midlineAtZ,
} from './classify';

export type { LevelBand, LevelBands } from './bands';
export { VII_BAND_DEPTH_MM, bandAtZ, levelBands } from './bands';

export type { LevelCounts, LevelGroup, LevelTally } from './tally';
export {
  GROUP_ORDER,
  LEVEL_ORDER,
  SIDES,
  neckDissectionSuggestion,
  neckDissectionSummary,
  sideSuggestion,
  sideTotal,
  tallyLevels,
} from './tally';

export { LEFT_SIDE, RIGHT_SIDE, SYNTHETIC_LANDMARKS, makeSyntheticLandmarks } from './fixtures';
