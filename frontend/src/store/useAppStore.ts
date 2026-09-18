import { create } from 'zustand';
import type { Health, Patient, SeriesDetail, Series, Study } from '../api/client';
import type { ToastData } from '../ui';
import { DEFAULT_VOLUME_PRESET, DEFAULT_WINDOW } from '../viewer/presets';

export type PaneId = 'axial' | 'sagittal' | 'coronal' | 'volume3d' | 'stack';
export type LayoutMode = 'none' | 'mpr' | 'stack';

/**
 * UI-OVERHAUL.md §3: the default is one large working viewport plus a 236 px
 * context strip, NOT a 2x2. `strip` is that default; `2x2` and `1x1` remain.
 */
export type GridMode = 'strip' | '2x2' | '1x1';

export type BackendStatus = 'checking' | 'up' | 'down';

/** Library is a screen; Read / Plan / Compare / Board are the workspace tabs. */
export type Screen = 'library' | 'read' | 'plan' | 'compare' | 'board';

/** Findings first (DESIGN.md v2 §2). */
export type PanelTab = 'findings' | 'structures' | 'measurements' | 'report';

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

/** The structure under the cursor (UI-OVERHAUL.md §2 "anatomy chip"). */
export interface AnatomyState {
  name: string | null;
  color: string | null;
  /** Labelmap id + segment, so the Structures tab can glow the matching chip. */
  segmentationId: string | null;
  segmentIndex: number | null;
}

export type Toast = ToastData;

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
  /** A second series opened into the context strip, synced by world position. */
  compareSeries: SeriesDetail | null;

  /* ---- viewer ---- */
  screen: Screen;
  layout: LayoutMode;
  grid: GridMode;
  /** Which pane is the big one in `strip` layout — the plane being read. */
  primaryPane: PaneId;
  maximized: PaneId | null;
  activePane: PaneId;
  activeTool: string;
  windowPresetId: string;
  /** Where the current window came from, for the overlay label. */
  windowSource: string;
  volumePresetId: string;
  slabId: string;
  invert: boolean;
  cine: boolean;
  /** Cine frame interval in ms. */
  cineMs: number;
  panes: Record<PaneId, PaneState>;
  measurements: Measurement[];
  selectedMeasurement: string | null;
  probe: ProbeState;
  anatomy: AnatomyState;
  loading: LoadingState;
  viewerError: string | null;
  fps: number;

  /* ---- chrome ---- */
  panelOpen: boolean;
  panelTab: PanelTab;
  askOpen: boolean;
  toasts: Toast[];
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  importOpen: boolean;
  /** The G quick menu: threshold presets and region grow, from anywhere. */
  structuresMenuOpen: boolean;
  /** Finding row the user selected — highlighted on the scrubbers. */
  selectedFinding: string | null;

  set: (patch: Partial<AppState>) => void;
  setPane: (id: PaneId, patch: Partial<PaneState>) => void;
  toast: (t: Omit<Toast, 'id'>) => number;
  updateToast: (id: number, patch: Partial<Toast>) => void;
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
  compareSeries: null,

  screen: 'library',
  layout: 'none',
  grid: 'strip',
  primaryPane: 'axial',
  maximized: null,
  activePane: 'axial',
  activeTool: 'Crosshairs',
  windowPresetId: DEFAULT_WINDOW.id,
  windowSource: 'preset',
  volumePresetId: DEFAULT_VOLUME_PRESET.id,
  slabId: 'thin',
  invert: false,
  cine: false,
  cineMs: 60,
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
  anatomy: { name: null, color: null, segmentationId: null, segmentIndex: null },
  loading: { active: false, loaded: 0, total: 0, label: '' },
  viewerError: null,
  fps: 0,

  panelOpen: true,
  panelTab: 'findings',
  askOpen: false,
  toasts: [],
  paletteOpen: false,
  shortcutsOpen: false,
  importOpen: false,
  structuresMenuOpen: false,
  selectedFinding: null,

  set: (patch) => set(patch),

  setPane: (id, patch) => set((s) => ({ panes: { ...s.panes, [id]: { ...s.panes[id], ...patch } } })),

  /**
   * Returns the toast id so a long job can keep updating one row
   * (`updateToast(id, { progress })`) rather than stacking five of them.
   */
  toast: (t) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-4) }));
    return id;
  },

  updateToast: (id, patch) =>
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),

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
  volume3d: { label: 'Structures', short: '3D', color: 'var(--plane-3d)', letters: ['', '', '', ''] },
  stack: { label: 'Acquired', short: 'IMG', color: 'var(--plane-ax)', letters: ['A', 'P', 'R', 'L'] },
};
