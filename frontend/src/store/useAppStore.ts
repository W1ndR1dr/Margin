import { create } from 'zustand';
import type { Health, Patient, SeriesDetail, Series, Study } from '../api/client';
import { DEFAULT_VOLUME_PRESET, DEFAULT_WINDOW } from '../viewer/presets';

export type PaneId = 'axial' | 'sagittal' | 'coronal' | 'volume3d' | 'stack';
export type LayoutMode = 'none' | 'mpr' | 'stack';
export type GridMode = '2x2' | '1x1' | '1x2';
export type BackendStatus = 'checking' | 'up' | 'down';
export type Screen = 'library' | 'view';
export type PanelTab = 'measurements' | 'structures' | 'tools' | 'report';

export interface PaneState {
  slice: number;
  total: number;
  ww: number;
  wc: number;
  zoom: number;
}

export interface Measurement {
  uid: string;
  toolName: string;
  value: string;
  extra: string;
  paneId: PaneId;
  sliceIndex: number | null;
}

export interface ProbeState {
  hu: number | null;
  lps: [number, number, number] | null;
  ijk: [number, number, number] | null;
  paneId: PaneId | null;
}

export interface Toast {
  id: number;
  kind: 'ok' | 'err' | 'info';
  title: string;
  message?: string;
}

export interface LoadingState {
  active: boolean;
  loaded: number;
  total: number;
  label: string;
}

const emptyPane = (): PaneState => ({
  slice: 0,
  total: 0,
  ww: DEFAULT_WINDOW.ww,
  wc: DEFAULT_WINDOW.wc,
  zoom: 1,
});

interface AppState {
  /* ---- backend & library ---- */
  backend: BackendStatus;
  health: Health | null;
  patients: Patient[];
  studies: Study[];
  seriesByStudy: Record<string, Series[]>;
  expandedStudy: string | null;
  libraryBusy: boolean;
  activeSeries: SeriesDetail | null;
  activeStudy: Study | null;

  /* ---- viewer ---- */
  screen: Screen;
  layout: LayoutMode;
  grid: GridMode;
  maximized: PaneId | null;
  activePane: PaneId;
  activeTool: string;
  windowPresetId: string;
  volumePresetId: string;
  slabId: string;
  invert: boolean;
  cine: boolean;
  panes: Record<PaneId, PaneState>;
  measurements: Measurement[];
  selectedMeasurement: string | null;
  probe: ProbeState;
  loading: LoadingState;
  viewerError: string | null;
  fps: number;

  /* ---- chrome ---- */
  panelOpen: boolean;
  panelTab: PanelTab;
  toasts: Toast[];
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  importOpen: boolean;
  /** The G quick menu: threshold presets and region grow, from anywhere. */
  structuresMenuOpen: boolean;

  set: (patch: Partial<AppState>) => void;
  setPane: (id: PaneId, patch: Partial<PaneState>) => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  dropToast: (id: number) => void;
}

let toastSeq = 1;

export const useAppStore = create<AppState>((set) => ({
  backend: 'checking',
  health: null,
  patients: [],
  studies: [],
  seriesByStudy: {},
  expandedStudy: null,
  libraryBusy: false,
  activeSeries: null,
  activeStudy: null,

  screen: 'library',
  layout: 'none',
  grid: '2x2',
  maximized: null,
  activePane: 'axial',
  activeTool: 'Crosshairs',
  windowPresetId: DEFAULT_WINDOW.id,
  volumePresetId: DEFAULT_VOLUME_PRESET.id,
  slabId: 'thin',
  invert: false,
  cine: false,
  panes: {
    axial: emptyPane(),
    sagittal: emptyPane(),
    coronal: emptyPane(),
    volume3d: emptyPane(),
    stack: emptyPane(),
  },
  measurements: [],
  selectedMeasurement: null,
  probe: { hu: null, lps: null, ijk: null, paneId: null },
  loading: { active: false, loaded: 0, total: 0, label: '' },
  viewerError: null,
  fps: 0,

  panelOpen: true,
  panelTab: 'measurements',
  toasts: [],
  paletteOpen: false,
  shortcutsOpen: false,
  importOpen: false,
  structuresMenuOpen: false,

  set: (patch) => set(patch),

  setPane: (id, patch) =>
    set((s) => ({ panes: { ...s.panes, [id]: { ...s.panes[id], ...patch } } })),

  toast: (t) => set((s) => ({ toasts: [...s.toasts, { ...t, id: toastSeq++ }].slice(-3) })),

  dropToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

export const PANE_META: Record<
  PaneId,
  { label: string; short: string; color: string; letters: [string, string, string, string] }
> = {
  // letters: [top, bottom, left, right]
  axial: { label: 'Axial', short: 'AX', color: 'var(--plane-ax)', letters: ['A', 'P', 'R', 'L'] },
  sagittal: { label: 'Sagittal', short: 'SAG', color: 'var(--plane-sag)', letters: ['S', 'I', 'A', 'P'] },
  coronal: { label: 'Coronal', short: 'COR', color: 'var(--plane-cor)', letters: ['S', 'I', 'R', 'L'] },
  volume3d: { label: 'Volume', short: '3D', color: 'var(--plane-3d)', letters: ['', '', '', ''] },
  stack: { label: 'Acquisition', short: 'IMG', color: 'var(--plane-ax)', letters: ['A', 'P', 'R', 'L'] },
};
