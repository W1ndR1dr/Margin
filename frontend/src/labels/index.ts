export { StructuresTab } from './StructuresTab';
export {
  useStructureStore,
  addStructureFromLabel,
  addStructureGroup,
  quickAdd,
  armRegionGrow,
  disarmRegionGrow,
  resetStructures,
  type Structure,
  type StructureSource,
} from './structureStore';
export { segmentations, MAX_RESIDENT } from './segmentationService';
export { anatomyProbe, type AnatomyReading } from './anatomyProbe';
export { type AnatomyHit, type SamplerGrid, type SamplerLayer } from './anatomySampler';
export { ANATOMY, CATEGORY_LABEL, CATEGORY_ORDER, categoryForName, colorForName, rgbToCss, type Category, type Rgb } from './colors';
export { parseBinaryStl, type StlMesh } from './stl';
export { parseMaskHeaders, describeMismatch, type MaskGeometry } from './geometry';
