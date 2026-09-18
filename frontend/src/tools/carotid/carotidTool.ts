/**
 * Carotid encasement — the guided two-step tool.
 *
 * Step 1 puts Cornerstone's CircleROI on the carotid lumen, step 2 traces the
 * tumour with PlanarFreehandROI, and the moment both exist on the same axial
 * slice the contact angle is computed in the axial image plane and drawn back
 * onto the image.
 *
 * The maths lives in ./geometry.ts and knows nothing about Cornerstone; this
 * file is only the plumbing between the annotations, the store and the panel.
 */
import { create } from 'zustand';
import { eventTarget, type Types } from '@cornerstonejs/core';
import { Enums as csToolsEnums, annotation as csAnnotation } from '@cornerstonejs/tools';

import { useAppStore } from '../../store/useAppStore';
import { viewer } from '../../viewer/ViewerCore';
import {
  classify,
  clockLabel,
  contactAngle,
  type Arc,
  type Point2,
  type Severity,
} from './geometry';
import { carotidOverlay } from './overlay';

/** TOOLS-SPEC.md §1: default contact tolerance. */
export const TOLERANCE_MM = 1.5;
const SAMPLES = 360;
/** |n·z| above this counts as an axial plane. */
const AXIAL_DOT = 0.99;

export type CarotidPhase = 'idle' | 'circle' | 'tumor' | 'result';

export interface CarotidResult {
  angleDeg: number;
  longestArcDeg: number;
  arcs: Arc[];
  clockFrom: number | null;
  clockTo: number | null;
  severity: Severity;
  /** Which internal carotid: +x is patient left in LPS. */
  side: 'left' | 'right';
  sliceIndex: number;
  radiusMm: number;
  centerWorld: Types.Point3;
  toleranceMm: number;
}

interface CarotidState {
  phase: CarotidPhase;
  /** Inline hint shown in the panel (wrong plane, wrong slice, too small…). */
  hint: string | null;
  /** Slice the circle was placed on, so the hint can offer to jump back. */
  anchorSlice: number | null;
  result: CarotidResult | null;
  added: boolean;
  set: (patch: Partial<CarotidState>) => void;
}

export const useCarotidStore = create<CarotidState>((set) => ({
  phase: 'idle',
  hint: null,
  anchorSlice: null,
  result: null,
  added: false,
  set: (patch) => set(patch),
}));

export const SIDE_LABEL: Record<CarotidResult['side'], string> = {
  left: 'left ICA',
  right: 'right ICA',
};

/* ------------------------------------------------------------------ */
/* annotation shapes we read                                          */
/* ------------------------------------------------------------------ */

interface AnnotationLike {
  annotationUID?: string;
  metadata?: {
    toolName?: string;
    viewPlaneNormal?: number[];
    sliceIndex?: number;
  };
  data?: {
    handles?: { points?: number[][] };
    contour?: { polyline?: number[][]; closed?: boolean };
  };
}

function isAxial(normal: number[] | undefined): boolean {
  if (!normal || normal.length < 3) return false;
  return Math.abs(normal[2]) >= AXIAL_DOT;
}

/**
 * The axial slice the tool is anchored to. Read from the store rather than
 * from `getSliceIndex()`, because the store's value is the one derived from
 * the camera (see ViewerCore.sliceIndexFromCamera) and is therefore the slice
 * actually on screen after a jump.
 */
function axialSlice(): number | null {
  const pane = useAppStore.getState().panes.axial;
  if (pane.total <= 0) return null;
  return Number.isFinite(pane.slice) ? pane.slice : null;
}

/** Circle radius in world mm from the [centre, top, bottom, left, right] handles. */
function radiusFromHandles(points: number[][]): number {
  const [c] = points;
  const rs: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const d = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
    if (Number.isFinite(d) && d > 0) rs.push(d);
  }
  if (!rs.length) return 0;
  return rs.reduce((a, b) => a + b, 0) / rs.length;
}

/* ------------------------------------------------------------------ */
/* the tool                                                           */
/* ------------------------------------------------------------------ */

let rowSeq = 0;

class CarotidTool {
  private bound = false;
  private circleUid: string | null = null;
  private tumorUid: string | null = null;
  /** Annotation metadata of the lumen circle: the plane the result belongs to. */
  private viewRef: unknown = null;

  get active(): boolean {
    return useCarotidStore.getState().phase !== 'idle';
  }

  /** Rail button, hotkey C and the panel all land here. */
  start(): void {
    const app = useAppStore.getState();
    if (app.layout !== 'mpr') {
      app.toast({
        kind: 'err',
        title: 'Carotid encasement needs an axial series',
        message: 'Open a volumetric CT so the axial MPR view is available.',
      });
      return;
    }

    this.discardAnnotations();
    carotidOverlay.hide();
    useCarotidStore.getState().set({
      phase: 'circle',
      hint: null,
      anchorSlice: null,
      result: null,
      added: false,
    });
    app.set({
      panelTab: 'structures',
      panelOpen: true,
      askOpen: false,
      activePane: 'axial',
      primaryPane: 'axial',
      screen: 'read',
    });
    this.bind();
    viewer.setActiveTool('CircleROI');
  }

  /** Forget the measurement without touching the viewer (e.g. a new series). */
  reset(): void {
    carotidOverlay.hide();
    this.circleUid = null;
    this.tumorUid = null;
    this.viewRef = null;
    useCarotidStore
      .getState()
      .set({ phase: 'idle', hint: null, anchorSlice: null, result: null, added: false });
  }

  /** Esc. Returns true when the tool consumed the key. */
  cancel(): boolean {
    const s = useCarotidStore.getState();
    if (s.phase === 'idle') return false;
    // A finished measurement has already earned its place on the image; only a
    // half-finished one gets thrown away.
    if (s.phase !== 'result') this.discardAnnotations();
    carotidOverlay.hide();
    s.set({ phase: 'idle', hint: null, anchorSlice: null, result: null, added: false });
    viewer.setActiveTool('WindowLevel');
    return true;
  }

  redo(): void {
    this.discardAnnotations();
    this.start();
  }

  /** Publish the result as a row in the Measure tab. */
  addToMeasurements(): void {
    const { result, added } = useCarotidStore.getState();
    if (!result || added) return;
    const clock = clockLabel(result);
    viewer.addDerivedMeasurement(
      {
        uid: `carotid-${++rowSeq}`,
        toolName: 'Carotid contact',
        value: `${Math.round(result.angleDeg)}°`,
        extra: [SIDE_LABEL[result.side], severityWord(result.severity), clock ?? null]
          .filter(Boolean)
          .join(' · '),
        paneId: 'axial',
        sliceIndex: result.sliceIndex,
      },
      this.viewRef,
    );
    useCarotidStore.getState().set({ added: true });
    useAppStore.getState().toast({
      kind: 'ok',
      title: `${Math.round(result.angleDeg)}° added to measurements`,
      message: `${SIDE_LABEL[result.side]} · slice ${result.sliceIndex + 1}`,
    });
  }

  /** Jump the axial view back to the slice the circle sits on. */
  gotoAnchor(): void {
    const slice = useCarotidStore.getState().anchorSlice;
    if (slice === null) return;
    viewer.setSlice('axial', slice);
    useCarotidStore.getState().set({ hint: null });
  }

  /* ---------------- internals ---------------- */

  private bind(): void {
    if (this.bound) return;
    this.bound = true;
    eventTarget.addEventListener(csToolsEnums.Events.ANNOTATION_COMPLETED, this.onCompleted);
  }

  private readonly onCompleted = (evt: Event): void => {
    const a = ((evt as CustomEvent).detail as { annotation?: AnnotationLike })?.annotation;
    if (!a?.annotationUID) return;
    const phase = useCarotidStore.getState().phase;
    const tool = a.metadata?.toolName;
    if (phase === 'circle' && tool === 'CircleROI') this.onCircle(a);
    else if (phase === 'tumor' && tool === 'PlanarFreehandROI') this.onTumor(a);
  };

  private onCircle(a: AnnotationLike): void {
    const store = useCarotidStore.getState();

    if (!isAxial(a.metadata?.viewPlaneNormal)) {
      this.drop(a.annotationUID);
      store.set({
        hint: 'Circumferential contact is measured in the axial plane — draw the lumen on the axial viewport.',
      });
      return;
    }

    const points = a.data?.handles?.points ?? [];
    const radius = points.length >= 2 ? radiusFromHandles(points) : 0;
    if (radius < 0.5) {
      this.drop(a.annotationUID);
      store.set({ hint: 'That circle is too small — drag out the whole carotid lumen.' });
      return;
    }

    const slice = axialSlice();
    if (slice === null) {
      this.drop(a.annotationUID);
      store.set({ hint: 'The axial viewport is not ready yet.' });
      return;
    }

    this.circleUid = a.annotationUID ?? null;
    this.viewRef = a.metadata ? { ...a.metadata } : null;
    store.set({ phase: 'tumor', hint: null, anchorSlice: slice });
    viewer.setActiveTool('PlanarFreehandROI');
  }

  private onTumor(a: AnnotationLike): void {
    const store = useCarotidStore.getState();
    const circle = this.circleUid ? (csAnnotation.state.getAnnotation(this.circleUid) as AnnotationLike | undefined) : undefined;
    const points = circle?.data?.handles?.points ?? [];
    if (points.length < 2) {
      store.set({ hint: 'The lumen circle went missing — redo the measurement.' });
      return;
    }

    if (!isAxial(a.metadata?.viewPlaneNormal)) {
      this.drop(a.annotationUID);
      store.set({ hint: 'Trace the tumour on the same axial viewport as the circle.' });
      return;
    }

    const slice = axialSlice();
    if (slice !== null && store.anchorSlice !== null && slice !== store.anchorSlice) {
      this.drop(a.annotationUID);
      store.set({
        hint: `Both outlines must be on one slice. The lumen circle is on slice ${
          store.anchorSlice + 1
        }, the axial view is on ${slice + 1}.`,
      });
      return;
    }

    const polyline = a.data?.contour?.polyline ?? [];
    if (polyline.length < 3) {
      this.drop(a.annotationUID);
      store.set({ hint: 'That contour has too few points — trace right around the tumour.' });
      return;
    }

    const centerWorld: Types.Point3 = [points[0][0], points[0][1], points[0][2]];
    const radiusMm = radiusFromHandles(points);
    const center: Point2 = [centerWorld[0], centerWorld[1]];
    const polygon: Point2[] = polyline.map((p) => [p[0], p[1]] as Point2);

    const measured = contactAngle({
      center,
      radius: radiusMm,
      polygon,
      tolerance: TOLERANCE_MM,
      samples: SAMPLES,
    });

    const severity = classify(measured.angleDeg);
    const result: CarotidResult = {
      angleDeg: measured.angleDeg,
      longestArcDeg: measured.longestArcDeg,
      arcs: measured.arcs,
      clockFrom: measured.clockFrom,
      clockTo: measured.clockTo,
      severity,
      side: centerWorld[0] >= 0 ? 'left' : 'right',
      sliceIndex: store.anchorSlice ?? slice ?? 0,
      radiusMm,
      centerWorld,
      toleranceMm: TOLERANCE_MM,
    };

    this.tumorUid = a.annotationUID ?? null;
    store.set({ phase: 'result', hint: null, result, added: false });
    viewer.setActiveTool('WindowLevel');

    carotidOverlay.show({
      centerWorld,
      radiusMm,
      arcs: measured.arcs,
      sliceIndex: result.sliceIndex,
      color: severity === 'encasement' ? 'var(--danger)' : 'var(--warn)',
      label: `${Math.round(measured.angleDeg)}°`,
    });
  }

  private drop(uid: string | undefined): void {
    if (!uid) return;
    try {
      csAnnotation.state.removeAnnotation(uid);
    } catch {
      /* already gone */
    }
    viewer.renderingEngine?.render();
    viewer.syncMeasurements();
  }

  private discardAnnotations(): void {
    this.drop(this.circleUid ?? undefined);
    this.drop(this.tumorUid ?? undefined);
    this.circleUid = null;
    this.tumorUid = null;
  }
}

export function severityWord(s: Severity): string {
  return s === 'encasement' ? 'encasement' : s === 'partial' ? 'partial encasement' : 'abutment';
}

export const carotid = new CarotidTool();

// A measurement belongs to one slice of one series: drop it when the series
// changes so a stale arc can never be drawn over new anatomy.
useAppStore.subscribe((s, prev) => {
  if (s.activeSeries?.series_uid !== prev.activeSeries?.series_uid) carotid.reset();
});
