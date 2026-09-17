export interface WindowPreset {
  id: string;
  label: string;
  ww: number;
  wc: number;
  hint: string;
}

/** Window/level presets — the neck-relevant set first. */
export const WINDOW_PRESETS: WindowPreset[] = [
  { id: 'soft', label: 'Soft tissue neck', ww: 350, wc: 40, hint: '350 / 40' },
  { id: 'cta', label: 'CTA / vessels', ww: 600, wc: 150, hint: '600 / 150' },
  { id: 'bone', label: 'Bone', ww: 2000, wc: 400, hint: '2000 / 400' },
  { id: 'tbone', label: 'Temporal bone', ww: 4000, wc: 700, hint: '4000 / 700' },
  { id: 'lung', label: 'Lung / airway', ww: 1500, wc: -600, hint: '1500 / -600' },
  { id: 'brain', label: 'Brain', ww: 80, wc: 40, hint: '80 / 40' },
  { id: 'stroke', label: 'Stroke', ww: 40, wc: 40, hint: '40 / 40' },
];

export const DEFAULT_WINDOW = WINDOW_PRESETS[0];

export interface VolumePreset {
  id: string;
  label: string;
  hint: string;
}

/** Built-in vtk transfer-function presets shipped in @cornerstonejs/core. */
export const VOLUME_PRESETS: VolumePreset[] = [
  { id: 'CT-Bone', label: 'Bone', hint: 'mandible / spine' },
  { id: 'CT-Bones', label: 'Bone only', hint: 'skin suppressed' },
  { id: 'CT-AAA', label: 'CTA vessels', hint: 'carotid / IJ' },
  { id: 'CT-Soft-Tissue', label: 'Soft tissue', hint: 'surface + muscle' },
  { id: 'CT-Air', label: 'Airway', hint: 'air column' },
  { id: 'CT-Muscle', label: 'Muscle', hint: 'general survey' },
  { id: 'CT-MIP', label: 'MIP', hint: 'max intensity' },
];

export const DEFAULT_VOLUME_PRESET = VOLUME_PRESETS[0];

export interface SlabOption {
  id: string;
  label: string;
  mm: number;
  mip: boolean;
}

/** Slab / thin-MIP options — thin MIP is high yield for vessels and airway. */
export const SLAB_OPTIONS: SlabOption[] = [
  { id: 'thin', label: 'Thin', mm: 0, mip: false },
  { id: 'mip5', label: '5 mm MIP', mm: 5, mip: true },
  { id: 'mip10', label: '10 mm MIP', mm: 10, mip: true },
  { id: 'mip20', label: '20 mm MIP', mm: 20, mip: true },
  { id: 'mip40', label: '40 mm MIP', mm: 40, mip: true },
];
