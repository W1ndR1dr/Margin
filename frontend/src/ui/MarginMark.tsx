/**
 * The Margin mark — and Margin's loading indicator.
 *
 * DESIGN.md: a tumour blob (filled) with its margin contour offset outward by
 * a constant distance. The gap between the two IS the margin, which is the
 * whole point of the product, so it is also the one thing that animates:
 *
 *   UI-OVERHAUL.md §2 — "Loading and job progress use the mark: the inner blob
 *   fills as a ring sweep, the offset contour pulses subtly."
 *
 * `progress` drives it:
 *   undefined  static mark (title bar, empty states)
 *   null       indeterminate — the contour sweeps on a 1.2 s loop
 *   0..1       determinate — the contour draws to that fraction
 *
 * Deliberately NOT a spinner. A spinner says "something is happening"; this
 * says "Margin is working", and it is the same shape the user sees in the
 * title bar, so progress anywhere in the app reads as one system.
 *
 * (The two paths trace the same silhouette as public/icon.svg — they are the
 * product mark, not a hand-drawn UI glyph, which is why they live in code.)
 */
import { useId } from 'react';

/** The tumour blob: filled, the thing being measured. */
const BLOB =
  'M20.87 13.41 Q22.5 16 20.81 18.5 Q19.13 21 15.99 21.46 Q12.85 21.92 11.43 19.07 ' +
  'Q10 16.21 11.5 13.28 Q13 10.35 16.12 10.59 Q19.23 10.83 20.87 13.41 Z';

/** The margin: the same contour offset outward by a constant distance. */
const CONTOUR =
  'M22.55 12.48 Q24.7 16 22.49 19.44 Q20.29 22.87 16.05 23.37 Q11.82 23.86 9.81 20.07 ' +
  'Q7.8 16.29 9.88 12.35 Q11.96 8.41 16.18 8.69 Q20.4 8.96 22.55 12.48 Z';

/** The measured distance across the gap. Dropped below 20 px (DESIGN.md). */
const TICK = 'M20.3 19.6 L23.3 22.2';

/**
 * Path length of CONTOUR, measured once with getTotalLength and pasted here so
 * the dash maths needs no layout pass and works during SSR / in tests.
 */
const CONTOUR_LEN = 47.2;

export interface MarginMarkProps {
  size?: number;
  /** undefined = static · null = indeterminate · 0..1 = determinate. */
  progress?: number | null;
  className?: string;
  /** Accessible name. Omit for the decorative title-bar instance. */
  title?: string;
}

export function MarginMark({ size = 20, progress, className, title }: MarginMarkProps) {
  const uid = useId();
  const busy = progress !== undefined;
  const determinate = typeof progress === 'number';
  const pct = determinate ? Math.max(0, Math.min(1, progress)) : 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={`mark${busy ? ' busy' : ''}${className ? ` ${className}` : ''}`}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      aria-valuenow={determinate ? Math.round(pct * 100) : undefined}
    >
      {title && <title>{title}</title>}

      {/* The margin contour. While busy it becomes the track for the sweep. */}
      <path
        d={CONTOUR}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeOpacity={busy ? 0.18 : 0.85}
        className="mark-contour"
      />

      {busy && (
        <path
          d={CONTOUR}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          className={determinate ? 'mark-sweep' : 'mark-sweep indet'}
          pathLength={CONTOUR_LEN}
          strokeDasharray={
            determinate ? `${(CONTOUR_LEN * pct).toFixed(2)} ${CONTOUR_LEN}` : undefined
          }
          style={determinate ? undefined : { strokeDasharray: `${CONTOUR_LEN}` }}
        />
      )}

      {/* The tumour. Dims while the margin is still being worked out. */}
      <path d={BLOB} fill="currentColor" className="mark-blob" key={`${uid}-blob`} />

      {size >= 20 && !busy && (
        <path
          d={TICK}
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeOpacity="0.7"
        />
      )}
    </svg>
  );
}
