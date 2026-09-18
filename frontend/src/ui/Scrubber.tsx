/**
 * Scrubber — the slice bar along the bottom edge of every MPR viewport, and
 * one of Margin's signature elements.
 *
 * UI-OVERHAUL.md §2: "a 4 px scrubber along its bottom edge with a tick every
 * 10 slices and colored markers where findings live (warn amber, danger red,
 * node violet, tumour magenta). Hover shows the finding title; click jumps."
 *
 * So this is not a progress bar with a drag handler bolted on: it is the
 * study's table of contents. If a finding exists at slice 112, the scrubber
 * says so before the user has scrolled anywhere near it.
 *
 * The ticks are drawn in one SVG rather than as N positioned divs: a 500-slice
 * CT would otherwise put 50 elements per viewport into the layout on every
 * resize, and there are four viewports.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export type MarkerTone = 'warn' | 'danger' | 'node' | 'tumor' | 'ok' | 'accent';

export interface ScrubberMarker {
  id: string;
  /** Slice index this finding lives on. */
  slice: number;
  tone: MarkerTone;
  /** Shown on hover. */
  title: string;
}

export interface ScrubberProps {
  slice: number;
  total: number;
  onScrub: (index: number) => void;
  /** Coloured findings along the bar. */
  markers?: ScrubberMarker[];
  /** Click a marker rather than the bar — jumps and selects the finding. */
  onMarker?: (id: string) => void;
  /** The plane colour for the fill; defaults to the CSS var on the pane. */
  accent?: string;
  /** A tick every N slices. 0 disables the ruler. */
  tickEvery?: number;
  className?: string;
}

const TONE_VAR: Record<MarkerTone, string> = {
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  node: 'var(--node)',
  tumor: 'var(--tumor)',
  ok: 'var(--ok)',
  accent: 'var(--accent)',
};

export function Scrubber({
  slice,
  total,
  onScrub,
  markers,
  onMarker,
  accent,
  tickEvery = 10,
  className,
}: ScrubberProps) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [hover, setHover] = useState<{ x: number; index: number; marker?: ScrubberMarker } | null>(null);

  if (total <= 1) return null;

  const last = total - 1;

  const at = (clientX: number): { index: number; x: number; t: number } => {
    const el = ref.current;
    if (!el) return { index: slice, x: 0, t: 0 };
    const r = el.getBoundingClientRect();
    const t = Math.min(Math.max((clientX - r.left) / Math.max(r.width, 1), 0), 1);
    return { index: Math.round(t * last), x: clientX - r.left, t };
  };

  /** The marker nearest the pointer, within ~2 % of the bar. */
  const markerNear = (t: number): ScrubberMarker | undefined => {
    if (!markers?.length) return undefined;
    const tol = Math.max(2, last * 0.02);
    let best: ScrubberMarker | undefined;
    let bestD = Infinity;
    for (const m of markers) {
      const d = Math.abs(m.slice - t * last);
      if (d < bestD && d <= tol) {
        bestD = d;
        best = m;
      }
    }
    return best;
  };

  const pct = (i: number) => (last > 0 ? (i / last) * 100 : 0);
  const ticks: number[] = [];
  if (tickEvery > 0 && total / tickEvery <= 200) {
    for (let i = tickEvery; i < total; i += tickEvery) ticks.push(i);
  }

  return (
    <div
      ref={ref}
      className={`mg-scrub${className ? ` ${className}` : ''}`}
      style={accent ? { ['--mg-scrub-accent' as string]: accent } : undefined}
      role="slider"
      tabIndex={-1}
      aria-label="Slice"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={slice + 1}
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const hit = at(e.clientX);
        const m = markerNear(hit.t);
        if (m && onMarker) {
          onMarker(m.id);
          return;
        }
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        onScrub(hit.index);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* pointer already released */
        }
      }}
      onPointerMove={(e) => {
        const hit = at(e.clientX);
        setHover({ x: hit.x, index: hit.index, marker: markerNear(hit.t) });
        if (dragging.current) onScrub(hit.index);
      }}
      onPointerLeave={() => setHover(null)}
    >
      <div className="mg-scrub-track">
        <div className="mg-scrub-fill" style={{ width: `${pct(slice)}%` }} />
      </div>

      {ticks.length > 0 && (
        <svg className="mg-scrub-ticks" preserveAspectRatio="none" viewBox="0 0 100 4" aria-hidden>
          {ticks.map((i) => (
            <rect key={i} x={pct(i)} y="0" width="0.12" height="4" fill="currentColor" />
          ))}
        </svg>
      )}

      {markers?.map((m) => (
        <span
          key={m.id}
          className={`mg-scrub-mark tone-${m.tone}${hover?.marker?.id === m.id ? ' hot' : ''}`}
          style={{ left: `${pct(m.slice)}%`, background: TONE_VAR[m.tone] }}
          aria-hidden
        />
      ))}

      <span className="mg-scrub-head" style={{ left: `${pct(slice)}%` }} aria-hidden />

      {hover && (
        <span
          className={`mg-scrub-tip${hover.marker ? ' mark' : ''}`}
          style={{
            left: hover.x,
            ...(hover.marker ? { ['--mg-scrub-tip' as string]: TONE_VAR[hover.marker.tone] } : {}),
          }}
        >
          {hover.marker ? (
            <>
              <span className="t">{hover.marker.title}</span>
              <span className="n mono">slice {hover.marker.slice + 1}</span>
            </>
          ) : (
            <span className="n mono">
              {hover.index + 1} / {total}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
