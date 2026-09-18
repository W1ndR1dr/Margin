/**
 * Airway analyser — the guided tool (TOOLS-SPEC.md §4).
 *
 * Step 1 is a click inside the tracheal lumen. Steps 2 and 3 are optional and
 * can be done in either order: a click at the true vocal folds, and two clicks
 * bracketing a normal segment that becomes the manual reference CSA (or a drag
 * on the CSA chart once a result is up). The backend does the segmentation,
 * the centreline and the perpendicular cross-sections; this file is the
 * plumbing between the clicks, the result, the Structures list and the
 * measurement rows.
 */
import { create } from 'zustand';
import { Enums as csEnums, type Types } from '@cornerstonejs/core';

import { analysis, type AirwayRequest, type AirwayResult, type Triple } from '../../api/client';
import { useAppStore } from '../../store/useAppStore';
import { viewer } from '../../viewer/ViewerCore';
import { armPick, type PickHandle } from '../../viewer/pick';
import { ANATOMY } from '../../labels/colors';
import { addStructureFromLabel, removeStructure } from '../../labels/structureStore';
import { minEquivalentDiameterMm, narrative } from './report';
import {
  buildAirwayRequest,
  normalizeRange,
  rangeFromSamples,
  sameRequest,
  type KRange,
} from './reference';

export {
  GRADE_RANGE,
  GRADE_SEVERITY,
  equivalentDiameterMm,
  minEquivalentDiameterMm,
  narrative,
  type GradeSeverity,
  type MyerCotton,
} from './report';

export type AirwayPhase = 'idle' | 'seed' | 'setup' | 'running' | 'result';

/** Which click the MPR views are waiting for, if any. */
export type AirwayPick = 'seed' | 'glottis' | 'ref' | null;

interface AirwayState {
  phase: AirwayPhase;
  picking: AirwayPick;
  hint: string | null;
  seedIjk: Triple | null;
  seedHu: number | null;
  glottisSlice: number | null;
  /** Slice bracket of the normal segment for the manual reference; null = auto. */
  refRangeK: KRange | null;
  /** The first click of the bracket, waiting for the second. */
  refPending: number | null;
  /** Stop the profile at the vocal folds (only matters once a glottis is marked). */
  capAtGlottis: boolean;
  result: AirwayResult | null;
  /** The request that produced `result`, so the panel can tell when inputs moved. */
  sent: AirwayRequest | null;
  /** Chart sample under the cursor, or the pinned one after a click. */
  hoverIndex: number | null;
  added: boolean;
  structureAdded: boolean;
  set: (patch: Partial<AirwayState>) => void;
}

const FRESH: Omit<AirwayState, 'set'> = {
  phase: 'idle',
  picking: null,
  hint: null,
  seedIjk: null,
  seedHu: null,
  glottisSlice: null,
  refRangeK: null,
  refPending: null,
  capAtGlottis: true,
  result: null,
  sent: null,
  hoverIndex: null,
  added: false,
  structureAdded: false,
};

export const useAirwayStore = create<AirwayState>((set) => ({
  ...FRESH,
  set: (patch) => set(patch),
}));

/** The request the current inputs would send, or null before the seed. */
export function pendingRequest(s: AirwayState, seriesUid: string | undefined): AirwayRequest | null {
  if (!seriesUid || !s.seedIjk) return null;
  return buildAirwayRequest({
    seriesUid,
    seedIjk: s.seedIjk,
    glottisSlice: s.glottisSlice,
    refRangeK: s.refRangeK,
    capAtGlottis: s.capAtGlottis,
  });
}

/** True when the inputs have moved since the result on screen was computed. */
export function inputsChanged(s: AirwayState, seriesUid: string | undefined): boolean {
  if (!s.result || !s.sent) return false;
  return !sameRequest(s.sent, pendingRequest(s, seriesUid));
}

let rowSeq = 0;

class AirwayTool {
  private pick: PickHandle | null = null;
  /** The Structures row holding the lumen of the last run, replaced on re-run. */
  private structureId: string | null = null;

  get active(): boolean {
    return useAirwayStore.getState().phase !== 'idle';
  }

  /** Rail button, hotkey Y and the panel all land here. */
  start(): void {
    const app = useAppStore.getState();
    if (app.layout !== 'mpr') {
      app.toast({
        kind: 'err',
        title: 'The airway analyser needs a volumetric series',
        message: 'Open a CT that loads as MPR so the lumen can be traced in 3D.',
      });
      return;
    }
    this.disarm();
    useAirwayStore.getState().set({ ...FRESH, phase: 'seed' });
    app.set({ panelTab: 'structures', panelOpen: true, askOpen: false, screen: 'read' });
    this.armSeed();
  }

  /** Esc. Returns true when the tool consumed the key. */
  cancel(): boolean {
    const s = useAirwayStore.getState();
    if (s.phase === 'idle') return false;
    this.disarm();
    s.set({ phase: 'idle', picking: null, hint: null, hoverIndex: null, refPending: null });
    return true;
  }

  reset(): void {
    this.disarm();
    this.structureId = null;
    useAirwayStore.getState().set({ ...FRESH });
  }

  redo(): void {
    this.start();
  }

  /* ---------------- step 1: the seed ---------------- */

  /** Re-arming after a bad click keeps the hint that explains why. */
  armSeed(): void {
    this.disarm();
    useAirwayStore.getState().set({ phase: 'seed', picking: 'seed' });
    this.pick = armPick(
      (p) => {
        this.pick = null;
        const s = useAirwayStore.getState();
        if (!p.ijk) {
          s.set({ hint: 'That click landed outside the volume — try again inside the trachea.' });
          this.armSeed();
          return;
        }
        if (p.hu !== null && p.hu > -300) {
          s.set({
            hint: `That voxel is ${Math.round(p.hu)} HU, which is not air. Click inside the dark tracheal lumen.`,
          });
          this.armSeed();
          return;
        }
        s.set({
          phase: 'setup',
          picking: null,
          hint: null,
          seedIjk: [p.ijk[0], p.ijk[1], p.ijk[2]],
          seedHu: p.hu,
        });
      },
      { onCancel: () => this.pickCancelled() },
    );
  }

  /* ---------------- step 2: the glottis (optional) ---------------- */

  armGlottis(): void {
    this.disarm();
    useAirwayStore.getState().set({ picking: 'glottis', refPending: null, hint: null });
    this.pick = armPick(
      (p) => {
        this.pick = null;
        const s = useAirwayStore.getState();
        if (!p.ijk) {
          s.set({ picking: null, hint: 'That click landed outside the volume.' });
          return;
        }
        s.set({ glottisSlice: p.ijk[2], picking: null, hint: null });
      },
      { onCancel: () => this.pickCancelled() },
    );
  }

  clearGlottis(): void {
    this.disarmIfPicking('glottis');
    useAirwayStore.getState().set({ glottisSlice: null });
  }

  setCapAtGlottis(on: boolean): void {
    useAirwayStore.getState().set({ capAtGlottis: on });
  }

  /* ---------------- step 3: the reference bracket (optional) ---------------- */

  /**
   * Two clicks in any MPR view, one at each end of a normal segment. Only the
   * slice of each click matters, so the sagittal or coronal view is the
   * natural place: click the lower end of the healthy trachea, then the upper.
   */
  armReference(): void {
    this.disarm();
    useAirwayStore.getState().set({ picking: 'ref', refPending: null, hint: null });
    this.armReferenceClick();
  }

  private armReferenceClick(): void {
    this.pick = armPick(
      (p) => {
        this.pick = null;
        const s = useAirwayStore.getState();
        if (!p.ijk) {
          s.set({ hint: 'That click landed outside the volume — click on the airway again.' });
          this.armReferenceClick();
          return;
        }
        const k = p.ijk[2];
        if (s.refPending === null) {
          s.set({ refPending: k, hint: null });
          this.armReferenceClick();
          return;
        }
        if (k === s.refPending) {
          s.set({ hint: 'Both clicks are on the same slice — click the other end of the normal segment.' });
          this.armReferenceClick();
          return;
        }
        s.set({
          refRangeK: normalizeRange(s.refPending, k),
          refPending: null,
          picking: null,
          hint: null,
        });
      },
      { onCancel: () => this.pickCancelled() },
    );
  }

  /** The bracket straight from two slice indices (a drag on the chart). */
  setReferenceRange(k0: number, k1: number): void {
    this.disarmIfPicking('ref');
    useAirwayStore.getState().set({
      refRangeK: normalizeRange(k0, k1),
      refPending: null,
      hint: null,
    });
  }

  /** A drag over profile samples i0..i1 of the current result. */
  setReferenceFromSamples(i0: number, i1: number): void {
    const s = useAirwayStore.getState();
    const range = rangeFromSamples(s.result?.sample_k, i0, i1);
    if (!range) {
      s.set({
        hint: 'This result has no slice indices to bracket from — re-run the analysis, or click two points in a view.',
      });
      return;
    }
    this.setReferenceRange(range[0], range[1]);
  }

  clearReference(): void {
    this.disarmIfPicking('ref');
    useAirwayStore.getState().set({ refRangeK: null, refPending: null, hint: null });
  }

  /* ---------------- run ---------------- */

  async run(): Promise<void> {
    const app = useAppStore.getState();
    const s = useAirwayStore.getState();
    const uid = app.activeSeries?.series_uid;
    const body = pendingRequest(s, uid);
    if (!body) return;

    this.disarm();
    const before: AirwayPhase = s.result ? 'result' : 'setup';
    s.set({ phase: 'running', picking: null, hint: null, refPending: null });
    try {
      const result = await analysis.airway(body);
      useAirwayStore.getState().set({
        phase: 'result',
        result,
        sent: body,
        hoverIndex: result.min_csa_index,
        added: false,
        structureAdded: false,
      });
      this.jumpToIndex(result.min_csa_index);
      void this.publishStructure(result).finally(() => this.reassertJump(result));
    } catch (e) {
      useAirwayStore.getState().set({ phase: before });
      useAppStore.getState().toast({
        kind: 'err',
        title: 'Airway analysis failed',
        message: (e as Error)?.message ?? String(e),
      });
    }
  }

  /**
   * The lumen becomes a normal structure, in the airway colour, shown in 3D.
   * A re-run with a different reference segments the same lumen again, so the
   * previous row is replaced rather than duplicated.
   */
  private async publishStructure(result: AirwayResult): Promise<void> {
    try {
      if (this.structureId) {
        const old = this.structureId;
        this.structureId = null;
        await removeStructure(old);
      }
      const stats = await analysis.labelStats(result.label_id);
      const row = await addStructureFromLabel(stats, {
        name: 'Airway lumen',
        source: 'airway',
        color: ANATOMY.airway.rgb,
        surface: true,
      });
      this.structureId = row?.id ?? null;
      useAirwayStore.getState().set({ structureAdded: true });
    } catch (e) {
      console.warn('[hnrad] the airway lumen could not be added as a structure', e);
    }
  }

  /* ---------------- chart interaction ---------------- */

  /** Move the MPR views to a centreline sample and remember it. */
  jumpToIndex(index: number): void {
    const r = useAirwayStore.getState().result;
    if (!r) return;
    const i = Math.max(0, Math.min(r.centerline_lps.length - 1, Math.round(index)));
    const p = r.centerline_lps[i];
    if (!p) return;
    useAirwayStore.getState().set({ hoverIndex: i });
    viewer.jumpToWorld([p[0], p[1], p[2]] as Types.Point3);
  }

  hover(index: number | null): void {
    useAirwayStore.getState().set({ hoverIndex: index });
  }

  /**
   * Showing the lumen as a labelmap pulls the MPR cameras back to the middle
   * slice: Cornerstone's `addActors` brackets its own `resetCamera` with a view
   * reference round trip that a volume viewport does not fully restore. That
   * happens whenever the segmentation render engine attaches the actors, which
   * is a tick or two after the representation is registered — so the jump is
   * re-asserted on ACTORS_CHANGED rather than on a guessed delay, with two
   * timed retries in case the actors were already in place.
   *
   * It always jumps to the sample the store currently holds, which is the
   * user's if they clicked the chart in the meantime.
   */
  private reassertJump(result: AirwayResult): void {
    const jump = (): void => {
      const at = useAirwayStore.getState();
      if (at.result !== result) return;
      this.jumpToIndex(at.hoverIndex ?? result.min_csa_index);
    };

    const elements = viewer.mprPanes
      .map((p) => viewer.getElement(p))
      .filter((el): el is HTMLDivElement => el !== null);
    // The reset happens inside addActors, before it fires the event, so a
    // task-queue hop after the event is enough.
    const onActors = () => window.setTimeout(jump, 0);
    elements.forEach((el) => el.addEventListener(csEnums.Events.ACTORS_CHANGED, onActors));
    window.setTimeout(() => {
      elements.forEach((el) => el.removeEventListener(csEnums.Events.ACTORS_CHANGED, onActors));
    }, 8000);

    jump();
    [300, 1200].forEach((ms) => window.setTimeout(jump, ms));
  }

  /* ---------------- measurements ---------------- */

  addToMeasurements(): void {
    const { result, added } = useAirwayStore.getState();
    if (!result || added) return;
    const eq = minEquivalentDiameterMm(result);
    viewer.addDerivedMeasurement(
      {
        uid: `airway-${++rowSeq}`,
        toolName: 'Airway stenosis',
        value: `${Math.round(result.stenosis_pct)} %`,
        extra: narrative(result),
        paneId: 'axial',
        sliceIndex: null,
      },
      {
        FrameOfReferenceUID: viewer.getFrameOfReferenceUID(),
        cameraFocalPoint: [result.min_csa_lps[0], result.min_csa_lps[1], result.min_csa_lps[2]],
      },
    );
    useAirwayStore.getState().set({ added: true });
    useAppStore.getState().toast({
      kind: 'ok',
      title: `${Math.round(result.stenosis_pct)}% stenosis added`,
      message: `min CSA ${result.min_csa_mm2.toFixed(1)} mm² · eq. ⌀ ${eq.toFixed(1)} mm`,
    });
  }

  /* ---------------- picks ---------------- */

  /** Esc during a pick: the step stays where it was, nothing else changes. */
  private pickCancelled(): void {
    this.pick = null;
    useAirwayStore.getState().set({ picking: null, refPending: null });
  }

  private disarmIfPicking(which: AirwayPick): void {
    const s = useAirwayStore.getState();
    if (s.picking !== which) return;
    this.disarm();
    s.set({ picking: null, refPending: null });
  }

  private disarm(): void {
    this.pick?.cancel();
    this.pick = null;
  }
}

export const airway = new AirwayTool();

// One airway result belongs to one series.
useAppStore.subscribe((s, prev) => {
  if (s.activeSeries?.series_uid !== prev.activeSeries?.series_uid) airway.reset();
});
