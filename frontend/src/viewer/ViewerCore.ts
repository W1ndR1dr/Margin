/**
 * ViewerCore — the single owner of Cornerstone3D state.
 *
 * React never touches the rendering engine directly: it hands this module the
 * DOM elements for the panes and asks it to display a series. The core pushes
 * everything the UI needs (slice indices, W/L, measurements, HU probe,
 * progress) into the zustand store.
 */
import {
  init as coreInit,
  RenderingEngine,
  CONSTANTS,
  Enums,
  volumeLoader,
  cornerstoneStreamingImageVolumeLoader,
  setVolumesForViewports,
  eventTarget,
  utilities as csUtils,
  cache,
  getRenderingEngine,
  type Types,
} from '@cornerstonejs/core';
import { init as dicomImageLoaderInit, wadouri } from '@cornerstonejs/dicom-image-loader';
import {
  init as toolsInit,
  addTool,
  ToolGroupManager,
  Enums as csToolsEnums,
  annotation as csAnnotation,
  WindowLevelTool,
  PanTool,
  ZoomTool,
  StackScrollTool,
  CrosshairsTool,
  LengthTool,
  BidirectionalTool,
  AngleTool,
  ProbeTool,
  EllipticalROITool,
  RectangleROITool,
  PlanarFreehandROITool,
  CircleROITool,
  TrackballRotateTool,
} from '@cornerstonejs/tools';

import { imageIdFor, type SeriesDetail } from '../api/client';
import { useAppStore, type Measurement, type PaneId } from '../store/useAppStore';
import { SLAB_OPTIONS, WINDOW_PRESETS, volumePresetsFor } from './presets';
import { planSliceJump } from './sliceNav';
import { anatomyProbe } from '../labels/anatomyProbe';
import {
  autoWindowForVolume,
  defaultPresetId,
  normaliseModality,
  presetsFor,
  rescalePresetToData,
  resolveWindow,
  inferSequenceKind,
  type Modality,
} from './modality';

const { MouseBindings } = csToolsEnums;
const { ViewportType, OrientationAxis, BlendModes } = Enums;

export const ENGINE_ID = 'hnrad-engine';

export const VIEWPORT_ID: Record<PaneId, string> = {
  axial: 'hnrad-axial',
  sagittal: 'hnrad-sagittal',
  coronal: 'hnrad-coronal',
  volume3d: 'hnrad-volume3d',
  stack: 'hnrad-stack',
};

const TG_MPR = 'hnrad-tg-mpr';
const TG_3D = 'hnrad-tg-3d';
const TG_STACK = 'hnrad-tg-stack';

const MPR_PANES: PaneId[] = ['axial', 'sagittal', 'coronal'];

const PLANE_COLOR: Record<string, string> = {
  [VIEWPORT_ID.axial]: 'rgb(125, 211, 252)',
  [VIEWPORT_ID.sagittal]: 'rgb(192, 132, 252)',
  [VIEWPORT_ID.coronal]: 'rgb(74, 222, 128)',
};

export interface RailTool {
  name: string;
  label: string;
  /** Single-key hotkey, no modifier (gloved / one-handed use). */
  key: string;
  group: 'navigate' | 'measure';
  mprOnly?: boolean;
}

/**
 * Left-rail tools in rail order. Digits 1..9 also select them in this order
 * (CONTRACT.md) alongside the letter hotkeys from DESIGN.md.
 *
 * Note: DESIGN.md lists F for Freehand ROI but also F for maximize. F stays
 * on maximize (CONTRACT.md + the viewport section) and Freehand moves to D.
 */
export const RAIL_TOOLS: RailTool[] = [
  { name: 'WindowLevel', label: 'Window / Level', key: 'w', group: 'navigate' },
  { name: 'Pan', label: 'Pan', key: 'p', group: 'navigate' },
  { name: 'Zoom', label: 'Zoom', key: 'z', group: 'navigate' },
  { name: 'StackScroll', label: 'Scroll slices', key: 's', group: 'navigate' },
  { name: 'Crosshairs', label: 'Crosshairs', key: 'x', group: 'navigate', mprOnly: true },
  { name: 'Length', label: 'Length', key: 'l', group: 'measure' },
  { name: 'Bidirectional', label: 'Bidirectional', key: 'b', group: 'measure' },
  { name: 'Angle', label: 'Angle', key: 'a', group: 'measure' },
  { name: 'EllipticalROI', label: 'Ellipse ROI', key: 'e', group: 'measure' },
  { name: 'RectangleROI', label: 'Rectangle ROI', key: 't', group: 'measure' },
  { name: 'PlanarFreehandROI', label: 'Freehand ROI', key: 'd', group: 'measure' },
  { name: 'Probe', label: 'Probe · HU', key: 'h', group: 'measure' },
];

const ANNOTATION_TOOLS = [
  'Length',
  'Bidirectional',
  'Angle',
  'Probe',
  'EllipticalROI',
  'RectangleROI',
  'PlanarFreehandROI',
];

/**
 * Annotation tools driven by a head-and-neck tool rather than by the rail.
 * They live in every tool group so `setActiveTool` can reach them, but they
 * stay out of ANNOTATION_TOOLS so their scratch annotations do not clutter the
 * measurement list — the tool publishes its own row instead.
 *
 * The carotid lumen circle is an input, not a measurement: an empty text-line
 * list keeps its outline on the image without a stats box over the tumour.
 */
const TOOL_DRIVEN_TOOLS: Array<[string, Record<string, unknown>]> = [
  ['CircleROI', { getTextLines: () => [] as string[] }],
];

const TOOL_DRIVEN_NAMES = TOOL_DRIVEN_TOOLS.map(([name]) => name);

const MEASUREMENT_LABEL: Record<string, string> = {
  Length: 'Length',
  Bidirectional: 'Bidirectional',
  Angle: 'Angle',
  Probe: 'Probe',
  EllipticalROI: 'Ellipse ROI',
  RectangleROI: 'Rectangle ROI',
  PlanarFreehandROI: 'Freehand ROI',
  CobbAngle: 'Cobb angle',
};

/* ------------------------------------------------------------------ */
/* one-time initialisation                                            */
/* ------------------------------------------------------------------ */

let initPromise: Promise<void> | null = null;

export function initCornerstone(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await coreInit();
    await dicomImageLoaderInit({
      maxWebWorkers: Math.max(1, (navigator.hardwareConcurrency || 4) - 1),
      // 5.x defaults to the naturalized-metadata provider, which only knows
      // about instances pushed in as Part-10 buffers. We stream straight from
      // the local index over wadouri, so keep the dataSet-backed provider that
      // reads from dataSetCacheManager (primed in prefetchMetadata below).
      useLegacyMetadataProvider: true,
    });
    await toolsInit();

    volumeLoader.registerVolumeLoader(
      'cornerstoneStreamingImageVolume',
      cornerstoneStreamingImageVolumeLoader as unknown as Types.VolumeLoaderFn,
    );
    volumeLoader.registerUnknownVolumeLoader(
      cornerstoneStreamingImageVolumeLoader as unknown as Types.VolumeLoaderFn,
    );

    [
      WindowLevelTool,
      PanTool,
      ZoomTool,
      StackScrollTool,
      CrosshairsTool,
      LengthTool,
      BidirectionalTool,
      AngleTool,
      ProbeTool,
      EllipticalROITool,
      RectangleROITool,
      PlanarFreehandROITool,
      CircleROITool,
      TrackballRotateTool,
    ].forEach((t) => addTool(t));

    // setDefaultToolStyles REPLACES the default style object, so merge rather
    // than overwrite — dropping textBoxVisibility silently hides every
    // on-image measurement label.
    const baseStyles = csAnnotation.config.style.getDefaultToolStyles();
    csAnnotation.config.style.setDefaultToolStyles({
      global: {
        ...(baseStyles?.global ?? {}),
        color: 'rgb(45, 212, 191)',
        colorHighlighted: 'rgb(94, 234, 212)',
        colorSelected: 'rgb(94, 234, 212)',
        lineWidth: '1.4',
        textBoxFontFamily: "'JetBrains Mono', ui-monospace, monospace",
        textBoxFontSize: '12px',
        textBoxColor: 'rgb(45, 212, 191)',
        textBoxColorHighlighted: 'rgb(94, 234, 212)',
        textBoxColorSelected: 'rgb(94, 234, 212)',
        textBoxBackground: 'rgba(10, 12, 16, 0.72)',
        shadow: true,
      },
    });
  })();
  return initPromise;
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function firstStats(data: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!data) return null;
  const keys = Object.keys(data);
  if (!keys.length) return null;
  const v = data[keys[0]];
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function describeAnnotation(
  toolName: string,
  stats: Record<string, unknown> | null,
): { value: string; extra: string } {
  const num = (k: string): number | null => {
    const v = stats?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  switch (toolName) {
    case 'Length': {
      const l = num('length');
      return { value: l === null ? '—' : `${fmt(l)} mm`, extra: '' };
    }
    case 'Bidirectional': {
      const l = num('length');
      const w = num('width');
      return {
        value: l === null ? '—' : `${fmt(l)} × ${fmt(w ?? 0)} mm`,
        extra: l !== null && w !== null ? `ratio ${fmt(l / (w || 1), 2)}` : '',
      };
    }
    case 'Angle':
    case 'CobbAngle': {
      const a = num('angle');
      return { value: a === null ? '—' : `${fmt(a)}°`, extra: '' };
    }
    case 'Probe': {
      const raw = stats?.['value'];
      const v = Array.isArray(raw) ? raw[0] : raw;
      return {
        value: typeof v === 'number' ? `${Math.round(v)} HU` : '—',
        extra: '',
      };
    }
    default: {
      const mean = num('mean');
      const area = num('area');
      const sd = num('stdDev');
      const mx = num('max');
      const parts: string[] = [];
      if (area !== null) parts.push(`${fmt(area)} mm²`);
      if (sd !== null) parts.push(`σ ${fmt(sd)}`);
      if (mx !== null) parts.push(`max ${Math.round(mx)}`);
      return {
        value: mean === null ? (area === null ? '—' : `${fmt(area)} mm²`) : `${Math.round(mean)} HU`,
        extra: parts.join(' · '),
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* the core                                                           */
/* ------------------------------------------------------------------ */

class ViewerCore {
  private engine: RenderingEngine | null = null;
  private elements = new Map<PaneId, HTMLDivElement>();
  private resizeObserver: ResizeObserver | null = null;
  private volumeId: string | null = null;
  /** Modality of the series on screen — drives windowing and ROI units. */
  private modality: Modality = 'CT';
  private sequenceKind: ReturnType<typeof inferSequenceKind> = null;
  /** The linked second series shown in place of the 3D pane, if any. */
  private linkedVolumeId: string | null = null;
  private linkSync: (() => void) | null = null;
  /** True once the data-derived window has been applied for the current load. */
  private autoWindowDone = false;
  /** The window Margin last asked for, so a late viewport can be corrected. */
  private appliedWindow: { ww: number; wc: number } | null = null;
  private mode: 'mpr' | 'stack' | null = null;
  private activePanes: PaneId[] = [];
  private cineTimer: number | null = null;
  private probeRaf = 0;
  private lastProbeAt = 0;
  private boundEvents = false;
  private loadToken = 0;
  /** Rows published by a head-and-neck tool rather than by a Cornerstone annotation. */
  private derived = new Map<string, Measurement>();
  /** View reference (annotation metadata) that makes a derived row jumpable. */
  private derivedRefs = new Map<string, unknown>();
  /** Per-pane camera/VOI listeners, keyed by the element they were added to. */
  private elementListeners = new Map<HTMLDivElement, () => void>();
  /** Panes with a pane-state refresh already queued for the current task. */
  private refreshQueued = new Set<PaneId>();

  /* ---------------- element registration ---------------- */

  registerElement(id: PaneId, el: HTMLDivElement | null): void {
    const prev = this.elements.get(id);
    if (prev && prev !== el) this.unlistenElement(prev);
    if (el) {
      this.elements.set(id, el);
      this.listenElement(id, el);
    } else {
      this.elements.delete(id);
    }
  }

  /**
   * Cornerstone dispatches CAMERA_MODIFIED / VOI_MODIFIED on the viewport's
   * DOM element (non-bubbling), not on the global eventTarget, so the overlay
   * only tracks crosshair drags, wheel scrolls and W/L drags if we listen
   * here. Without this the "n / total" badge went stale after a Crosshairs
   * reset while annotations kept the true slice index.
   */
  private listenElement(id: PaneId, el: HTMLDivElement): void {
    if (this.elementListeners.has(el)) return;
    const handler = () => this.scheduleRefresh(id);
    el.addEventListener(Enums.Events.CAMERA_MODIFIED, handler);
    el.addEventListener(Enums.Events.VOI_MODIFIED, handler);
    this.elementListeners.set(el, handler);
  }

  private unlistenElement(el: HTMLDivElement): void {
    const handler = this.elementListeners.get(el);
    if (!handler) return;
    el.removeEventListener(Enums.Events.CAMERA_MODIFIED, handler);
    el.removeEventListener(Enums.Events.VOI_MODIFIED, handler);
    this.elementListeners.delete(el);
  }

  /**
   * Coalesce the burst of camera events a single interaction produces (e.g.
   * Crosshairs moving two viewports per mouse move) into one store update.
   * A microtask, not requestAnimationFrame: frames stop in a hidden tab and a
   * never-firing frame would block every later refresh for that pane.
   */
  private scheduleRefresh(pane: PaneId): void {
    if (this.refreshQueued.has(pane)) return;
    this.refreshQueued.add(pane);
    queueMicrotask(() => {
      this.refreshQueued.delete(pane);
      this.refreshPaneState(pane);
    });
  }

  /** The Cornerstone host element for a pane — the mount point for tool overlays. */
  getElement(id: PaneId): HTMLDivElement | null {
    return this.elements.get(id) ?? null;
  }

  /** Which panes are live for the series on screen. */
  get panes(): PaneId[] {
    return [...this.activePanes];
  }

  observeStage(stage: HTMLElement | null): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (!stage) return;
    let raf = 0;
    this.resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => this.resize());
    });
    this.resizeObserver.observe(stage);
  }

  /**
   * Re-fit the canvases after a layout or window change.
   *
   * The second argument is Cornerstone's `keepCamera`, and it must be true.
   * With false, every resize — switching layout, dragging the window edge,
   * opening the Ask drawer — silently reset the camera, throwing away the
   * user's pan, zoom and slice. It also made `jumpToWorld` look broken:
   * a finding jumped to its slice and the resize that followed the panel
   * change put the view straight back.
   */
  resize(): void {
    try {
      this.engine?.resize(true, true);
    } catch {
      /* engine may be mid-teardown */
    }
  }

  get renderingEngine(): RenderingEngine | null {
    return this.engine;
  }

  getViewport(id: PaneId): Types.IViewport | null {
    if (!this.engine) return null;
    try {
      return this.engine.getViewport(VIEWPORT_ID[id]) ?? null;
    } catch {
      return null;
    }
  }

  /* ---------------- geometry helpers for head & neck tools ---------------- */

  /** The streaming CT volume currently on the MPR panes (null in stack mode). */
  get ctVolumeId(): string | null {
    return this.mode === 'mpr' ? this.volumeId : null;
  }

  /** The cached CT volume, for grid checks and world <-> index maths. */
  getCtVolume(): Types.IImageVolume | null {
    if (!this.volumeId || this.mode !== 'mpr') return null;
    return (cache.getVolume(this.volumeId) as Types.IImageVolume | undefined) ?? null;
  }

  /** Frame of reference of the loaded volume — surfaces must declare one. */
  getFrameOfReferenceUID(): string {
    const v = this.getCtVolume() as
      | (Types.IImageVolume & { metadata?: { FrameOfReferenceUID?: string } })
      | null;
    return v?.metadata?.FrameOfReferenceUID ?? 'hnrad-unknown-for';
  }

  /** The MPR pane ids that are live for this series. */
  get mprPanes(): PaneId[] {
    return this.mode === 'mpr' ? [...MPR_PANES] : [];
  }

  /** Voxel index under a world (LPS mm) point, or null when it is outside. */
  worldToIjk(world: Types.Point3): [number, number, number] | null {
    const vol = this.getCtVolume();
    if (!vol?.imageData || !vol.dimensions) return null;
    try {
      const idx = csUtils.transformWorldToIndex(vol.imageData, world) as number[];
      const ijk: [number, number, number] = [
        Math.round(idx[0]),
        Math.round(idx[1]),
        Math.round(idx[2] ?? 0),
      ];
      const [di, dj, dk] = vol.dimensions;
      if (ijk[0] < 0 || ijk[1] < 0 || ijk[2] < 0 || ijk[0] >= di || ijk[1] >= dj || ijk[2] >= dk) {
        return null;
      }
      return ijk;
    } catch {
      return null;
    }
  }

  /** HU at a voxel index of the loaded CT volume. */
  huAtIjk(ijk: [number, number, number]): number | null {
    const vol = this.getCtVolume();
    const vm = vol?.voxelManager as
      | { getAtIJK?: (i: number, j: number, k: number) => number }
      | undefined;
    if (!vm?.getAtIJK) return null;
    try {
      const v = vm.getAtIJK(ijk[0], ijk[1], ijk[2]);
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }

  /**
   * Bring a world point into view on every MPR pane.
   *
   * Deliberately a view-reference / camera focal point move rather than a slice
   * index: `setViewReference` is what the carotid tool already relies on, which
   * keeps this independent of the slice scrubber's own navigation path.
   */
  jumpToWorld(world: Types.Point3): void {
    if (this.mode !== 'mpr') return;
    MPR_PANES.forEach((pane) => {
      const vp = this.getViewport(pane) as
        | (Types.IViewport & {
            setViewReference?: (r: unknown) => void;
            getViewReference?: () => Record<string, unknown>;
            getCamera?: () => { focalPoint?: Types.Point3; position?: Types.Point3 };
            setCamera?: (c: unknown) => void;
            render?: () => void;
          })
        | null;
      if (!vp) return;
      try {
        // Only FrameOfReferenceUID + cameraFocalPoint. Spreading the whole
        // reference would carry its `sliceIndex`, and BaseVolumeViewport takes
        // the slice-index branch first — a delta of zero, i.e. no movement.
        const forUid = (
          vp as unknown as { getFrameOfReferenceUID?: () => string }
        ).getFrameOfReferenceUID?.();
        if (forUid && vp.setViewReference) {
          vp.setViewReference({
            FrameOfReferenceUID: forUid,
            cameraFocalPoint: [world[0], world[1], world[2]],
          });
        } else {
          const cam = vp.getCamera?.();
          const focal = cam?.focalPoint;
          const pos = cam?.position;
          if (focal && pos) {
            const shift = [world[0] - focal[0], world[1] - focal[1], world[2] - focal[2]];
            vp.setCamera?.({
              focalPoint: [world[0], world[1], world[2]] as Types.Point3,
              position: [pos[0] + shift[0], pos[1] + shift[1], pos[2] + shift[2]] as Types.Point3,
            });
          }
        }
        vp.render?.();
        this.refreshPaneState(pane);
      } catch (e) {
        console.warn('[hnrad] could not jump to world point', e);
      }
    });
  }

  /**
   * Park a vtk actor in the 3D viewport (structure surfaces). Actors are keyed
   * by uid so a structure can replace or remove its own without disturbing the
   * volume actor.
   */
  addActorTo3d(uid: string, actor: unknown): boolean {
    const vp = this.getViewport('volume3d') as
      | (Types.IViewport & {
          addActor?: (e: { uid: string; actor: unknown }) => void;
          getActor?: (uid: string) => unknown;
          removeActors?: (uids: string[]) => void;
          render?: () => void;
        })
      | null;
    if (!vp?.addActor) return false;
    try {
      if (vp.getActor?.(uid)) vp.removeActors?.([uid]);
      vp.addActor({ uid, actor });
      vp.render?.();
      return true;
    } catch (e) {
      console.warn('[hnrad] could not add a 3D actor', e);
      return false;
    }
  }

  removeActorFrom3d(uid: string): void {
    const vp = this.getViewport('volume3d') as
      | (Types.IViewport & { removeActors?: (uids: string[]) => void; render?: () => void })
      | null;
    try {
      vp?.removeActors?.([uid]);
      vp?.render?.();
    } catch {
      /* the actor was never added, or the engine is gone */
    }
  }

  render3d(): void {
    try {
      this.engine?.renderViewports([VIEWPORT_ID.volume3d]);
    } catch {
      /* engine mid-teardown */
    }
  }

  /* ---------------- display a series ---------------- */

  async display(series: SeriesDetail): Promise<void> {
    const token = ++this.loadToken;
    const store = useAppStore.getState();
    store.set({ viewerError: null });
    this.autoWindowDone = false;
    this.appliedWindow = null;
    // A measurement belongs to the series it was drawn on. Annotations live in
    // Cornerstone's global state and derived rows live here, so neither is
    // cleared by the store reset in `openSeries` — without this, the previous
    // patient's ROI reappeared on the next study.
    this.clearMeasurements();

    const instances = [...(series.instances ?? [])];
    if (!instances.length) {
      store.set({ viewerError: 'This series contains no instances.' });
      return;
    }

    const imageIds = instances.map((i) => imageIdFor(i.sop_uid));
    const volumetric = series.is_3d && imageIds.length >= 3;
    this.mode = volumetric ? 'mpr' : 'stack';
    this.activePanes = volumetric ? ['axial', 'sagittal', 'coronal', 'volume3d'] : ['stack'];

    await initCornerstone();
    if (token !== this.loadToken) return;

    this.stopCine();
    this.teardownEngine();

    const engine = new RenderingEngine(ENGINE_ID);
    this.engine = engine;

    // Modality decides which preset table applies and whether the window has
    // to be learned from the data (MR has no absolute intensity scale).
    this.modality = normaliseModality(series.modality);
    this.sequenceKind = inferSequenceKind(series);
    const table = presetsFor(this.modality, WINDOW_PRESETS);
    const wantId = defaultPresetId(this.modality, this.sequenceKind) ?? store.windowPresetId;
    const preset = table.find((p) => p.id === wantId) ?? table[0];
    store.set({ windowPresetId: preset.id, windowSource: 'preset' });

    // Ask the backend for a modality-aware window first; it knows the DICOM
    // WindowWidth/WindowCenter and can compute percentiles server-side. The
    // route is being added, so a 404 just falls through to the preset and,
    // for MR, to the client-side percentile pass once the volume is resident.
    const resolved = await resolveWindow(series, { ww: preset.ww, wc: preset.wc });
    if (token !== this.loadToken) return;
    if (resolved.source !== 'fallback') {
      store.set({ windowSource: resolved.source });
    }
    const openWw = resolved.ww;
    const openWc = resolved.wc;

    if (!volumetric) {
      await this.setupStack(engine, imageIds, openWw, openWc);
      if (token !== this.loadToken) return;
      this.bindEvents();
      useAppStore.getState().set({
        layout: 'stack',
        activePane: 'stack',
        maximized: null,
        loading: { active: false, loaded: 0, total: 0, label: '' },
      });
      this.refreshAllPaneState();
      return;
    }

    await this.setupMpr(engine, series, imageIds, token, openWw, openWc);
  }

  /**
   * Tear the engine down, disabling every tool first.
   *
   * `destroyToolGroup` alone is not enough: a tool that subscribed to the
   * viewport's DOM element (CrosshairsTool does, for VOLUME_NEW_IMAGE) keeps
   * that listener, and React reuses the same divs across a series change. The
   * orphaned instance then fires with `this.toolGroup === undefined` the next
   * time any volume appears — including a segmentation labelmap — and throws
   * "Cannot read properties of undefined (reading 'viewportsInfo')" on every
   * pointer interaction afterwards. Disabling the tool runs its own cleanup,
   * which removes the listener.
   */
  private teardownEngine(): void {
    [TG_MPR, TG_3D, TG_STACK].forEach((id) => {
      const tg = ToolGroupManager.getToolGroup(id);
      if (tg) {
        try {
          Object.keys(tg.toolOptions ?? {}).forEach((name) => {
            try {
              tg.setToolDisabled(name);
            } catch {
              /* a tool that was never enabled */
            }
          });
          tg.removeViewports(ENGINE_ID);
        } catch {
          /* the group may already be half torn down */
        }
      }
      try {
        ToolGroupManager.destroyToolGroup(id);
      } catch {
        /* not created yet */
      }
    });
    try {
      getRenderingEngine(ENGINE_ID)?.destroy();
    } catch {
      /* already gone */
    }
    this.engine = null;
  }

  /* ---------------- stack (scouts, single slices) ---------------- */

  private async setupStack(
    engine: RenderingEngine,
    imageIds: string[],
    ww: number,
    wc: number,
  ): Promise<void> {
    const el = this.elements.get('stack');
    if (!el) throw new Error('Stack viewport element is not mounted');

    engine.setViewports([
      {
        viewportId: VIEWPORT_ID.stack,
        type: ViewportType.STACK,
        element: el,
        defaultOptions: { background: [0, 0, 0] as Types.Point3 },
      },
    ]);

    const vp = engine.getViewport(VIEWPORT_ID.stack) as Types.IStackViewport;
    await vp.setStack(imageIds, Math.floor(imageIds.length / 2));
    vp.setProperties({ voiRange: csUtils.windowLevel.toLowHighRange(ww, wc) });
    vp.render();

    const tg = ToolGroupManager.createToolGroup(TG_STACK);
    if (!tg) throw new Error('Could not create the stack tool group');
    [
      WindowLevelTool.toolName,
      PanTool.toolName,
      ZoomTool.toolName,
      StackScrollTool.toolName,
      ...ANNOTATION_TOOLS,
    ].forEach((t) => tg.addTool(t as string));
    TOOL_DRIVEN_TOOLS.forEach(([t, cfg]) => tg.addTool(t, cfg));
    tg.addViewport(VIEWPORT_ID.stack, ENGINE_ID);
    [...ANNOTATION_TOOLS, ...TOOL_DRIVEN_NAMES].forEach((t) => tg.setToolPassive(t));
    tg.setToolActive(WindowLevelTool.toolName, {
      bindings: [{ mouseButton: MouseBindings.Primary }],
    });
    tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
    tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
    tg.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });

    useAppStore.getState().set({ activeTool: 'WindowLevel' });
  }

  /* ---------------- MPR + 3D ---------------- */

  private async setupMpr(
    engine: RenderingEngine,
    series: SeriesDetail,
    imageIds: string[],
    token: number,
    ww: number,
    wc: number,
  ): Promise<void> {
    const store = useAppStore.getState();
    const missing = this.activePanes.filter((p) => !this.elements.get(p));
    if (missing.length) throw new Error(`Viewport element missing: ${missing.join(', ')}`);

    engine.setViewports([
      {
        viewportId: VIEWPORT_ID.axial,
        type: ViewportType.ORTHOGRAPHIC,
        element: this.elements.get('axial') as HTMLDivElement,
        defaultOptions: { orientation: OrientationAxis.AXIAL, background: [0, 0, 0] as Types.Point3 },
      },
      {
        viewportId: VIEWPORT_ID.sagittal,
        type: ViewportType.ORTHOGRAPHIC,
        element: this.elements.get('sagittal') as HTMLDivElement,
        defaultOptions: { orientation: OrientationAxis.SAGITTAL, background: [0, 0, 0] as Types.Point3 },
      },
      {
        viewportId: VIEWPORT_ID.coronal,
        type: ViewportType.ORTHOGRAPHIC,
        element: this.elements.get('coronal') as HTMLDivElement,
        defaultOptions: { orientation: OrientationAxis.CORONAL, background: [0, 0, 0] as Types.Point3 },
      },
      {
        viewportId: VIEWPORT_ID.volume3d,
        type: ViewportType.VOLUME_3D,
        element: this.elements.get('volume3d') as HTMLDivElement,
        defaultOptions: {
          orientation: OrientationAxis.CORONAL,
          background: [0.039, 0.047, 0.063] as Types.Point3,
        },
      },
    ]);

    const volumeId = `cornerstoneStreamingImageVolume:${series.series_uid}`;
    this.volumeId = volumeId;

    store.set({
      layout: 'mpr',
      maximized: null,
      activePane: 'axial',
      loading: { active: true, loaded: 0, total: imageIds.length, label: 'Streaming volume' },
    });

    // wadouri metadata only exists once each Part-10 header has been parsed,
    // so prime the dataset cache before asking for a volume. The bytes are
    // cached, so the streaming load that follows does not re-download them.
    store.set({
      loading: { active: true, loaded: 0, total: imageIds.length, label: 'Reading headers' },
    });
    await this.prefetchMetadata(imageIds, token);
    if (token !== this.loadToken) return;

    store.set({
      loading: { active: true, loaded: 0, total: imageIds.length, label: 'Streaming volume' },
    });

    let volume: Types.IImageVolume;
    try {
      volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds });
    } catch (e) {
      store.set({
        viewerError: `Could not build the volume: ${(e as Error)?.message ?? e}`,
        loading: { active: false, loaded: 0, total: 0, label: '' },
      });
      return;
    }
    if (token !== this.loadToken) return;

    const onProgress = (evt: Event) => {
      const detail = (evt as CustomEvent).detail as {
        volumeId?: string;
        framesProcessed?: number;
        numberOfFrames?: number;
      };
      if (detail?.volumeId !== volumeId) return;
      const s = useAppStore.getState();
      if (!s.loading.active) return;
      s.set({
        loading: {
          active: true,
          loaded: detail.framesProcessed ?? 0,
          total: detail.numberOfFrames ?? imageIds.length,
          label: 'Streaming volume',
        },
      });
    };
    eventTarget.addEventListener(Enums.Events.IMAGE_VOLUME_MODIFIED, onProgress);

    const finish = () => {
      eventTarget.removeEventListener(Enums.Events.IMAGE_VOLUME_MODIFIED, onProgress);
      eventTarget.removeEventListener(Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, finish);
      useAppStore.getState().set({ loading: { active: false, loaded: 0, total: 0, label: '' } });
      // The window can only be learned from the data once the data is there.
      this.autoWindowFromData(token);
      this.refreshAllPaneState();
    };
    eventTarget.addEventListener(Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, finish);

    (volume as unknown as { load: (cb?: () => void) => void }).load();

    await setVolumesForViewports(
      engine,
      [{ volumeId }],
      MPR_PANES.map((p) => VIEWPORT_ID[p]),
    );
    if (token !== this.loadToken) return;

    // A short MR series can finish loading before this line is reached, so the
    // data-derived window may already be on screen. Do not stamp the preset
    // back over it.
    if (!this.autoWindowDone) {
      MPR_PANES.forEach((p) => {
        const vp = engine.getViewport(VIEWPORT_ID[p]) as Types.IVolumeViewport;
        vp.setProperties({ voiRange: csUtils.windowLevel.toLowHighRange(ww, wc) });
      });
    }

    await setVolumesForViewports(engine, [{ volumeId }], [VIEWPORT_ID.volume3d]);
    if (token !== this.loadToken) return;
    try {
      // The 3D transfer function has to match the modality or the render is a
      // featureless block; a CT window on MR signal means nothing.
      const list = volumePresetsFor(series.modality);
      const current = useAppStore.getState().volumePresetId;
      const presetId = list.some((p) => p.id === current) ? current : list[0].id;
      const vp3d = engine.getViewport(VIEWPORT_ID.volume3d) as Types.IVolumeViewport;
      vp3d.setProperties({ preset: presetId });
      useAppStore.getState().set({ volumePresetId: presetId });
      this.resetVolumeCamera();
    } catch (e) {
      console.warn('[hnrad] 3D preset could not be applied', e);
    }

    this.createMprToolGroups();
    this.bindEvents();
    engine.render();

    // Safety net: if the completion event is missed, clear the bar anyway, and
    // give the data-derived window a second chance now that every viewport has
    // its volume and its VOI.
    window.setTimeout(() => {
      const s = useAppStore.getState();
      if (s.loading.active && s.loading.loaded >= s.loading.total && s.loading.total > 0) finish();
      else this.autoWindowFromData(token);
      // Re-assert the window Margin actually asked for. A viewport that
      // received its volume late keeps Cornerstone's own default VOI, so the
      // three planes end up disagreeing about the same tissue — and reading
      // the pane back would just propagate whichever one lost the race.
      if (token === this.loadToken && this.mode === 'mpr' && this.appliedWindow) {
        this.applyWindow(this.appliedWindow.ww, this.appliedWindow.wc);
      }
    }, 1200);

    this.refreshAllPaneState();
  }

  /* ---------------- modality-aware windowing ---------------- */

  /**
   * MR (and PET) have no absolute intensity scale: a fixed W/L is meaningless
   * across scanners, sequences and even reconstructions of the same exam. So
   * once the volume is resident, take a percentile window from the voxels
   * themselves. CT keeps its HU presets and is skipped.
   *
   * Runs once per load, and only when nothing better already arrived
   * (`windowSource` stays 'preset' until the backend or this pass replaces it).
   */
  private autoWindowFromData(token: number): void {
    if (token !== this.loadToken) return;
    if (this.modality === 'CT' || this.autoWindowDone) return;
    const store = useAppStore.getState();
    // Something better than a preset already arrived (the backend's own
    // window); leave it alone.
    if (store.windowSource !== 'preset') return;

    const samples = this.sampleVolume();
    if (!samples) return;
    const auto = autoWindowForVolume(samples, this.modality);
    if (!auto) return;

    this.autoWindowDone = true;
    this.applyWindow(auto.ww, auto.wc);
    useAppStore.getState().set({ windowSource: 'percentile' });
  }

  /**
   * A strided sample of the loaded volume, for histogram work.
   *
   * Deliberately NOT `voxelManager.getCompleteScalarDataArray()`: that
   * allocates and refills a full copy (~47 MB on a 512x512x180), which is a
   * visible hitch on the Intel iGPU this runs on. Striding to roughly
   * 180x180x90 samples is ~1/18th of the voxels, far more than a 512-bin
   * histogram needs, and costs a few milliseconds.
   */
  private sampleVolume(): Float32Array | null {
    const vol = this.getCtVolume();
    const vm = vol?.voxelManager as
      | { getAtIJK?: (i: number, j: number, k: number) => number }
      | undefined;
    if (!vol?.dimensions || !vm?.getAtIJK) return null;
    const [nx, ny, nz] = vol.dimensions;
    if (!(nx > 0 && ny > 0 && nz > 0)) return null;

    const sx = Math.max(1, Math.round(nx / 180));
    const sy = Math.max(1, Math.round(ny / 180));
    const sz = Math.max(1, Math.round(nz / 90));
    const out = new Float32Array(Math.ceil(nx / sx) * Math.ceil(ny / sy) * Math.ceil(nz / sz));
    let n = 0;
    try {
      for (let k = 0; k < nz; k += sz) {
        for (let j = 0; j < ny; j += sy) {
          for (let i = 0; i < nx; i += sx) {
            const v = vm.getAtIJK(i, j, k);
            if (typeof v === 'number' && Number.isFinite(v)) out[n++] = v;
          }
        }
      }
    } catch {
      return n > 32 ? out.subarray(0, n) : null;
    }
    return n > 32 ? out.subarray(0, n) : null;
  }

  /** The window presets that apply to the series on screen. */
  get windowPresets(): typeof WINDOW_PRESETS {
    return presetsFor(this.modality, WINDOW_PRESETS);
  }

  get currentModality(): Modality {
    return this.modality;
  }

  /**
   * Apply a preset by id. For MR the preset is a *ratio*, re-anchored onto the
   * data's own centre, because a stored width/centre pair means nothing across
   * scanners - see `rescalePresetToData`.
   */
  applyPreset(presetId: string): void {
    const preset = this.windowPresets.find((p) => p.id === presetId);
    if (!preset) return;
    if (this.modality === 'CT') {
      this.applyWindow(preset.ww, preset.wc, preset.id);
      return;
    }
    const pane = useAppStore.getState().panes[this.mode === 'stack' ? 'stack' : 'axial'];
    const scaled = rescalePresetToData(preset, { ww: pane.ww, wc: pane.wc });
    this.applyWindow(scaled.ww, scaled.wc, preset.id);
  }

  /* ---------------- linked second series ---------------- */

  /**
   * Show a second series in the 3D pane and keep it on the same world point as
   * the primary (the brief: "linked scrolling across series of the same
   * FrameOfReference").
   *
   * World position, not slice index: the two series will not share a slice
   * grid - a 1 mm CT and a 4 mm T2 disagree about what "slice 40" means - but
   * they do share millimetres when they share a FrameOfReference, and that is
   * the only thing that stays true when either is reformatted.
   */
  async setLinkedSeries(series: SeriesDetail | null): Promise<boolean> {
    this.unlink();
    if (!series || this.mode !== 'mpr' || !this.engine) return false;

    const el = this.elements.get('volume3d');
    if (!el) return false;

    const imageIds = (series.instances ?? []).map((i) => imageIdFor(i.sop_uid));
    if (imageIds.length < 3) return false;

    try {
      await this.prefetchMetadata(imageIds, this.loadToken);
      const volumeId = `cornerstoneStreamingImageVolume:${series.series_uid}`;
      const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds });
      (volume as unknown as { load: (cb?: () => void) => void }).load();
      this.linkedVolumeId = volumeId;

      // Re-enable the element as an orthographic viewport in the plane the
      // user is reading, so the two images are directly comparable.
      const primary = useAppStore.getState().primaryPane;
      const orientation =
        primary === 'sagittal'
          ? OrientationAxis.SAGITTAL
          : primary === 'coronal'
            ? OrientationAxis.CORONAL
            : OrientationAxis.AXIAL;

      this.engine.enableElement({
        viewportId: VIEWPORT_ID.volume3d,
        type: ViewportType.ORTHOGRAPHIC,
        element: el,
        defaultOptions: { orientation, background: [0, 0, 0] as Types.Point3 },
      });
      await setVolumesForViewports(this.engine, [{ volumeId }], [VIEWPORT_ID.volume3d]);

      try {
        ToolGroupManager.getToolGroup(TG_3D)?.removeViewports(ENGINE_ID, VIEWPORT_ID.volume3d);
      } catch {
        /* the 3D group may already be gone */
      }
      ToolGroupManager.getToolGroup(TG_MPR)?.addViewport(VIEWPORT_ID.volume3d, ENGINE_ID);

      this.bindLinkSync(primary);
      this.engine.render();
      this.refreshPaneState('volume3d');
      return true;
    } catch (e) {
      console.warn('[hnrad] could not link a second series', e);
      this.unlink();
      return false;
    }
  }

  /** Push the primary pane's focal point into the linked viewport. */
  private bindLinkSync(primary: PaneId): void {
    const src = this.elements.get(primary);
    if (!src) return;
    let queued = false;
    const handler = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        const from = this.getViewport(primary) as
          | (Types.IViewport & { getCamera?: () => { focalPoint?: Types.Point3 } })
          | null;
        const to = this.getViewport('volume3d') as
          | (Types.IViewport & {
              setViewReference?: (r: unknown) => void;
              getFrameOfReferenceUID?: () => string;
              render?: () => void;
            })
          | null;
        const focal = from?.getCamera?.()?.focalPoint;
        if (!focal || !to?.setViewReference) return;
        try {
          const forUid = to.getFrameOfReferenceUID?.();
          to.setViewReference({
            FrameOfReferenceUID: forUid,
            cameraFocalPoint: [focal[0], focal[1], focal[2]],
          });
          to.render?.();
          this.refreshPaneState('volume3d');
        } catch {
          /* the linked volume may not cover this point */
        }
      });
    };
    src.addEventListener(Enums.Events.CAMERA_MODIFIED, handler);
    this.linkSync = () => src.removeEventListener(Enums.Events.CAMERA_MODIFIED, handler);
  }

  /** Drop the link and put the 3D volume viewport back. */
  unlink(): void {
    this.linkSync?.();
    this.linkSync = null;
    if (!this.linkedVolumeId) return;
    this.linkedVolumeId = null;
    const el = this.elements.get('volume3d');
    if (!this.engine || !el || !this.volumeId) return;
    try {
      this.engine.enableElement({
        viewportId: VIEWPORT_ID.volume3d,
        type: ViewportType.VOLUME_3D,
        element: el,
        defaultOptions: {
          orientation: OrientationAxis.CORONAL,
          background: [0.039, 0.047, 0.063] as Types.Point3,
        },
      });
      const volumeId = this.volumeId;
      void setVolumesForViewports(this.engine, [{ volumeId }], [VIEWPORT_ID.volume3d]).then(() => {
        const vp3d = this.getViewport('volume3d') as
          | (Types.IViewport & { setProperties?: (p: unknown) => void })
          | null;
        vp3d?.setProperties?.({ preset: useAppStore.getState().volumePresetId });
        this.resetVolumeCamera();
      });
      try {
        ToolGroupManager.getToolGroup(TG_MPR)?.removeViewports(ENGINE_ID, VIEWPORT_ID.volume3d);
      } catch {
        /* not a member */
      }
      ToolGroupManager.getToolGroup(TG_3D)?.addViewport(VIEWPORT_ID.volume3d, ENGINE_ID);
    } catch (e) {
      console.warn('[hnrad] could not restore the 3D viewport', e);
    }
  }

  get isLinked(): boolean {
    return this.linkedVolumeId !== null;
  }

  /** Parse every instance header so the metadata providers can answer. */
  private async prefetchMetadata(imageIds: string[], token: number): Promise<void> {
    const queue = [...imageIds];
    const total = imageIds.length;
    let done = 0;
    let failures = 0;

    const worker = async (): Promise<void> => {
      while (queue.length) {
        if (token !== this.loadToken) return;
        const imageId = queue.shift();
        if (!imageId) return;
        try {
          const { url } = wadouri.parseImageId(imageId) as { url: string };
          await wadouri.dataSetCacheManager.load(
            url,
            undefined as unknown as Parameters<typeof wadouri.dataSetCacheManager.load>[1],
            imageId,
          );
        } catch {
          failures += 1;
        }
        done += 1;
        if (done % 4 === 0 || done === total) {
          const s = useAppStore.getState();
          if (s.loading.active) {
            s.set({ loading: { active: true, loaded: done, total, label: 'Reading headers' } });
          }
        }
      }
    };

    const lanes = Math.min(8, Math.max(2, total));
    await Promise.all(Array.from({ length: lanes }, () => worker()));

    if (failures && failures === total) {
      throw new Error('None of the instances could be read from the local index.');
    }
  }

  private createMprToolGroups(): void {
    const mpr = ToolGroupManager.createToolGroup(TG_MPR);
    if (!mpr) throw new Error('Could not create the MPR tool group');

    [
      WindowLevelTool.toolName,
      PanTool.toolName,
      ZoomTool.toolName,
      StackScrollTool.toolName,
      ...ANNOTATION_TOOLS,
    ].forEach((t) => mpr.addTool(t as string));
    TOOL_DRIVEN_TOOLS.forEach(([t, cfg]) => mpr.addTool(t, cfg));

    mpr.addTool(CrosshairsTool.toolName, {
      getReferenceLineColor: (viewportId: string) => PLANE_COLOR[viewportId] ?? 'rgb(200,200,200)',
      getReferenceLineControllable: () => true,
      getReferenceLineDraggableRotatable: () => true,
      getReferenceLineSlabThicknessControlsOn: () => false,
      mobile: { enabled: false },
    });

    MPR_PANES.forEach((p) => mpr.addViewport(VIEWPORT_ID[p], ENGINE_ID));
    [...ANNOTATION_TOOLS, ...TOOL_DRIVEN_NAMES].forEach((t) => mpr.setToolPassive(t));
    mpr.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
    mpr.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
    mpr.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });
    mpr.setToolActive(CrosshairsTool.toolName, {
      bindings: [{ mouseButton: MouseBindings.Primary }],
    });

    const tg3d = ToolGroupManager.createToolGroup(TG_3D);
    if (tg3d) {
      tg3d.addTool(TrackballRotateTool.toolName);
      tg3d.addTool(PanTool.toolName);
      tg3d.addTool(ZoomTool.toolName);
      tg3d.addViewport(VIEWPORT_ID.volume3d, ENGINE_ID);
      tg3d.setToolActive(TrackballRotateTool.toolName, {
        bindings: [{ mouseButton: MouseBindings.Primary }],
      });
      tg3d.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
      tg3d.setToolActive(ZoomTool.toolName, {
        bindings: [{ mouseButton: MouseBindings.Auxiliary }, { mouseButton: MouseBindings.Wheel }],
      });
    }

    useAppStore.getState().set({ activeTool: 'Crosshairs' });
  }

  /* ---------------- events ---------------- */

  private bindEvents(): void {
    this.syncMeasurements();
    if (this.boundEvents) return;
    this.boundEvents = true;

    const refresh = () => this.syncMeasurements();
    [
      csToolsEnums.Events.ANNOTATION_ADDED,
      csToolsEnums.Events.ANNOTATION_COMPLETED,
      csToolsEnums.Events.ANNOTATION_MODIFIED,
      csToolsEnums.Events.ANNOTATION_REMOVED,
    ].forEach((e) => eventTarget.addEventListener(e, refresh));
    // Camera and VOI changes are element events; see listenElement().
  }

  private refreshAllPaneState(): void {
    (this.activePanes.length ? this.activePanes : (Object.keys(VIEWPORT_ID) as PaneId[])).forEach(
      (p) => this.refreshPaneState(p),
    );
  }

  /**
   * Slice numbering, and why it needs help.
   *
   * Two different indices are in play and they do not agree:
   *
   *   - **k**, the DICOM slice index: the position of the image in the series
   *     sorted ascending by `slice_pos` (CONTRACT.md). Everything outside the
   *     viewer speaks k — the airway profile's `sample_k`, a carotid result's
   *     `sliceIndex`, every finding's jump target, the backend's voxel arrays.
   *   - the **viewport index**, which Cornerstone counts along the camera's
   *     view direction. For its AXIAL orientation the camera looks down -z, so
   *     this index runs *backwards* relative to k.
   *
   * On a 180-slice phantom that meant the overlay said "slice 116" while the
   * pixels on screen were DICOM slice 65, and a finding that jumped to its own
   * slice landed on the mirror image of it. So: report k, and translate on the
   * way back into a scroll.
   */
  private sliceAxis(pane: PaneId): 0 | 1 | 2 | null {
    // i runs left-right (sagittal), j anterior-posterior (coronal),
    // k inferior-superior (axial).
    if (pane === 'sagittal') return 0;
    if (pane === 'coronal') return 1;
    if (pane === 'axial') return 2;
    return null;
  }

  /** The DICOM slice index under a pane's camera, or null when unavailable. */
  private sliceIndexFromCamera(pane: PaneId): number | null {
    if (this.mode !== 'mpr') return null;
    const axis = this.sliceAxis(pane);
    if (axis === null) return null;
    const vol = this.getCtVolume();
    if (!vol?.imageData || !vol.dimensions) return null;
    const vp = this.getViewport(pane) as
      | (Types.IViewport & { getCamera?: () => { focalPoint?: Types.Point3 } })
      | null;
    const focal = vp?.getCamera?.()?.focalPoint;
    if (!focal) return null;
    try {
      const idx = csUtils.transformWorldToIndex(vol.imageData, focal) as number[];
      const raw = Math.round(idx[axis]);
      const limit = vol.dimensions[axis];
      if (!Number.isFinite(raw) || !Number.isFinite(limit)) return null;
      return Math.max(0, Math.min(limit - 1, raw));
    } catch {
      return null;
    }
  }

  /**
   * Whether this pane's viewport index runs backwards relative to k.
   *
   * Self-calibrating rather than assumed: compare the two indices at the
   * current position. If they sum to `total - 1` the axis is mirrored; if they
   * match, it is not. Anything else (an oblique camera after a crosshair
   * rotation) returns null and the caller falls back to the viewport's own
   * numbering, which is at least self-consistent.
   */
  /**
   * Translate a viewport slice index (e.g. the one Cornerstone stamps into an
   * annotation's metadata) into the DICOM index the rest of Margin uses.
   */
  private toDicomSlice(pane: PaneId, vpIndex: number | null | undefined): number | null {
    if (typeof vpIndex !== 'number' || !Number.isFinite(vpIndex)) return null;
    const vp = this.getViewport(pane) as (Types.IViewport & { getNumberOfSlices?: () => number }) | null;
    const total = vp?.getNumberOfSlices?.() ?? 0;
    return this.sliceMirrored(pane, total) === true ? total - 1 - vpIndex : vpIndex;
  }

  private sliceMirrored(pane: PaneId, total: number): boolean | null {
    const vp = this.getViewport(pane) as (Types.IViewport & { getSliceIndex?: () => number }) | null;
    const vpIndex = vp?.getSliceIndex?.();
    const camIndex = this.sliceIndexFromCamera(pane);
    if (typeof vpIndex !== 'number' || camIndex === null || !Number.isFinite(total) || total <= 1) {
      return null;
    }
    if (Math.abs(camIndex - vpIndex) <= 1) return false;
    if (Math.abs(camIndex + vpIndex - (total - 1)) <= 1) return true;
    return null;
  }

  refreshPaneState(pane: PaneId): void {
    const vp = this.getViewport(pane) as
      | (Types.IViewport & {
          getSliceIndex?: () => number;
          getNumberOfSlices?: () => number;
          getZoom?: () => number;
          getProperties?: () => { voiRange?: { lower: number; upper: number } };
        })
      | null;
    if (!vp) return;
    try {
      const vpIndex = vp.getSliceIndex?.() ?? 0;
      const total = vp.getNumberOfSlices?.() ?? 0;
      // Report the DICOM index so the overlay, the scrubber and every finding
      // are counting the same slices.
      const slice = this.sliceMirrored(pane, total) === null ? vpIndex : (this.sliceIndexFromCamera(pane) ?? vpIndex);
      const voi = vp.getProperties?.()?.voiRange;
      const zoom = vp.getZoom?.();
      const patch: Record<string, number> = {
        slice: Number.isFinite(slice) ? slice : 0,
        total: Number.isFinite(total) ? total : 0,
      };
      if (typeof zoom === 'number' && Number.isFinite(zoom)) patch.zoom = zoom;
      if (voi) {
        const { windowWidth, windowCenter } = csUtils.windowLevel.toWindowLevel(voi.lower, voi.upper);
        patch.ww = Math.round(windowWidth);
        patch.wc = Math.round(windowCenter);
      }
      useAppStore.getState().setPane(pane, patch);
    } catch {
      /* viewport not ready yet */
    }
  }

  /**
   * Jump a pane straight to a slice index (scrubber, cine wrap-around and
   * measurement rows without a stored view reference).
   *
   * Implemented as a relative scroll from the current index. A bare
   * `setViewReference({ sliceIndex })` is a no-op on 5.10 volume viewports;
   * see sliceNav.ts for the details.
   */
  setSlice(pane: PaneId, index: number): void {
    const vp = this.getViewport(pane) as
      | (Types.IViewport & { getSliceIndex?: () => number; getNumberOfSlices?: () => number })
      | null;
    if (!vp?.getSliceIndex || !vp.getNumberOfSlices) return;
    let plan: ReturnType<typeof planSliceJump> = null;
    try {
      const total = vp.getNumberOfSlices();
      // `index` is a DICOM slice index; mirror it into the viewport's own
      // numbering before asking Cornerstone to scroll there.
      const mirrored = this.sliceMirrored(pane, total);
      const target = mirrored === true ? total - 1 - index : index;
      plan = planSliceJump(vp.getSliceIndex(), total, target);
    } catch {
      return; /* no volume on the viewport yet */
    }
    if (!plan) return;
    try {
      csUtils.scroll(vp, { delta: plan.delta });
      this.refreshPaneState(pane);
    } catch {
      /* 3D viewports do not scroll */
    }
  }

  /* ---------------- measurements ---------------- */

  syncMeasurements(): void {
    let all: ReturnType<typeof csAnnotation.state.getAllAnnotations>;
    try {
      all = csAnnotation.state.getAllAnnotations();
    } catch {
      return;
    }
    const list: Measurement[] = [];
    for (const a of all) {
      const toolName = a.metadata?.toolName;
      if (!toolName || !ANNOTATION_TOOLS.includes(toolName)) continue;
      if (!a.annotationUID) continue;
      const stats = firstStats(a.data?.cachedStats as Record<string, unknown> | undefined);
      const { value, extra } = describeAnnotation(toolName, stats);
      const pane = this.paneForAnnotation(a);
      list.push({
        uid: a.annotationUID,
        toolName: MEASUREMENT_LABEL[toolName] ?? toolName,
        value,
        extra,
        paneId: pane,
        // Cornerstone stamps its own viewport index; translate so a
        // measurement row and a finding row agree about "slice 116".
        sliceIndex: this.toDicomSlice(pane, a.metadata?.sliceIndex),
      });
    }
    this.derived.forEach((m) => list.push(m));
    useAppStore.getState().set({ measurements: list });
  }

  /**
   * Publish a head-and-neck tool result as a measurement row. It behaves like
   * any other row (click to jump, trash to remove) but is backed by the tool,
   * not by a Cornerstone annotation.
   */
  addDerivedMeasurement(m: Measurement, viewRef?: unknown): void {
    this.derived.set(m.uid, m);
    if (viewRef) this.derivedRefs.set(m.uid, viewRef);
    this.syncMeasurements();
  }

  private paneForAnnotation(a: { metadata?: { viewPlaneNormal?: number[] } }): PaneId {
    const n = a.metadata?.viewPlaneNormal;
    if (!n) return this.mode === 'stack' ? 'stack' : 'axial';
    const [x, y, z] = [Math.abs(n[0] ?? 0), Math.abs(n[1] ?? 0), Math.abs(n[2] ?? 0)];
    if (this.mode === 'stack') return 'stack';
    if (z >= x && z >= y) return 'axial';
    if (x >= y) return 'sagittal';
    return 'coronal';
  }

  jumpToMeasurement(uid: string): void {
    const derived = this.derived.get(uid);
    if (derived) {
      const vp = this.getViewport(derived.paneId) as
        | (Types.IViewport & { setViewReference?: (r: unknown) => void })
        | null;
      const ref = this.derivedRefs.get(uid);
      // A stored view reference restores the exact plane the tool measured on;
      // a bare slice index is the fallback.
      if (vp?.setViewReference && ref) {
        try {
          vp.setViewReference(ref);
          vp.render();
          this.refreshPaneState(derived.paneId);
        } catch {
          if (derived.sliceIndex !== null) this.setSlice(derived.paneId, derived.sliceIndex);
        }
      } else if (derived.sliceIndex !== null) {
        this.setSlice(derived.paneId, derived.sliceIndex);
      }
      useAppStore.getState().set({ activePane: derived.paneId, selectedMeasurement: uid });
      return;
    }
    const a = csAnnotation.state.getAnnotation(uid);
    if (!a?.metadata) return;
    const pane = this.paneForAnnotation(a);
    const vp = this.getViewport(pane) as (Types.IViewport & { setViewReference?: (r: unknown) => void }) | null;
    if (!vp) return;
    try {
      vp.setViewReference?.(a.metadata);
      vp.render();
      useAppStore.getState().set({ activePane: pane, selectedMeasurement: uid });
      this.refreshPaneState(pane);
    } catch (e) {
      console.warn('[hnrad] could not jump to measurement', e);
    }
  }

  removeMeasurement(uid: string): void {
    if (this.derived.delete(uid)) {
      this.derivedRefs.delete(uid);
      this.syncMeasurements();
      return;
    }
    try {
      csAnnotation.state.removeAnnotation(uid);
      this.engine?.render();
      this.syncMeasurements();
    } catch (e) {
      console.warn('[hnrad] could not remove annotation', e);
    }
  }

  clearMeasurements(): void {
    this.derived.clear();
    this.derivedRefs.clear();
    try {
      csAnnotation.state.removeAllAnnotations();
      this.engine?.render();
      this.syncMeasurements();
    } catch (e) {
      console.warn('[hnrad] could not clear annotations', e);
    }
  }

  /* ---------------- tools ---------------- */

  setActiveTool(toolName: string): void {
    const groups = [TG_MPR, TG_STACK]
      .map((id) => ToolGroupManager.getToolGroup(id))
      .filter(Boolean) as NonNullable<ReturnType<typeof ToolGroupManager.getToolGroup>>[];
    if (!groups.length) return;

    for (const tg of groups) {
      const current = tg.getActivePrimaryMouseButtonTool();
      if (current && current !== toolName) {
        tg.setToolPassive(current);
      }
      if (!tg.hasTool(toolName)) continue;
      tg.setToolActive(toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
    }
    useAppStore.getState().set({ activeTool: toolName });
  }

  /* ---------------- windowing ---------------- */

  applyWindow(ww: number, wc: number, presetId?: string): void {
    if (!this.engine) return;
    this.appliedWindow = { ww, wc };
    const voiRange = csUtils.windowLevel.toLowHighRange(ww, wc);
    const targets: PaneId[] = this.mode === 'stack' ? ['stack'] : MPR_PANES;
    targets.forEach((p) => {
      const vp = this.getViewport(p) as (Types.IViewport & { setProperties?: (p: unknown) => void }) | null;
      try {
        vp?.setProperties?.({ voiRange });
      } catch {
        /* ignore */
      }
    });
    this.engine.render();
    if (presetId) useAppStore.getState().set({ windowPresetId: presetId });
    targets.forEach((p) => this.refreshPaneState(p));
  }

  setInvert(invert: boolean): void {
    const targets: PaneId[] = this.mode === 'stack' ? ['stack'] : MPR_PANES;
    targets.forEach((p) => {
      const vp = this.getViewport(p) as (Types.IViewport & { setProperties?: (p: unknown) => void }) | null;
      try {
        vp?.setProperties?.({ invert });
      } catch {
        /* ignore */
      }
    });
    this.engine?.render();
    useAppStore.getState().set({ invert });
  }

  setVolumePreset(presetId: string): void {
    const vp = this.getViewport('volume3d') as
      | (Types.IViewport & { setProperties?: (p: unknown) => void })
      | null;
    if (!vp) return;
    try {
      vp.setProperties?.({ preset: presetId });
      this.engine?.renderViewports([VIEWPORT_ID.volume3d]);
      useAppStore.getState().set({ volumePresetId: presetId });
    } catch (e) {
      console.warn('[hnrad] preset failed', e);
    }
  }

  setSlab(slabId: string): void {
    const opt = SLAB_OPTIONS.find((s) => s.id === slabId) ?? SLAB_OPTIONS[0];
    if (this.mode !== 'mpr') return;
    MPR_PANES.forEach((p) => {
      const vp = this.getViewport(p) as
        | (Types.IViewport & {
            setBlendMode?: (m: number) => void;
            setSlabThickness?: (mm: number) => void;
            resetSlabThickness?: () => void;
          })
        | null;
      if (!vp) return;
      try {
        vp.setBlendMode?.(opt.mip ? BlendModes.MAXIMUM_INTENSITY_BLEND : BlendModes.COMPOSITE);
        if (opt.mm > 0) vp.setSlabThickness?.(opt.mm);
        else vp.resetSlabThickness?.();
      } catch (e) {
        console.warn('[hnrad] slab failed', e);
      }
    });
    this.engine?.render();
    useAppStore.getState().set({ slabId: opt.id });
  }

  /** Put the 3D view back on a front-facing (coronal) camera. */
  private resetVolumeCamera(): void {
    const vp = this.getViewport('volume3d') as
      | (Types.IViewport & {
          resetCamera?: (o?: unknown) => void;
          setCamera?: (c: unknown) => void;
          setZoom?: (z: number) => void;
        })
      | null;
    if (!vp) return;
    try {
      vp.resetCamera?.();
      vp.setCamera?.({
        viewPlaneNormal: [...CONSTANTS.MPR_CAMERA_VALUES.coronal.viewPlaneNormal],
        viewUp: [...CONSTANTS.MPR_CAMERA_VALUES.coronal.viewUp],
      });
      vp.resetCamera?.();
      // resetCamera fills the pane edge to edge; back off so the whole neck,
      // mandible included, is inside the frame.
      vp.setZoom?.(0.8);
      vp.render();
    } catch (e) {
      console.warn('[hnrad] could not reset the 3D camera', e);
    }
  }

  resetViews(): void {
    if (!this.engine) return;
    const panes = this.mode === 'stack' ? (['stack'] as PaneId[]) : this.activePanes;
    panes.forEach((p) => {
      if (p === 'volume3d') {
        this.resetVolumeCamera();
        return;
      }
      const vp = this.getViewport(p) as
        | (Types.IViewport & { resetCamera?: () => void; resetProperties?: () => void })
        | null;
      try {
        vp?.resetCamera?.();
      } catch {
        /* ignore */
      }
    });
    const tg = ToolGroupManager.getToolGroup(TG_MPR);
    const cross = tg?.getToolInstance(CrosshairsTool.toolName) as
      | { resetCrosshairs?: () => void }
      | undefined;
    try {
      cross?.resetCrosshairs?.();
    } catch {
      /* ignore */
    }
    const store = useAppStore.getState();
    const preset = WINDOW_PRESETS.find((p) => p.id === store.windowPresetId) ?? WINDOW_PRESETS[0];
    this.applyWindow(preset.ww, preset.wc, preset.id);
    this.engine.render();
    this.refreshAllPaneState();
  }

  /* ---------------- scrolling / cine ---------------- */

  scrollPane(pane: PaneId, delta: number): void {
    const vp = this.getViewport(pane);
    if (!vp) return;
    try {
      csUtils.scroll(vp as Types.IViewport, { delta });
      this.refreshPaneState(pane);
    } catch {
      /* 3D viewports do not scroll */
    }
  }

  toggleCine(on: boolean): void {
    this.stopCine();
    useAppStore.getState().set({ cine: on });
    if (!on) return;
    const pane: PaneId = this.mode === 'stack' ? 'stack' : 'axial';
    this.cineTimer = window.setInterval(() => {
      const state = useAppStore.getState();
      const p = state.panes[pane];
      if (p.total > 0 && p.slice >= p.total - 1) {
        this.setSlice(pane, 0);
        return;
      }
      this.setSlice(pane, p.slice + 1);
    }, useAppStore.getState().cineMs);
  }

  stopCine(): void {
    if (this.cineTimer !== null) {
      window.clearInterval(this.cineTimer);
      this.cineTimer = null;
    }
  }

  /* ---------------- HU probe under the cursor ---------------- */

  probeAt(pane: PaneId, canvasX: number, canvasY: number): void {
    const now = performance.now();
    if (now - this.lastProbeAt < 40) return;
    this.lastProbeAt = now;
    cancelAnimationFrame(this.probeRaf);
    this.probeRaf = requestAnimationFrame(() => this.doProbe(pane, canvasX, canvasY));
  }

  private doProbe(pane: PaneId, canvasX: number, canvasY: number): void {
    const vp = this.getViewport(pane) as
      | (Types.IViewport & { canvasToWorld?: (p: [number, number]) => Types.Point3 })
      | null;
    if (!vp?.canvasToWorld) return;
    try {
      const world = vp.canvasToWorld([canvasX, canvasY]);
      let hu: number | null = null;
      let ijk: [number, number, number] | null = null;

      let source: { imageData?: unknown; dimensions?: Types.Point3; voxelManager?: unknown } | undefined;

      if (this.mode === 'mpr' && this.volumeId) {
        source = cache.getVolume(this.volumeId) as Types.IImageVolume | undefined;
      } else {
        source = (vp as unknown as { getImageData?: () => Types.IImageData }).getImageData?.();
      }

      if (source?.imageData && source.voxelManager && source.dimensions) {
        const idx = csUtils.transformWorldToIndex(source.imageData, world) as number[];
        const [i, j, k] = [Math.round(idx[0]), Math.round(idx[1]), Math.round(idx[2] ?? 0)];
        const [di, dj, dk] = source.dimensions;
        if (i >= 0 && j >= 0 && k >= 0 && i < di && j < dj && k < Math.max(dk, 1)) {
          const v = (source.voxelManager as { getAtIJK: (a: number, b: number, c: number) => number })
            .getAtIJK(i, j, k);
          if (typeof v === 'number' && Number.isFinite(v)) hu = v;
          ijk = [i, j, k];
        }
      }

      useAppStore.getState().set({
        probe: {
          hu,
          lps: [world[0], world[1], world[2]],
          ijk,
          paneId: pane,
        },
      });

      // Same world point, no second transform: the labelmap sampler answers
      // "which structure is this" and only wakes React when the answer moves.
      anatomyProbe.push([world[0], world[1], world[2]]);
    } catch {
      /* outside the volume */
    }
  }

  clearProbe(): void {
    useAppStore.getState().set({
      probe: { hu: null, lps: null, ijk: null, paneId: null },
      anatomy: { name: null, color: null, segmentationId: null, segmentIndex: null },
    });
  }

  /* ---------------- screenshot ---------------- */

  async screenshot(pane: PaneId): Promise<string | null> {
    const vp = this.getViewport(pane) as
      | (Types.IViewport & { getCanvas?: () => HTMLCanvasElement; element?: HTMLDivElement })
      | null;
    if (!vp?.getCanvas) return null;
    const engine = this.engine;
    if (!engine) return null;

    const source = await new Promise<HTMLCanvasElement>((resolve) => {
      const el = vp.element as HTMLDivElement | undefined;
      if (!el) {
        resolve(vp.getCanvas!());
        return;
      }
      const done = () => {
        el.removeEventListener(Enums.Events.IMAGE_RENDERED, done);
        resolve(vp.getCanvas!());
      };
      el.addEventListener(Enums.Events.IMAGE_RENDERED, done);
      window.setTimeout(done, 400);
      engine.renderViewports([VIEWPORT_ID[pane]]);
    });

    const out = document.createElement('canvas');
    out.width = source.width;
    out.height = source.height;
    const ctx = out.getContext('2d');
    if (!ctx) return source.toDataURL('image/png');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(source, 0, 0);

    // Burn in every SVG overlay sitting on the viewport: Cornerstone's own
    // annotation layer plus any head-and-neck tool layer (e.g. the carotid
    // contact arc), in DOM order so the tool draws on top.
    try {
      const el = vp.element as HTMLElement | undefined;
      const elRect = el?.getBoundingClientRect();
      const scale = elRect?.width ? out.width / elRect.width : 1;
      const layers = el ? Array.from(el.querySelectorAll('svg')) : [];
      for (const svg of layers) {
        const rect = svg.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const clone = svg.cloneNode(true) as SVGSVGElement;
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        clone.setAttribute('width', String(rect.width));
        clone.setAttribute('height', String(rect.height));
        // Tool layers carry inherited CSS custom properties; inline them so the
        // serialised copy keeps its colour.
        const cs = getComputedStyle(svg);
        const tokens = ['--warn', '--danger', '--accent', '--text'];
        const decl = tokens
          .map((t) => `${t}:${cs.getPropertyValue(t).trim()}`)
          .filter((d) => !d.endsWith(':'))
          .join(';');
        if (decl) clone.setAttribute('style', `${clone.getAttribute('style') ?? ''};${decl}`);
        const data = new XMLSerializer().serializeToString(clone);
        const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}`;
        const img = new Image();
        await new Promise<void>((resolve) => {
          img.onload = () => resolve();
          img.onerror = () => resolve();
          img.src = url;
        });
        if (!img.width) continue;
        const dx = elRect ? (rect.left - elRect.left) * scale : 0;
        const dy = elRect ? (rect.top - elRect.top) * scale : 0;
        ctx.drawImage(img, dx, dy, rect.width * scale, rect.height * scale);
      }
    } catch {
      /* overlay is a nicety, never fail the capture for it */
    }

    return out.toDataURL('image/png');
  }

  destroy(): void {
    this.linkSync?.();
    this.linkSync = null;
    this.linkedVolumeId = null;
    this.stopCine();
    this.resizeObserver?.disconnect();
    this.teardownEngine();
  }
}

export const viewer = new ViewerCore();
