/**
 * The anatomy chip's data source: the structure under the cursor, live.
 *
 * ViewerCore already runs an HU probe on pointer-move and pushes it into the
 * zustand store. This module deliberately does NOT join it. The HU probe
 * changes on essentially every move, so a store write per move is unavoidable
 * there; the anatomy answer changes on maybe one move in twenty, and routing it
 * through the store would turn "the cursor drifted 2 px inside the same node"
 * into a React render. So the reading lives here, behind a plain listener set,
 * and only a genuine change notifies. A caller that wants React state adapts it
 * with one `useSyncExternalStore`; a caller that just wants to paint a chip can
 * subscribe and write to a ref.
 *
 * ---------------------------------------------------------------------------
 * Threading: main thread, measured rather than assumed.
 *
 * `sampleLayers` is one affine inverse plus one array index per resident
 * labelmap. Measured on this box (node 22, 512 x 512 x 180 uint8 labelmaps,
 * scattered sample points so the CPU cache never helps): ~25 ns per layer, so
 * ~0.27 us with the full MAX_RESIDENT = 12 labelmaps resident. That is ~0.002%
 * of a 16.7 ms frame. Moving it to a worker would cost a structured clone of
 * every labelmap (~47 MB each) at registration, a postMessage round trip per
 * move, and a frame of latency on the chip -- to save a quarter of a
 * microsecond. The measurement says main thread; so does the code.
 *
 * `anatomySampler.ts` is nevertheless kept pure and its inputs transferable, so
 * if labelmaps ever grow an order of magnitude the move is mechanical.
 * ---------------------------------------------------------------------------
 */
import { cache, type Types } from '@cornerstonejs/core';

import { viewer } from '../viewer/ViewerCore';
import {
  sampleLayers,
  samplersEqual,
  type AnatomyHit,
  type SamplerGrid,
  type SamplerLayer,
} from './anatomySampler';

export interface AnatomyReading {
  /** Structure under the cursor, or null when the cursor is on background. */
  hit: AnatomyHit | null;
  /** Intensity at the same voxel (HU for CT). Null when unavailable. */
  intensity: number | null;
  /** LPS mm of the sampled point. */
  world: [number, number, number] | null;
}

/**
 * HU is integral in practice, so anything below half a unit is noise from the
 * world -> index rounding rather than the cursor having reached a new voxel.
 */
const INTENSITY_EPSILON = 0.5;

const EMPTY: AnatomyReading = { hit: null, intensity: null, world: null };

/**
 * `SegmentationService` names its derived labelmap volumes
 * `hnrad-labelmap:{segmentationId}` but keeps its resident map private, so the
 * convention is repeated here to let `registerSegmentation` find the voxels in
 * the Cornerstone cache without widening that module's surface.
 */
function labelmapVolumeId(segmentationId: string): string {
  return `hnrad-labelmap:${segmentationId}`;
}

class AnatomyProbe {
  private layers = new Map<string, SamplerLayer>();

  /**
   * The same layers as a dense array, in registration order. Rebuilt on every
   * mutation (rare) so that sampling (60 times a second) never allocates.
   */
  private ordered: SamplerLayer[] = [];

  private listeners = new Set<(r: AnatomyReading) => void>();

  private reading: AnatomyReading = EMPTY;

  private raf = 0;

  private queued: [number, number, number] | null = null;

  /* ---------------- registration ---------------- */

  registerLayer(layer: SamplerLayer): void {
    // Delete first so a re-registration moves to the back of the insertion
    // order: "most recently registered wins" is what the overlap rule promises.
    this.layers.delete(layer.segmentationId);
    this.layers.set(layer.segmentationId, layer);
    this.reindex();
  }

  unregisterLayer(segmentationId: string): void {
    if (!this.layers.delete(segmentationId)) return;
    this.reindex();
    // The chip may be showing a structure that just went away.
    if (this.reading.hit?.segmentationId === segmentationId) this.resample();
  }

  /** A group's rows can be renamed/recoloured without re-fetching voxels. */
  updateNames(
    segmentationId: string,
    names: Map<number, string>,
    colors: Map<number, string>,
  ): void {
    const layer = this.layers.get(segmentationId);
    if (!layer) return;
    layer.names = names;
    layer.colors = colors;
    if (this.reading.hit?.segmentationId === segmentationId) this.resample();
  }

  clear(): void {
    this.layers.clear();
    this.ordered = [];
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.queued = null;
    if (this.reading !== EMPTY) {
      this.reading = EMPTY;
      this.emit();
    }
  }

  get hasLayers(): boolean {
    return this.ordered.length > 0;
  }

  /**
   * Register the labelmap that `segmentationService` has already pushed into
   * Cornerstone, pulling the voxels straight out of the volume cache.
   *
   * Convenience, not a second code path: the merged `Uint8Array` only ever
   * exists as a local inside `SegmentationService.addLabelmap`, which hands it
   * to the derived volume and drops its own reference, so the cached volume is
   * the one remaining owner. Returns false when that volume is not in the cache
   * -- call this after `addLabelmap` has resolved.
   *
   * `getCompleteScalarDataArray()` rebuilds the array slice by slice, so this
   * is a genuinely expensive call (one full copy of a ~47 MB labelmap). It
   * belongs at registration and nowhere near the pointer handler -- which is
   * exactly why `SamplerLayer` holds the buffer rather than fetching it.
   */
  registerSegmentation(
    segmentationId: string,
    names: Map<number, string>,
    colors: Map<number, string>,
    priority = 0,
  ): boolean {
    const volume = cache.getVolume(labelmapVolumeId(segmentationId));
    if (!volume) return false;

    const vm = volume.voxelManager as
      | { getCompleteScalarDataArray?: () => ArrayLike<number> }
      | undefined;
    const raw = vm?.getCompleteScalarDataArray?.();
    if (!raw) return false;
    // A labelmap volume is uint8, but ArrayLike is all the type promises.
    const data = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);

    const grid = gridOf(volume);
    if (!grid) return false;

    this.registerLayer({ segmentationId, grid, data, names, colors, priority });
    return true;
  }

  /* ---------------- sampling ---------------- */

  /** Synchronous, allocation-light, and safe before anything is loaded. */
  sampleAt(world: [number, number, number]): AnatomyReading {
    const hit = this.ordered.length ? sampleLayers(this.ordered, world) : null;

    // The CT may be absent (stack mode, mid-teardown). The chip still works
    // from the labelmap alone, so a missing intensity is not an error.
    let intensity: number | null = null;
    const ijk = viewer.worldToIjk(world as Types.Point3);
    if (ijk) intensity = viewer.huAtIjk(ijk);

    return { hit, intensity, world: [world[0], world[1], world[2]] };
  }

  /**
   * Feed a pointer position in. Cheap to call as often as the pointer fires:
   * the sample is coalesced to one per animation frame, and subscribers hear
   * about it only when the answer actually changed.
   */
  push(world: [number, number, number]): void {
    this.queued = [world[0], world[1], world[2]];
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const next = this.queued;
      this.queued = null;
      if (next) this.commit(this.sampleAt(next));
    });
  }

  get last(): AnatomyReading {
    return this.reading;
  }

  subscribe(fn: (r: AnatomyReading) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /* ---------------- internals ---------------- */

  private reindex(): void {
    this.ordered = [...this.layers.values()];
  }

  /** Re-run the last sample after the layers changed underneath it. */
  private resample(): void {
    const world = this.reading.world;
    this.commit(world ? this.sampleAt(world) : EMPTY);
  }

  private commit(next: AnatomyReading): void {
    const prev = this.reading;
    // `world` moves on every single pointer event and is not itself a reason to
    // notify; it is carried along so `last` stays truthful for whoever asks.
    const changed =
      !samplersEqual(prev.hit, next.hit) || !intensityEqual(prev.intensity, next.intensity);
    this.reading = next;
    if (changed) this.emit();
  }

  private emit(): void {
    const r = this.reading;
    // Copy the set: a listener that unsubscribes inside its own callback must
    // not cause the next listener to be skipped.
    [...this.listeners].forEach((fn) => {
      try {
        fn(r);
      } catch (e) {
        console.warn('[hnrad] an anatomy probe listener threw', e);
      }
    });
  }
}

function intensityEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < INTENSITY_EPSILON;
}

/** The volume's grid, in the shape the pure sampler wants. */
function gridOf(volume: Types.IImageVolume): SamplerGrid | null {
  const { dimensions, origin, spacing, direction } = volume;
  if (!dimensions || !origin || !spacing || !direction) return null;
  // `direction` is a Mat3, which may be a Float32Array; the sampler wants a
  // plain array so it stays free of Cornerstone types.
  const d = Array.from(direction as ArrayLike<number>);
  if (d.length !== 9) return null;
  return {
    dims: [dimensions[0], dimensions[1], dimensions[2]],
    origin: [origin[0], origin[1], origin[2]],
    spacing: [spacing[0], spacing[1], spacing[2]],
    direction: d,
  };
}

export const anatomyProbe = new AnatomyProbe();
