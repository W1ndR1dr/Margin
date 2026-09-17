/**
 * Slice navigation arithmetic shared by the scrubber, cine and measurement
 * jumps. Kept free of Cornerstone so it can be unit-tested.
 *
 * Why relative deltas: on Cornerstone3D 5.10 volume viewports a view
 * reference that carries only `{ sliceIndex }` is silently ignored — the
 * index is honoured only next to a matching `volumeId` and `viewPlaneNormal`,
 * and the FrameOfReference fallback never matches an undefined UID — so the
 * camera never moves. Scrolling by `target - current` (what Cornerstone's
 * own `utilities.jumpToSlice` does) works on stack and volume viewports alike.
 */
export interface SliceJump {
  /** Target index after clamping to `[0, total - 1]`. */
  index: number;
  /** Relative scroll to apply from `current` to reach `index`. */
  delta: number;
}

/**
 * Plan a jump from `current` to `target` in a pane with `total` slices.
 * Returns `null` when the pane has no slices or the viewport is already there.
 */
export function planSliceJump(current: number, total: number, target: number): SliceJump | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(current)) return null;
  const last = total - 1;
  const index = Math.max(0, Math.min(Math.round(Number.isFinite(target) ? target : current), last));
  const delta = index - Math.round(current);
  if (delta === 0) return null;
  return { index, delta };
}
