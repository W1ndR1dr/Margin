/**
 * Structures on screen: labelmaps on the three MPR panes, surfaces in 3D.
 *
 * ViewerCore stays the owner of the rendering engine; this module owns only
 * the segmentation state that hangs off it, and reaches the viewports through
 * ViewerCore's helpers.
 *
 * Memory: a 512 × 512 × 180 uint8 labelmap is ~47 MB, so only MAX_RESIDENT of
 * them are kept alive. A group of related structures (the 20 nodal levels, a
 * TotalSegmentator run) is merged into ONE multi-label labelmap with a colour
 * per segment index, which is one allocation instead of twenty.
 */
import { volumeLoader, type Types } from '@cornerstonejs/core';
import { Enums as csToolsEnums, segmentation as csSeg } from '@cornerstonejs/tools';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';

import { analysis } from '../api/client';
import { viewer, VIEWPORT_ID } from '../viewer/ViewerCore';
import type { PaneId } from '../store/useAppStore';
import { describeMismatch, MaskGeometryError } from './geometry';
import { loadMask } from './maskLoader';
import { parseBinaryStl } from './stl';
import type { Rgb } from './colors';

const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;

/** At most this many labelmap volumes stay resident (~47 MB each). */
export const MAX_RESIDENT = 12;

const MPR: PaneId[] = ['axial', 'sagittal', 'coronal'];

function mprViewportIds(): string[] {
  const live = viewer.mprPanes;
  return (live.length ? live : MPR).map((p) => VIEWPORT_ID[p]);
}

export interface SegmentSpec {
  /** Backend label id whose mask fills this segment. */
  labelId: string;
  /** 1-based segment index inside the labelmap. */
  segmentIndex: number;
  name: string;
  color: Rgb;
}

interface Resident {
  segmentationId: string;
  volumeId: string;
  segments: SegmentSpec[];
  /** Monotonic counter, for the eviction order. */
  touched: number;
  /** vtk actor uids currently parked in the 3D viewport, by segment index. */
  actors: Map<number, string>;
}

export class SegmentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentationError';
  }
}

let touchSeq = 0;

/** Voxels merged per task. ~8 M is a few milliseconds and never a long task. */
const MERGE_CHUNK = 8_000_000;

/**
 * OR one mask into the shared buffer under its segment index, in chunks with a
 * yield between them. Both arrays are i-fastest C order (the backend writes
 * `(z, y, x)`, vtk reads `[i, j, k]` with i fastest), so a straight index walk
 * is the right mapping. Later segments win where two masks overlap.
 */
async function mergeInto(
  merged: Uint8Array,
  data: Uint8Array,
  index: number,
  total: number,
): Promise<void> {
  for (let start = 0; start < total; start += MERGE_CHUNK) {
    const end = Math.min(start + MERGE_CHUNK, total);
    for (let n = start; n < end; n++) if (data[n]) merged[n] = index;
    if (end < total) await new Promise<void>((r) => setTimeout(r, 0));
  }
}

class SegmentationService {
  private resident = new Map<string, Resident>();

  /** Segmentation ids in use, oldest first. */
  get residentIds(): string[] {
    return [...this.resident.values()].sort((a, b) => a.touched - b.touched).map((r) => r.segmentationId);
  }

  get residentCount(): number {
    return this.resident.size;
  }

  /* ---------------- adding ---------------- */

  /**
   * Build one labelmap volume from the given segments and show it on the MPR
   * panes. `segments` longer than one merges several backend masks into a
   * single multi-label volume.
   */
  async addLabelmap(segmentationId: string, segments: SegmentSpec[]): Promise<string[]> {
    if (!segments.length) throw new SegmentationError('no segments to display');
    const ctVolumeId = viewer.ctVolumeId;
    const ct = viewer.getCtVolume();
    if (!ctVolumeId || !ct) {
      throw new SegmentationError('open a volumetric CT before adding a structure');
    }

    this.remove(segmentationId);
    const evicted = this.evictDownTo(MAX_RESIDENT - 1);

    const dims = ct.dimensions;
    const total = dims[0] * dims[1] * dims[2];
    const merged = new Uint8Array(total);

    for (const seg of segments) {
      const { geometry, data } = await loadMask(seg.labelId);
      const complaint = describeMismatch(geometry, { dimensions: dims, spacing: ct.spacing });
      if (complaint) {
        throw new MaskGeometryError(
          `"${seg.name}" does not sit on the CT grid — ${complaint}. The structure was not displayed.`,
        );
      }
      await mergeInto(merged, data, seg.segmentIndex & 0xff, total);
    }

    const volumeId = `hnrad-labelmap:${segmentationId}`;
    const volume = volumeLoader.createAndCacheDerivedLabelmapVolume(ctVolumeId, { volumeId });
    const vm = volume.voxelManager as
      | { setCompleteScalarDataArray?: (d: ArrayLike<number>) => void }
      | undefined;
    if (!vm?.setCompleteScalarDataArray) {
      throw new SegmentationError('the labelmap volume could not accept voxel data');
    }
    vm.setCompleteScalarDataArray(merged);

    csSeg.addSegmentations([
      {
        segmentationId,
        representation: {
          type: LABELMAP,
          data: { volumeId, referencedVolumeId: ctVolumeId },
        },
        config: {
          segments: Object.fromEntries(
            segments.map((s) => [s.segmentIndex, { segmentIndex: s.segmentIndex, label: s.name }]),
          ),
        },
      },
    ]);

    const viewportIds = mprViewportIds();
    csSeg.addLabelmapRepresentationToViewportMap(
      Object.fromEntries(viewportIds.map((id) => [id, [{ segmentationId, type: LABELMAP }]])),
    );

    this.resident.set(segmentationId, {
      segmentationId,
      volumeId,
      segments: [...segments],
      touched: ++touchSeq,
      actors: new Map(),
    });

    // Colour is viewport-scoped in 5.10, so every pane gets the same LUT entry.
    segments.forEach((s) => this.setColor(segmentationId, s.segmentIndex, s.color));
    this.setOpacity(segmentationId, 0.55);
    this.render();
    return evicted;
  }

  /* ---------------- appearance ---------------- */

  setColor(segmentationId: string, segmentIndex: number, color: Rgb): void {
    const r = this.resident.get(segmentationId);
    if (r) {
      const seg = r.segments.find((s) => s.segmentIndex === segmentIndex);
      if (seg) seg.color = color;
    }
    mprViewportIds().forEach((viewportId) => {
      try {
        csSeg.config.color.setSegmentIndexColor(viewportId, segmentationId, segmentIndex, [
          color[0],
          color[1],
          color[2],
          255,
        ]);
      } catch {
        /* the representation is not on this viewport yet */
      }
    });
    // Keep any 3D surface of the same segment in step.
    const uid = r?.actors.get(segmentIndex);
    if (uid) this.tintActor(uid, color);
  }

  /** `alpha` is the labelmap fill opacity, 0..1. */
  setOpacity(segmentationId: string, alpha: number): void {
    const a = Math.max(0, Math.min(1, alpha));
    try {
      csSeg.config.style.setStyle(
        { segmentationId, type: LABELMAP },
        {
          fillAlpha: a,
          fillAlphaInactive: a,
          renderFill: true,
          renderOutline: true,
          outlineWidth: 1,
          outlineOpacity: Math.max(a, 0.6),
          outlineWidthInactive: 1,
          renderOutlineInactive: true,
          renderFillInactive: true,
          outlineOpacityInactive: Math.max(a, 0.6),
        },
        true,
      );
    } catch (e) {
      console.warn('[hnrad] could not set the labelmap opacity', e);
    }
    const r = this.resident.get(segmentationId);
    r?.actors.forEach((uid) => this.setActorOpacity(uid, Math.max(0.15, a + 0.2)));
    this.render();
  }

  setVisible(segmentationId: string, visible: boolean): void {
    mprViewportIds().forEach((viewportId) => {
      try {
        csSeg.config.visibility.setSegmentationRepresentationVisibility(
          viewportId,
          { segmentationId, type: LABELMAP },
          visible,
        );
      } catch {
        /* not represented on this viewport */
      }
    });
    const r = this.resident.get(segmentationId);
    r?.actors.forEach((uid) => this.setActorVisible(uid, visible));
    this.render();
  }

  /** Per-segment visibility, for a group row that hides one structure. */
  setSegmentVisible(segmentationId: string, segmentIndex: number, visible: boolean): void {
    mprViewportIds().forEach((viewportId) => {
      try {
        csSeg.config.visibility.setSegmentIndexVisibility(
          viewportId,
          { segmentationId, type: LABELMAP },
          segmentIndex,
          visible,
        );
      } catch {
        /* not represented on this viewport */
      }
    });
    const uid = this.resident.get(segmentationId)?.actors.get(segmentIndex);
    if (uid) this.setActorVisible(uid, visible);
    this.render();
  }

  /* ---------------- 3D surface ---------------- */

  /**
   * Fetch the label's STL and park it in the 3D viewport as a vtk actor.
   *
   * 5.10 does have a Surface representation, but its display path falls through
   * to the optional PolySeg add-on whenever the surface data is not already in
   * the cache; a plain actor is predictable and lets the structure keep its
   * own colour, opacity and visibility.
   */
  async addSurface(
    segmentationId: string,
    segmentIndex: number,
    labelId: string,
    color: Rgb,
  ): Promise<number> {
    const buffer = await analysis.mesh(labelId);
    const mesh = parseBinaryStl(buffer);
    if (!mesh.triangles) {
      throw new SegmentationError('the mesh came back empty — nothing to show in 3D');
    }

    const polyData = vtkPolyData.newInstance();
    polyData.getPoints().setData(mesh.points, 3);
    polyData.getPolys().setData(mesh.polys);

    const mapper = vtkMapper.newInstance();
    mapper.setInputData(polyData);
    const actor = vtkActor.newInstance();
    actor.setMapper(mapper);
    const prop = actor.getProperty();
    prop.setColor(color[0] / 255, color[1] / 255, color[2] / 255);
    prop.setOpacity(0.85);
    prop.setSpecular(0.2);

    const uid = `hnrad-surface:${segmentationId}:${segmentIndex}`;
    if (!viewer.addActorTo3d(uid, actor)) {
      throw new SegmentationError('the 3D viewport is not available');
    }
    const r = this.resident.get(segmentationId);
    if (r) r.actors.set(segmentIndex, uid);
    else this.orphanActors.add(uid);
    return mesh.triangles;
  }

  removeSurface(segmentationId: string, segmentIndex: number): void {
    const r = this.resident.get(segmentationId);
    const uid = r?.actors.get(segmentIndex) ?? `hnrad-surface:${segmentationId}:${segmentIndex}`;
    viewer.removeActorFrom3d(uid);
    r?.actors.delete(segmentIndex);
    this.orphanActors.delete(uid);
  }

  /** Surfaces added while their labelmap was not resident (e.g. after eviction). */
  private orphanActors = new Set<string>();

  private actorFor(uid: string): { getProperty: () => unknown; setVisibility: (v: boolean) => void } | null {
    const vp = viewer.getViewport('volume3d') as
      | (Types.IViewport & { getActor?: (uid: string) => { actor?: unknown } | undefined })
      | null;
    const entry = vp?.getActor?.(uid);
    const actor = (entry as { actor?: unknown } | undefined)?.actor as
      | { getProperty: () => unknown; setVisibility: (v: boolean) => void }
      | undefined;
    return actor ?? null;
  }

  private tintActor(uid: string, color: Rgb): void {
    const prop = this.actorFor(uid)?.getProperty() as { setColor?: (r: number, g: number, b: number) => void } | undefined;
    prop?.setColor?.(color[0] / 255, color[1] / 255, color[2] / 255);
    viewer.render3d();
  }

  private setActorOpacity(uid: string, alpha: number): void {
    const prop = this.actorFor(uid)?.getProperty() as { setOpacity?: (a: number) => void } | undefined;
    prop?.setOpacity?.(Math.max(0, Math.min(1, alpha)));
    viewer.render3d();
  }

  private setActorVisible(uid: string, visible: boolean): void {
    this.actorFor(uid)?.setVisibility(visible);
    viewer.render3d();
  }

  /* ---------------- removal ---------------- */

  remove(segmentationId: string): void {
    const r = this.resident.get(segmentationId);
    if (r) {
      r.actors.forEach((uid) => viewer.removeActorFrom3d(uid));
      r.actors.clear();
    }
    mprViewportIds().forEach((viewportId) => {
      try {
        csSeg.removeSegmentationRepresentations(viewportId, { segmentationId });
      } catch {
        /* never represented here */
      }
    });
    try {
      csSeg.removeSegmentation(segmentationId);
    } catch {
      /* not registered */
    }
    this.resident.delete(segmentationId);
    this.render();
  }

  /** Series changed / viewer torn down: forget everything. */
  clear(): void {
    [...this.resident.keys()].forEach((id) => this.remove(id));
    this.orphanActors.forEach((uid) => viewer.removeActorFrom3d(uid));
    this.orphanActors.clear();
    this.resident.clear();
  }

  /** Drop the least recently added labelmaps until only `keep` remain. */
  private evictDownTo(keep: number): string[] {
    const evicted: string[] = [];
    const order = [...this.resident.values()].sort((a, b) => a.touched - b.touched);
    while (this.resident.size > Math.max(0, keep) && order.length) {
      const victim = order.shift();
      if (!victim) break;
      evicted.push(victim.segmentationId);
      this.remove(victim.segmentationId);
    }
    return evicted;
  }

  private render(): void {
    try {
      viewer.renderingEngine?.render();
    } catch {
      /* engine mid-teardown */
    }
  }
}

export const segmentations = new SegmentationService();
