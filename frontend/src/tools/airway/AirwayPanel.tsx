/**
 * The Tools-tab panel for the airway analyser: a three-step stepper (seed,
 * optional glottis, optional reference bracket), the input controls, the
 * result card and a CSA-versus-arclength chart drawn inline from design
 * tokens. Dragging on the chart brackets the reference segment.
 */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Brackets,
  CornerUpLeft,
  Loader,
  MapPin,
  Play,
  Plus,
  RefreshCw,
  TriangleAlert,
  Wind,
  X,
} from 'lucide-react';

import { type AirwayResult } from '../../api/client';
import { useAppStore } from '../../store/useAppStore';
import { airway, inputsChanged, useAirwayStore } from './airwayTool';
import {
  GRADE_RANGE,
  GRADE_SEVERITY,
  minEquivalentDiameterMm,
  narrative,
  type GradeSeverity,
} from './report';
import { describeReference, nearestSample, rangeLabel, sampleSpan } from './reference';
import './airway.css';

/* ---------------- Myer–Cotton chip ---------------- */

const SEV_COLOR: Record<GradeSeverity, { color: string; tint: string }> = {
  ok: { color: 'var(--ok)', tint: 'rgba(74, 222, 128, 0.10)' },
  warn: { color: 'var(--warn)', tint: 'rgba(245, 165, 36, 0.10)' },
  danger: { color: 'var(--danger)', tint: 'rgba(240, 85, 79, 0.10)' },
};

/** Colour plus a shape, so the grade survives colour blindness. */
function GradeGlyph({ severity }: { severity: GradeSeverity }) {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
      {severity === 'ok' && <circle cx="6" cy="6" r="2.6" fill="currentColor" />}
      {severity === 'warn' && (
        <path
          d="M6 1.6a4.4 4.4 0 0 1 0 8.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      )}
      {severity === 'danger' && (
        <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="2.2" />
      )}
    </svg>
  );
}

export function GradeChip({ grade }: { grade: 'I' | 'II' | 'III' | 'IV' }) {
  const sev = GRADE_SEVERITY[grade];
  const c = SEV_COLOR[sev];
  return (
    <span
      className="aw-chip"
      style={{ color: c.color, borderColor: c.color, background: c.tint }}
      title={`Myer–Cotton ${grade} — ${GRADE_RANGE[grade]}`}
    >
      <GradeGlyph severity={sev} />
      Myer–Cotton {grade}
    </span>
  );
}

/* ---------------- the CSA chart ---------------- */

const W = 300;
const H = 158;
const PAD = { l: 36, r: 8, t: 10, b: 22 };
/** Pointer travel (in chart units) below which a press is a click, not a drag. */
const DRAG_MIN = 4;

function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.5; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

interface Drag {
  x0: number;
  i0: number;
  i1: number;
  moved: boolean;
}

function CsaChart({ result }: { result: AirwayResult }) {
  const hover = useAirwayStore((s) => s.hoverIndex);
  const refRangeK = useAirwayStore((s) => s.refRangeK);
  const glottis = useAirwayStore((s) => s.glottisSlice);
  const [live, setLive] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const ref = useRef<SVGSVGElement>(null);

  const geom = useMemo(() => {
    const xs = result.arclength_mm;
    const ys = result.csa_mm2;
    const xMax = Math.max(1, xs[xs.length - 1] ?? 1);
    const yMax = Math.max(1, ...ys, result.csa_ref_mm2) * 1.08;
    const px = (v: number) => PAD.l + (v / xMax) * (W - PAD.l - PAD.r);
    const py = (v: number) => H - PAD.b - (v / yMax) * (H - PAD.t - PAD.b);
    const d = xs
      .map((x, i) => `${i ? 'L' : 'M'}${px(x).toFixed(1)} ${py(ys[i] ?? 0).toFixed(1)}`)
      .join(' ');
    const area =
      `M${px(xs[0] ?? 0).toFixed(1)} ${(H - PAD.b).toFixed(1)} ` +
      xs.map((x, i) => `L${px(x).toFixed(1)} ${py(ys[i] ?? 0).toFixed(1)}`).join(' ') +
      ` L${px(xs[xs.length - 1] ?? 0).toFixed(1)} ${(H - PAD.b).toFixed(1)} Z`;
    return { xs, ys, xMax, yMax, px, py, d, area };
  }, [result]);

  // The reference band: the live drag while it lasts, else the stored bracket.
  const band = useMemo<[number, number] | null>(() => {
    if (drag?.moved) return drag.i0 <= drag.i1 ? [drag.i0, drag.i1] : [drag.i1, drag.i0];
    return sampleSpan(result.sample_k, refRangeK);
  }, [drag, result, refRangeK]);
  const glottisAt = useMemo(() => nearestSample(result.sample_k, glottis), [result, glottis]);
  const canDrag = Array.isArray(result.sample_k) && result.sample_k.length === result.csa_mm2.length;

  const at = hover ?? live ?? result.min_csa_index;

  const chartX = (clientX: number): number => {
    const el = ref.current;
    if (!el) return PAD.l;
    const r = el.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * W;
  };
  const indexFromChartX = (xPx: number): number => {
    const t = (xPx - PAD.l) / (W - PAD.l - PAD.r);
    const target = Math.max(0, Math.min(1, t)) * geom.xMax;
    // arclength is monotonic, so a linear scan is exact and fast enough.
    let best = 0;
    let bestD = Infinity;
    geom.xs.forEach((x, i) => {
      const dd = Math.abs(x - target);
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    });
    return best;
  };

  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const x = chartX(e.clientX);
    const i = indexFromChartX(x);
    setDrag({ x0: x, i0: i, i1: i, moved: false });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* not every pointer type supports capture; a drag still works inside the svg */
    }
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const x = chartX(e.clientX);
    const i = indexFromChartX(x);
    setLive(i);
    if (drag) setDrag({ ...drag, i1: i, moved: drag.moved || Math.abs(x - drag.x0) >= DRAG_MIN });
  };
  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* see onDown */
    }
    const i = indexFromChartX(chartX(e.clientX));
    setDrag(null);
    if (drag.moved && canDrag) {
      airway.setReferenceFromSamples(drag.i0, i);
    } else if (!drag.moved) {
      airway.jumpToIndex(i);
    }
  };

  const yTicks = niceTicks(geom.yMax * 0.92, 3);
  const xTicks = niceTicks(geom.xMax, 4);
  const bandX0 = band ? geom.px(geom.xs[band[0]] ?? 0) : 0;
  const bandX1 = band ? geom.px(geom.xs[band[1]] ?? 0) : 0;
  const glottisX = glottisAt !== null ? geom.px(geom.xs[glottisAt] ?? 0) : 0;
  const glottisRight = glottisAt !== null && glottisAt > geom.xs.length / 2;

  return (
    <div className="aw-chart">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="Cross-sectional area along the airway"
        className={drag?.moved ? 'dragging' : undefined}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => setDrag(null)}
        onPointerLeave={() => {
          if (!drag) setLive(null);
        }}
      >
        {/* grid + y axis */}
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={geom.py(v)}
              y2={geom.py(v)}
              stroke="var(--hairline)"
              strokeWidth="1"
            />
            <text x={PAD.l - 5} y={geom.py(v)} className="aw-tick" textAnchor="end" dominantBaseline="middle">
              {v}
            </text>
          </g>
        ))}
        {xTicks.map((v) => (
          <text key={`x${v}`} x={geom.px(v)} y={H - PAD.b + 12} className="aw-tick" textAnchor="middle">
            {Math.round(v)}
          </text>
        ))}

        {/* the reference bracket */}
        {band && (
          <g>
            <rect
              x={bandX0}
              y={PAD.t}
              width={Math.max(1, bandX1 - bandX0)}
              height={H - PAD.t - PAD.b}
              className="aw-band"
            />
            <text x={(bandX0 + bandX1) / 2} y={PAD.t + 9} className="aw-tick band" textAnchor="middle">
              ref
            </text>
          </g>
        )}

        {/* reference CSA */}
        <line
          x1={PAD.l}
          x2={W - PAD.r}
          y1={geom.py(result.csa_ref_mm2)}
          y2={geom.py(result.csa_ref_mm2)}
          stroke="var(--text-3)"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        <text x={W - PAD.r} y={geom.py(result.csa_ref_mm2) - 4} className="aw-tick" textAnchor="end">
          ref {Math.round(result.csa_ref_mm2)}
        </text>

        {/* the curve */}
        <path d={geom.area} fill="var(--accent)" opacity="0.10" />
        <path d={geom.d} fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinejoin="round" />

        {/* glottis */}
        {glottisAt !== null && (
          <g>
            <line
              x1={glottisX}
              x2={glottisX}
              y1={PAD.t}
              y2={H - PAD.b}
              stroke="var(--text-3)"
              strokeWidth="1"
              strokeDasharray="1 3"
            />
            <text
              x={glottisX + (glottisRight ? -3 : 3)}
              y={H - PAD.b - 4}
              className="aw-tick"
              textAnchor={glottisRight ? 'end' : 'start'}
            >
              glottis
            </text>
          </g>
        )}

        {/* minimum */}
        <line
          x1={geom.px(geom.xs[result.min_csa_index] ?? 0)}
          x2={geom.px(geom.xs[result.min_csa_index] ?? 0)}
          y1={PAD.t}
          y2={H - PAD.b}
          stroke="var(--danger)"
          strokeWidth="1"
          strokeDasharray="2 3"
        />
        <circle
          cx={geom.px(geom.xs[result.min_csa_index] ?? 0)}
          cy={geom.py(result.min_csa_mm2)}
          r="3.4"
          fill="var(--danger)"
        />
        <text
          x={geom.px(geom.xs[result.min_csa_index] ?? 0)}
          y={geom.py(result.min_csa_mm2) - 8}
          className="aw-tick min"
          textAnchor="middle"
        >
          min {result.min_csa_mm2.toFixed(0)}
        </text>

        {/* cursor */}
        {at !== result.min_csa_index && (
          <circle
            cx={geom.px(geom.xs[at] ?? 0)}
            cy={geom.py(geom.ys[at] ?? 0)}
            r="3"
            fill="var(--accent)"
            stroke="var(--canvas)"
            strokeWidth="1"
          />
        )}

        {/* axes */}
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="var(--hairline-2)" />
        <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={H - PAD.b} stroke="var(--hairline-2)" />
      </svg>
      <div className="aw-axis-labels">
        <span>CSA mm²</span>
        <span>arc length mm</span>
      </div>
      <div className="aw-readout mono">
        {`s ${(geom.xs[at] ?? 0).toFixed(1)} mm · CSA ${(geom.ys[at] ?? 0).toFixed(1)} mm² · ⌀ ${(
          result.min_diameter_mm[at] ?? 0
        ).toFixed(1)} × ${(result.max_diameter_mm[at] ?? 0).toFixed(1)} mm${
          result.sample_k?.[at] !== undefined ? ` · slice ${result.sample_k[at] + 1}` : ''
        }`}
      </div>
      <div className="aw-chart-hint">
        {canDrag
          ? 'Click the chart to move the MPR views to that level · drag across a normal segment to make it the reference.'
          : 'Click the chart to move the MPR views to that level.'}
      </div>
    </div>
  );
}

/* ---------------- stepper ---------------- */

type StepState = 'todo' | 'on' | 'done';

function Stepper() {
  const phase = useAirwayStore((s) => s.phase);
  const picking = useAirwayStore((s) => s.picking);
  const seed = useAirwayStore((s) => s.seedIjk);
  const glottis = useAirwayStore((s) => s.glottisSlice);
  const refRange = useAirwayStore((s) => s.refRangeK);
  const refPending = useAirwayStore((s) => s.refPending);

  const optional = (set: boolean, pick: boolean): StepState => (pick ? 'on' : set ? 'done' : 'todo');
  const steps: Array<{ title: string; sub: string; state: StepState }> = [
    {
      title: 'Click inside the trachea',
      sub:
        seed !== null
          ? `seed i ${seed[0]} · j ${seed[1]} · k ${seed[2]}`
          : 'One click in the axial, sagittal or coronal view, inside the dark lumen.',
      state: phase === 'seed' ? 'on' : seed !== null ? 'done' : 'todo',
    },
    {
      title: 'Mark the true vocal folds',
      sub:
        glottis !== null
          ? `glottis at slice ${glottis + 1}`
          : 'Optional — gives the distance from the glottis to the narrowest point and lets the grade stop there.',
      state: optional(glottis !== null, picking === 'glottis'),
    },
    {
      title: 'Bracket a normal segment',
      sub:
        picking === 'ref' && refPending !== null
          ? `first end at slice ${refPending + 1} — now click the other end`
          : refRange !== null
            ? `reference ${rangeLabel(refRange)} · ${refRange[1] - refRange[0] + 1} slices, median CSA`
            : 'Optional — two clicks at the ends of healthy trachea, or drag on the chart after a run. Otherwise the reference is the 75th percentile below the narrowest point.',
      state: optional(refRange !== null, picking === 'ref'),
    },
  ];

  return (
    <div className="ct-steps">
      {steps.map((s, i) => (
        <div key={s.title} className={`ct-step${s.state === 'on' ? ' on' : ''}${s.state === 'done' ? ' done' : ''}`}>
          <span className="n">{s.state === 'done' ? '✓' : i + 1}</span>
          <span className="ct-t">
            {s.title}
            <span className="ct-s">{s.sub}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- the optional inputs ---------------- */

function Inputs() {
  const phase = useAirwayStore((s) => s.phase);
  const picking = useAirwayStore((s) => s.picking);
  const seed = useAirwayStore((s) => s.seedIjk);
  const glottis = useAirwayStore((s) => s.glottisSlice);
  const refRange = useAirwayStore((s) => s.refRangeK);
  const cap = useAirwayStore((s) => s.capAtGlottis);
  const uid = useAppStore((s) => s.activeSeries?.series_uid);
  const changed = useAirwayStore((s) => inputsChanged(s, uid));

  const busy = phase === 'running';

  return (
    <div className="aw-inputs">
      <div className="aw-actions">
        <button
          className={`btn${picking === 'glottis' ? ' on' : ''}`}
          disabled={busy}
          onClick={() => airway.armGlottis()}
          title="Click at the level of the true vocal folds in any view"
        >
          <MapPin size={14} strokeWidth={1.8} />
          {picking === 'glottis' ? 'Click the vocal folds…' : glottis === null ? 'Mark the vocal folds' : 'Re-mark'}
        </button>
        {glottis !== null && (
          <button className="btn" disabled={busy} onClick={() => airway.clearGlottis()}>
            Clear
          </button>
        )}
      </div>
      <div className="aw-actions">
        <button
          className={`btn${picking === 'ref' ? ' on' : ''}`}
          disabled={busy}
          onClick={() => airway.armReference()}
          title="Two clicks, one at each end of a normal segment; only the slice of each click matters"
        >
          <Brackets size={14} strokeWidth={1.8} />
          {picking === 'ref' ? 'Click both ends…' : refRange === null ? 'Bracket a normal segment' : 'Re-bracket'}
        </button>
        {refRange !== null && (
          <button className="btn" disabled={busy} onClick={() => airway.clearReference()}>
            Clear
          </button>
        )}
      </div>
      <label
        className={`aw-check${glottis === null ? ' off' : ''}`}
        title="Drop the pharynx and nose above the vocal folds so the grade describes the laryngotracheal airway"
      >
        <input
          type="checkbox"
          checked={cap}
          disabled={busy || glottis === null}
          onChange={(e) => airway.setCapAtGlottis(e.target.checked)}
        />
        <span>Grade only at and below the vocal folds</span>
      </label>
      {phase === 'setup' && (
        <div className="aw-actions">
          <button className="btn primary" disabled={!seed || picking !== null} onClick={() => void airway.run()}>
            <Play size={14} strokeWidth={1.8} />
            Run
          </button>
        </div>
      )}
      {phase === 'result' && changed && (
        <div className="aw-actions">
          <button className="btn primary" disabled={picking !== null} onClick={() => void airway.run()}>
            <RefreshCw size={14} strokeWidth={1.8} />
            Re-run with these inputs
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------- result ---------------- */

function ResultCard() {
  const result = useAirwayStore((s) => s.result);
  const added = useAirwayStore((s) => s.added);
  const structureAdded = useAirwayStore((s) => s.structureAdded);
  const phase = useAirwayStore((s) => s.phase);
  const uid = useAppStore((s) => s.activeSeries?.series_uid);
  const changed = useAirwayStore((s) => inputsChanged(s, uid));
  if (!result) return null;

  const eq = minEquivalentDiameterMm(result);
  const running = phase === 'running';
  const stale = changed && !running;

  return (
    <div className={`ct-result${running ? ' aw-stale' : ''}`}>
      <div className="ct-top">
        <div className="ct-big">
          {Math.round(result.stenosis_pct)}
          <span className="deg"> %</span>
        </div>
        {result.myer_cotton_grade && <GradeChip grade={result.myer_cotton_grade} />}
      </div>

      <div className="ct-line">area reduction at the narrowest point</div>
      <div className="ct-meta">{narrative(result)}</div>

      <dl className="ct-kv">
        <dt>Minimum CSA</dt>
        <dd>{result.min_csa_mm2.toFixed(1)} mm²</dd>
        <dt>Equivalent diameter</dt>
        <dd>{eq.toFixed(1)} mm</dd>
        <dt>Stenosis length</dt>
        <dd>{result.stenosis_length_mm.toFixed(1)} mm</dd>
        <dt>Distance from glottis</dt>
        <dd>
          {result.distance_from_glottis_mm === null
            ? '— not marked'
            : `${result.distance_from_glottis_mm.toFixed(1)} mm`}
        </dd>
        <dt>Reference CSA</dt>
        <dd>{result.csa_ref_mm2.toFixed(1)} mm²</dd>
        <dt>Reference</dt>
        <dd>{describeReference(result)}</dd>
        <dt>Profile</dt>
        <dd>{result.capped_at_glottis ? 'to the vocal folds' : 'whole airway'}</dd>
        <dt>Samples</dt>
        <dd>{result.csa_mm2.length}</dd>
      </dl>

      <CsaChart result={result} />

      {stale && (
        <div className="aw-stale-note">
          The inputs changed since this result — re-run to update the grade.
        </div>
      )}

      <div className="ct-actions">
        {stale ? (
          <button className="btn primary" onClick={() => void airway.run()} title="Run again with the new inputs">
            <RefreshCw size={14} strokeWidth={1.8} />
            Re-run
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={added || running}
            onClick={() => airway.addToMeasurements()}
            title={added ? 'Already in the measurement list' : 'Add the narrative to the Measure tab'}
          >
            <Plus size={14} strokeWidth={1.8} />
            {added ? 'Added' : 'Add to measurements'}
          </button>
        )}
        <button className="btn" disabled={running} onClick={() => airway.redo()} title="Start again from the seed">
          <CornerUpLeft size={14} strokeWidth={1.8} />
          Redo
        </button>
      </div>
      {structureAdded && (
        <div className="aw-note">The lumen is in the Structures tab and the 3D view.</div>
      )}
    </div>
  );
}

/* ---------------- the panel ---------------- */

export function AirwayPanel() {
  const phase = useAirwayStore((s) => s.phase);
  const picking = useAirwayStore((s) => s.picking);
  const hint = useAirwayStore((s) => s.hint);

  return (
    <>
      <div className="ct-card">
        <div className="ct-head">
          <Wind size={16} strokeWidth={1.5} />
          <span className="ct-name">Airway analyser</span>
          <span className="kbd">Y</span>
        </div>
        <p className="ct-desc">
          Cross-sectional area along the tracheal centreline, the narrowest point, the percentage
          reduction against a normal reference and the Myer–Cotton grade.
        </p>

        {phase === 'idle' ? (
          <button className="btn primary" onClick={() => airway.start()}>
            <Play size={14} strokeWidth={1.8} />
            Start analysis
          </button>
        ) : (
          <button className="btn" disabled={phase === 'running'} onClick={() => airway.cancel()}>
            <X size={14} strokeWidth={1.8} />
            Cancel · Esc
          </button>
        )}
      </div>

      {phase !== 'idle' && <Stepper />}

      {hint && (
        <div className="ct-hint">
          <TriangleAlert size={14} strokeWidth={1.8} className="ico" />
          <div>{hint}</div>
        </div>
      )}

      {phase === 'seed' && picking === null && (
        <div className="aw-actions">
          <button className="btn" onClick={() => airway.armSeed()}>
            <MapPin size={14} strokeWidth={1.8} />
            Pick the seed again
          </button>
        </div>
      )}

      {(phase === 'setup' || phase === 'result' || phase === 'running') && <Inputs />}

      {phase === 'running' && (
        <div className="aw-running">
          <Loader size={14} strokeWidth={1.8} className="spin" />
          Segmenting the lumen, tracking the centreline and cutting perpendicular sections — a few
          seconds.
        </div>
      )}

      <ResultCard />
    </>
  );
}
