/**
 * One-click point picking in an MPR viewport.
 *
 * Several head-and-neck tools need "the next click in an image is my seed"
 * (region grow, the airway seed, the glottis mark). Cornerstone's own tools sit
 * on the viewport element, so the listener goes on `window` in the capture
 * phase: that runs before anything bound to the element, and stopping
 * propagation there means the click never reaches Crosshairs.
 */
import type { Types } from '@cornerstonejs/core';
import { viewer } from './ViewerCore';
import type { PaneId } from '../store/useAppStore';

export interface PickResult {
  pane: PaneId;
  world: Types.Point3;
  /** Voxel index in the loaded CT volume; null when the click missed it. */
  ijk: [number, number, number] | null;
  hu: number | null;
}

export interface PickHandle {
  /** Stop listening without firing. */
  cancel: () => void;
}

/**
 * Arm a one-shot pick. Returns a handle so the caller can disarm it (Esc, a
 * cancelled step, an unmounted panel). The pick fires at most once.
 */
export function armPick(
  onPick: (p: PickResult) => void,
  options: { onCancel?: () => void } = {},
): PickHandle {
  let live = true;

  const panes = (): PaneId[] => (viewer.mprPanes.length ? viewer.mprPanes : ['axial', 'sagittal', 'coronal']);

  const disarm = (): void => {
    if (!live) return;
    live = false;
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('picking');
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    disarm();
    options.onCancel?.();
  };

  const onDown = (e: PointerEvent): void => {
    if (!live) return;
    const target = e.target as Node | null;
    if (!target) return;

    for (const pane of panes()) {
      const host = viewer.getElement(pane);
      if (!host || !host.contains(target)) continue;

      e.preventDefault();
      e.stopPropagation();
      // stopImmediatePropagation as well: Cornerstone binds several listeners
      // and a capture-phase stopPropagation alone still lets siblings run.
      e.stopImmediatePropagation();
      disarm();

      const vp = viewer.getViewport(pane) as
        | (Types.IViewport & { canvasToWorld?: (p: [number, number]) => Types.Point3 })
        | null;
      if (!vp?.canvasToWorld) {
        options.onCancel?.();
        return;
      }
      const rect = host.getBoundingClientRect();
      let world: Types.Point3;
      try {
        world = vp.canvasToWorld([e.clientX - rect.left, e.clientY - rect.top]);
      } catch {
        options.onCancel?.();
        return;
      }
      const ijk = viewer.worldToIjk(world);
      onPick({ pane, world, ijk, hu: ijk ? viewer.huAtIjk(ijk) : null });
      return;
    }
  };

  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  document.body.classList.add('picking');

  return { cancel: () => {
    disarm();
  } };
}
