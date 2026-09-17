/**
 * The Structures tab's state and the actions behind its buttons.
 *
 * A "structure" is one backend label made visible: a labelmap segment on the
 * MPR panes, optionally a surface in 3D, plus its volumetrics. The backend
 * keeps labels in a 20-deep in-memory LRU that does not survive a reload, so
 * every action treats a 404 as "that label is gone, re-run the segmentation"
 * rather than as a hard failure.
 */
import { create } from 'zustand';

import {
  ApiError,
  analysis,
  type LabelStats,
  type Triple,
} from '../api/client';
import { useAppStore } from '../store/useAppStore';
import { viewer } from '../viewer/ViewerCore';
import { armPick, type PickHandle, type PickResult } from '../viewer/pick';
import {
  ANATOMY,
  categoryForName,
  colorForName,
  rgbToCss,
  type Category,
  type Rgb,
} from './colors';
import { lineOverlay } from './lineOverlay';
import { segmentations, MAX_RESIDENT, type SegmentSpec } from './segmentationService';

export type StructureSource = 'threshold' | 'region-grow' | 'airway' | 'ai';

export interface Structure {
  /** Row key. Unique even when several rows share one merged labelmap. */
  id: string;
  label_id: string;
  name: string;
  color: Rgb;
  volume_ml: number;
  visible: boolean;
  /** Labelmap fill alpha, 0..1. */
  opacity: number;
  source: StructureSource;
  series_uid: string;

  /* ---- rendering / bookkeeping ---- */
  segmentationId: string;
  segmentIndex: number;
  category: Category;
  stats: LabelStats | null;
  /** The labelmap is resident and on screen. */
  loaded: boolean;
  in3d: boolean;
  busy: string | null;
  error: string | null;
}

export interface DistanceResultRow {
  aId: string;
  bId: string;
  mm: number;
  pointA: Triple;
  pointB: Triple;
}

/** The inline form behind "Region grow from click". */
export interface GrowForm {
  padHu: number;
  radiusMm: number;
  /** Set once the user has clicked; null while waiting for the click. */
  seedIjk: Triple | null;
  seedHu: number | null;
  armed: boolean;
}

interface StructureState {
  items: Structure[];
  /** A quick-add or AI job in flight — one line for the panel. */
  busy: string | null;
  grow: GrowForm;
  /** "distance to…": the row that started it, waiting for a partner. */
  distanceFrom: string | null;
  distance: DistanceResultRow | null;
  set: (patch: Partial<StructureState>) => void;
}

const emptyGrow = (): GrowForm => ({ padHu: 60, radiusMm: 40, seedIjk: null, seedHu: null, armed: false });

export const useStructureStore = create<StructureState>((set) => ({
  items: [],
  busy: null,
  grow: emptyGrow(),
  distanceFrom: null,
  distance: null,
  set: (patch) => set(patch),
}));

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

let rowSeq = 0;

function patchRow(id: string, patch: Partial<Structure>): void {
  const s = useStructureStore.getState();
  s.set({ items: s.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
}

function rowsOf(segmentationId: string): Structure[] {
  return useStructureStore.getState().items.filter((r) => r.segmentationId === segmentationId);
}

export function structureById(id: string): Structure | undefined {
  return useStructureStore.getState().items.find((r) => r.id === id);
}

function seriesUid(): string | null {
  return useAppStore.getState().activeSeries?.series_uid ?? null;
}

function failed(title: string, e: unknown): void {
  const err = e as ApiError;
  const gone = err?.status === 404;
  useAppStore.getState().toast({
    kind: 'err',
    title,
    message: gone
      ? 'The backend no longer has that label (it keeps only the last 20, and a restart clears them). Run the segmentation again.'
      : ((e as Error)?.message ?? String(e)),
  });
}

/** Mark rows whose labelmap the service evicted to stay under the memory cap. */
function markEvicted(evicted: string[]): void {
  if (!evicted.length) return;
  const s = useStructureStore.getState();
  s.set({
    items: s.items.map((it) =>
      evicted.includes(it.segmentationId) ? { ...it, loaded: false, visible: false, in3d: false } : it,
    ),
  });
  useAppStore.getState().toast({
    kind: 'info',
    title: `Unloaded ${evicted.length} labelmap${evicted.length > 1 ? 's' : ''}`,
    message: `Only ${MAX_RESIDENT} stay in memory. Press the eye to bring one back.`,
  });
}

/* ------------------------------------------------------------------ */
/* adding structures                                                  */
/* ------------------------------------------------------------------ */

export interface AddOptions {
  name: string;
  source: StructureSource;
  color?: Rgb;
  /** Show it in the 3D view straight away (bone, airway). */
  surface?: boolean;
}

/** Turn a finished backend label into a visible structure row. */
export async function addStructureFromLabel(
  stats: LabelStats,
  opts: AddOptions,
): Promise<Structure | null> {
  const uid = seriesUid();
  if (!uid) return null;

  const color = opts.color ?? colorForName(opts.name, rowSeq);
  const segmentationId = `hnrad-seg:${stats.label_id}`;
  const row: Structure = {
    id: `struct-${++rowSeq}`,
    label_id: stats.label_id,
    name: opts.name,
    color,
    volume_ml: stats.volume_ml,
    visible: true,
    opacity: 0.55,
    source: opts.source,
    series_uid: uid,
    segmentationId,
    segmentIndex: 1,
    category: categoryForName(opts.name),
    stats,
    loaded: false,
    in3d: false,
    busy: 'Loading mask…',
    error: null,
  };

  const s = useStructureStore.getState();
  s.set({ items: [...s.items, row] });

  try {
    const evicted = await segmentations.addLabelmap(segmentationId, [
      { labelId: stats.label_id, segmentIndex: 1, name: opts.name, color },
    ]);
    markEvicted(evicted);
    patchRow(row.id, { loaded: true, busy: null });
  } catch (e) {
    patchRow(row.id, { busy: null, loaded: false, error: (e as Error)?.message ?? String(e) });
    failed(`${opts.name} could not be displayed`, e);
    return null;
  }

  if (opts.surface) void toggle3d(row.id, true);
  return structureById(row.id) ?? null;
}

/**
 * Add many labels as ONE multi-label labelmap — the shape the 20 nodal levels
 * need, and what keeps an AI run inside the memory budget.
 */
export async function addStructureGroup(
  groupId: string,
  entries: Array<{ label_id: string; name: string; volume_ml: number; color?: Rgb }>,
  source: StructureSource,
): Promise<void> {
  const uid = seriesUid();
  if (!uid || !entries.length) return;

  const segmentationId = `hnrad-seg-group:${groupId}`;
  const specs: SegmentSpec[] = [];
  const rows: Structure[] = entries.slice(0, 254).map((e, i) => {
    const color = e.color ?? colorForName(e.name, i);
    specs.push({ labelId: e.label_id, segmentIndex: i + 1, name: e.name, color });
    return {
      id: `struct-${++rowSeq}`,
      label_id: e.label_id,
      name: e.name,
      color,
      volume_ml: e.volume_ml,
      visible: true,
      opacity: 0.55,
      source,
      series_uid: uid,
      segmentationId,
      segmentIndex: i + 1,
      category: categoryForName(e.name),
      stats: null,
      loaded: false,
      in3d: false,
      busy: 'Loading mask…',
      error: null,
    };
  });

  const s = useStructureStore.getState();
  s.set({ items: [...s.items, ...rows] });

  try {
    const evicted = await segmentations.addLabelmap(segmentationId, specs);
    markEvicted(evicted);
    const after = useStructureStore.getState();
    after.set({
      items: after.items.map((it) =>
        it.segmentationId === segmentationId ? { ...it, loaded: true, busy: null } : it,
      ),
    });
  } catch (e) {
    const after = useStructureStore.getState();
    after.set({
      items: after.items.map((it) =>
        it.segmentationId === segmentationId
          ? { ...it, busy: null, loaded: false, error: (e as Error)?.message ?? String(e) }
          : it,
      ),
    });
    failed('The AI structures could not be displayed', e);
  }
}

/* ------------------------------------------------------------------ */
/* quick adds                                                         */
/* ------------------------------------------------------------------ */

export type QuickAddId = 'bone' | 'airway' | 'vessels';

export const QUICK_ADDS: Array<{
  id: QuickAddId;
  label: string;
  hint: string;
  color: Rgb;
}> = [
  { id: 'bone', label: 'Bone', hint: '250 – 3000 HU, inside the body', color: ANATOMY.bone.rgb },
  { id: 'airway', label: 'Airway', hint: '−1024 – −400 HU, largest component', color: ANATOMY.airway.rgb },
  { id: 'vessels', label: 'Vessels', hint: '150 – 600 HU, ≥ 0.5 ml components', color: ANATOMY.artery.rgb },
];

export async function quickAdd(kind: QuickAddId): Promise<void> {
  const uid = seriesUid();
  if (!uid) {
    useAppStore.getState().toast({ kind: 'err', title: 'Open a series first' });
    return;
  }
  if (!viewer.ctVolumeId) {
    useAppStore.getState().toast({
      kind: 'err',
      title: 'Segmentation needs a volumetric series',
      message: 'Open a CT that loads as MPR rather than a single stack.',
    });
    return;
  }

  const spec = QUICK_ADDS.find((q) => q.id === kind);
  if (!spec) return;
  const store = useStructureStore.getState();
  if (store.busy) return;
  store.set({ busy: `Segmenting ${spec.label.toLowerCase()}…` });

  try {
    const body =
      kind === 'bone'
        ? { series_uid: uid, lower_hu: 250, upper_hu: 3000, inside_body: true }
        : kind === 'airway'
          ? { series_uid: uid, lower_hu: -1024, upper_hu: -400, inside_body: true, keep_largest: true }
          : { series_uid: uid, lower_hu: 150, upper_hu: 600, inside_body: true, min_component_ml: 0.5 };
    const stats = await analysis.threshold(body);
    await addStructureFromLabel(stats, {
      name: spec.label,
      source: 'threshold',
      color: spec.color,
      surface: kind !== 'vessels',
    });
    useAppStore.getState().toast({
      kind: 'ok',
      title: `${spec.label}: ${stats.volume_ml.toFixed(1)} ml`,
      message: `${stats.n_voxels.toLocaleString()} voxels · ${(stats.took_ms / 1000).toFixed(1)} s`,
    });
  } catch (e) {
    failed(`${spec.label} segmentation failed`, e);
  } finally {
    useStructureStore.getState().set({ busy: null });
  }
}

/* ------------------------------------------------------------------ */
/* region grow from a click                                           */
/* ------------------------------------------------------------------ */

let growPick: PickHandle | null = null;

export function armRegionGrow(): void {
  if (!viewer.ctVolumeId) {
    useAppStore.getState().toast({
      kind: 'err',
      title: 'Region grow needs a volumetric series',
    });
    return;
  }
  disarmRegionGrow();
  const s = useStructureStore.getState();
  s.set({ grow: { ...s.grow, armed: true, seedIjk: null, seedHu: null } });
  useAppStore.getState().set({ panelTab: 'structures', panelOpen: true });

  growPick = armPick(
    (p: PickResult) => {
      growPick = null;
      const st = useStructureStore.getState();
      if (!p.ijk) {
        st.set({ grow: { ...st.grow, armed: false } });
        useAppStore.getState().toast({
          kind: 'err',
          title: 'That click was outside the volume',
        });
        return;
      }
      st.set({
        grow: { ...st.grow, armed: false, seedIjk: [p.ijk[0], p.ijk[1], p.ijk[2]], seedHu: p.hu },
      });
      void runRegionGrow();
    },
    {
      onCancel: () => {
        growPick = null;
        const st = useStructureStore.getState();
        st.set({ grow: { ...st.grow, armed: false } });
      },
    },
  );
}

export function disarmRegionGrow(): void {
  growPick?.cancel();
  growPick = null;
  const s = useStructureStore.getState();
  if (s.grow.armed) s.set({ grow: { ...s.grow, armed: false } });
}

/** Run (or re-run) the grow on the stored seed with the current form values. */
export async function runRegionGrow(): Promise<void> {
  const uid = seriesUid();
  const { grow, busy } = useStructureStore.getState();
  if (!uid || !grow.seedIjk || busy) return;

  const centre = grow.seedHu ?? 0;
  const lower = Math.round(centre - grow.padHu);
  const upper = Math.round(centre + grow.padHu);

  useStructureStore.getState().set({ busy: 'Growing from the seed…' });
  try {
    const stats = await analysis.regionGrow({
      series_uid: uid,
      seed_ijk: grow.seedIjk,
      lower_hu: lower,
      upper_hu: upper,
      max_radius_mm: grow.radiusMm,
      keep_largest: true,
    });
    const name = `Region ${Math.round(centre)} HU`;
    await addStructureFromLabel(stats, { name, source: 'region-grow' });
    useAppStore.getState().toast({
      kind: 'ok',
      title: `${stats.volume_ml.toFixed(2)} ml grown`,
      message: `${lower} – ${upper} HU · ${grow.radiusMm} mm cap · longest axis ${stats.longest_axis_mm.toFixed(1)} mm`,
    });
  } catch (e) {
    failed('Region grow failed', e);
  } finally {
    useStructureStore.getState().set({ busy: null });
  }
}

/* ------------------------------------------------------------------ */
/* per-row actions                                                    */
/* ------------------------------------------------------------------ */

export async function setVisible(id: string, visible: boolean): Promise<void> {
  const row = structureById(id);
  if (!row) return;

  if (visible && !row.loaded) {
    // It was evicted to stay under the memory cap; fetch the mask again.
    patchRow(id, { busy: 'Reloading mask…' });
    try {
      const siblings = rowsOf(row.segmentationId);
      const evicted = await segmentations.addLabelmap(
        row.segmentationId,
        siblings.map((r) => ({
          labelId: r.label_id,
          segmentIndex: r.segmentIndex,
          name: r.name,
          color: r.color,
        })),
      );
      markEvicted(evicted.filter((s) => s !== row.segmentationId));
      siblings.forEach((r) => patchRow(r.id, { loaded: true, busy: null }));
    } catch (e) {
      patchRow(id, { busy: null, error: (e as Error)?.message ?? String(e) });
      failed(`${row.name} could not be reloaded`, e);
      return;
    }
  }

  const siblings = rowsOf(row.segmentationId);
  if (siblings.length > 1) segmentations.setSegmentVisible(row.segmentationId, row.segmentIndex, visible);
  else segmentations.setVisible(row.segmentationId, visible);
  patchRow(id, { visible });
}

export function setOpacity(id: string, opacity: number): void {
  const row = structureById(id);
  if (!row) return;
  segmentations.setOpacity(row.segmentationId, opacity);
  // One labelmap carries one style, so a group moves together.
  rowsOf(row.segmentationId).forEach((r) => patchRow(r.id, { opacity }));
}

/** "to 3D" — add or drop the structure's surface in the volume viewport. */
export async function toggle3d(id: string, force?: boolean): Promise<void> {
  const row = structureById(id);
  if (!row) return;
  const want = force ?? !row.in3d;
  if (!want) {
    segmentations.removeSurface(row.segmentationId, row.segmentIndex);
    patchRow(id, { in3d: false });
    return;
  }
  patchRow(id, { busy: 'Building surface…' });
  try {
    const triangles = await segmentations.addSurface(
      row.segmentationId,
      row.segmentIndex,
      row.label_id,
      row.color,
    );
    patchRow(id, { in3d: true, busy: null });
    useAppStore.getState().toast({
      kind: 'ok',
      title: `${row.name} in 3D`,
      message: `${triangles.toLocaleString()} triangles`,
    });
  } catch (e) {
    patchRow(id, { busy: null });
    failed(`${row.name} could not be meshed`, e);
  }
}

/** "export STL" — stream /mesh straight to a download. */
export async function exportStl(id: string): Promise<void> {
  const row = structureById(id);
  if (!row) return;
  patchRow(id, { busy: 'Exporting STL…' });
  try {
    const buffer = await analysis.mesh(row.label_id);
    const blob = new Blob([buffer], { type: 'application/sla' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'label'}.stl`;
    document.body.appendChild(a);
    a.click();
    // Detaching the anchor in the same task can cancel a blob download before
    // the browser has taken the stream; let the click settle first.
    window.setTimeout(() => a.remove(), 0);
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    useAppStore.getState().toast({
      kind: 'ok',
      title: 'STL saved',
      message: `${a.download} · ${(buffer.byteLength / 1_048_576).toFixed(1)} MB`,
    });
  } catch (e) {
    failed(`${row.name} STL export failed`, e);
  } finally {
    patchRow(id, { busy: null });
  }
}

export async function removeStructure(id: string): Promise<void> {
  const row = structureById(id);
  if (!row) return;
  const siblings = rowsOf(row.segmentationId);

  segmentations.removeSurface(row.segmentationId, row.segmentIndex);
  if (siblings.length <= 1) segmentations.remove(row.segmentationId);
  else segmentations.setSegmentVisible(row.segmentationId, row.segmentIndex, false);

  const s = useStructureStore.getState();
  s.set({
    items: s.items.filter((r) => r.id !== id),
    distanceFrom: s.distanceFrom === id ? null : s.distanceFrom,
    distance: s.distance && (s.distance.aId === id || s.distance.bId === id) ? null : s.distance,
  });
  if (!useStructureStore.getState().distance) lineOverlay.hide();

  try {
    await analysis.deleteLabel(row.label_id);
  } catch {
    /* already evicted from the backend LRU — nothing to free */
  }
}

/* ------------------------------------------------------------------ */
/* distance between two structures                                    */
/* ------------------------------------------------------------------ */

export function startDistance(id: string): void {
  const s = useStructureStore.getState();
  s.set({ distanceFrom: s.distanceFrom === id ? null : id });
}

export function cancelDistance(): void {
  useStructureStore.getState().set({ distanceFrom: null });
}

export async function measureDistance(aId: string, bId: string): Promise<void> {
  const a = structureById(aId);
  const b = structureById(bId);
  if (!a || !b || a.id === b.id) return;
  const store = useStructureStore.getState();
  store.set({ busy: `${a.name} → ${b.name}…`, distanceFrom: null });
  try {
    const out = await analysis.distance(a.label_id, b.label_id);
    const row: DistanceResultRow = {
      aId,
      bId,
      mm: out.min_distance_mm,
      pointA: out.point_a_lps,
      pointB: out.point_b_lps,
    };
    useStructureStore.getState().set({ distance: row });
    lineOverlay.show({
      a: [out.point_a_lps[0], out.point_a_lps[1], out.point_a_lps[2]],
      b: [out.point_b_lps[0], out.point_b_lps[1], out.point_b_lps[2]],
      label: `${out.min_distance_mm.toFixed(1)} mm`,
      color: out.min_distance_mm <= 0 ? 'var(--danger)' : 'var(--accent)',
    });
    viewer.jumpToWorld([out.point_a_lps[0], out.point_a_lps[1], out.point_a_lps[2]]);
    viewer.addDerivedMeasurement({
      uid: `distance-${a.label_id}-${b.label_id}`,
      toolName: 'Structure distance',
      value: `${out.min_distance_mm.toFixed(1)} mm`,
      extra: `${a.name} → ${b.name}${out.min_distance_mm < 0 ? ' · overlapping' : ''}`,
      paneId: 'axial',
      sliceIndex: null,
    });
  } catch (e) {
    failed('Distance failed', e);
  } finally {
    useStructureStore.getState().set({ busy: null });
  }
}

export function clearDistance(): void {
  useStructureStore.getState().set({ distance: null, distanceFrom: null });
  lineOverlay.hide();
}

/** Re-centre the MPR views on a distance result. */
export function jumpToDistance(): void {
  const d = useStructureStore.getState().distance;
  if (!d) return;
  viewer.jumpToWorld([d.pointA[0], d.pointA[1], d.pointA[2]]);
}

/* ------------------------------------------------------------------ */
/* group (category) helpers                                           */
/* ------------------------------------------------------------------ */

export async function setCategoryVisible(category: Category, visible: boolean): Promise<void> {
  const rows = useStructureStore.getState().items.filter((r) => r.category === category);
  for (const r of rows) await setVisible(r.id, visible);
}

export function swatch(row: Structure): string {
  return rgbToCss(row.color);
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                          */
/* ------------------------------------------------------------------ */

export function resetStructures(): void {
  disarmRegionGrow();
  lineOverlay.hide();
  segmentations.clear();
  useStructureStore
    .getState()
    .set({ items: [], busy: null, grow: emptyGrow(), distanceFrom: null, distance: null });
}

// A label belongs to one series: a new series invalidates every structure.
useAppStore.subscribe((s, prev) => {
  if (s.activeSeries?.series_uid !== prev.activeSeries?.series_uid) resetStructures();
});
