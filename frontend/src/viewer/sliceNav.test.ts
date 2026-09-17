import { describe, expect, it } from 'vitest';
import { planSliceJump } from './sliceNav';

describe('planSliceJump', () => {
  it('scrolls by the signed distance from the current slice', () => {
    expect(planSliceJump(89, 180, 20)).toEqual({ index: 20, delta: -69 });
    expect(planSliceJump(20, 180, 100)).toEqual({ index: 100, delta: 80 });
  });

  it('clamps the target to the slice range', () => {
    expect(planSliceJump(89, 180, 500)).toEqual({ index: 179, delta: 90 });
    expect(planSliceJump(89, 180, -7)).toEqual({ index: 0, delta: -89 });
  });

  it('reaches the very first and last slice from anywhere', () => {
    expect(planSliceJump(179, 180, 0)).toEqual({ index: 0, delta: -179 });
    expect(planSliceJump(0, 180, 179)).toEqual({ index: 179, delta: 179 });
  });

  it('is a no-op when already on the target slice', () => {
    expect(planSliceJump(42, 180, 42)).toBeNull();
    expect(planSliceJump(0, 1, 5)).toBeNull();
  });

  it('refuses panes without slices or without a known position', () => {
    expect(planSliceJump(0, 0, 3)).toBeNull();
    expect(planSliceJump(Number.NaN, 180, 3)).toBeNull();
    expect(planSliceJump(10, Number.NaN, 3)).toBeNull();
  });

  it('rounds fractional scrubber positions to whole slices', () => {
    expect(planSliceJump(10, 180, 12.6)).toEqual({ index: 13, delta: 3 });
  });
});
