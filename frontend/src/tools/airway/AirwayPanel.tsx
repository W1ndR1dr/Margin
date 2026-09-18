/**
 * The airway panel — patency for anaesthesia planning, NOT a stenosis grade.
 *
 * ROADMAP.md item 8 (Brian, 2026-09-17: Myer–Cotton is a "parlor trick"):
 * stenosis grading is out of scope. What the anaesthetist actually needs is
 * the narrowest lumen, where it is, and how far it sits from the glottis. So
 * the hero numbers here are the minimum cross-sectional area and its
 * equivalent diameter; the reduction against the reference segment stays as a
 * secondary measurement because it is a geometric fact the user brackets
 * themselves, and no grade letter appears anywhere.
 *
 * The CSA chart survives intact: it is the one place where the shape of the
 * airway along its length is visible, and dragging on it re-brackets the
 * reference.
 */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { type AirwayResult } from '../../api/client';
import { useAppStore } from '../../store/useAppStore';
import { Button, Icon, MarginMark, Tile, TileRow, Toggle, type Severity } from '../../ui';
import { airway, inputsChanged, useAirwayStore } from './airwayTool';
import { minEquivalentDiameterMm } from './report';
import { describeReference, nearestSample, rangeLabel, sampleSpan } from './reference';
import './airway.css';

/* ------------------------------------------------------------------ */
/* patency                                                             */
/* ------------------------------------------------------------------ */

/** Anaesthesia-facing thresholds on the minimum equivalent diameter. */
const PATENT_MM = 10;
const CAUTION_MM = 6;

function patency(eqMm: number): { severity: Severity; word: string } {
  if (!Number.isFinite(eqMm)) return { severity: 'info', word: 'not measurable' };
  if (eqMm >= PATENT_MM) return { severity: 'ok', word: 'patent' };
  if (eqMm >= CAUTION_MM) return { severity: 'caution', word: 'narrowed' };
  return { severity: 'danger', word: 'critically narrow' };
}

/* ------------------------------------------------------------------ */
/* the CSA chart                                                       */
/* ------------------------------------------------------------------ */

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
    const d = xs.map((x, i) => `${i ? 'L' : 'M'}${px(x).toFixed(1)} ${py(ys[i] ?? 0).toFixed(1)}`).join(' ');
    const area =
      `M${px(xs[0] ?? 0).toFixed(1)} ${(H - PAD.b).toFixed(1)} ` +
      xs.map((x, i) => `L${px(x).toFixed(1)} ${py(ys[i] ?? 0).toFixed(1)}`).join(' ') +
      ` L${px(xs[xs.length - 1] ?? 0).toFixed(1)} ${(H - PAD.b).toFixed(1)} Z`;
    return { xs, ys, xMax, yMax, px, py, d, area };
  }, [result]);

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
    if (drag.moved && canDrag) airway.setReferenceFromSamples(drag.i0, i);
    else if (!drag.moved) airway.jumpToIndex(i);
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
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line x1={PAD.l} x2={W - PAD.r} y1={geom.py(v)} y2={geom.py(v)} stroke="var(--hairline)" strokeWidth="1" />
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

        <path d={geom.area} fill="var(--airway)" opacity="0.1" />
        <path d={geom.d} fill="none" stroke="var(--airway)" strokeWidth="1.6" strokeLinejoin="round" />

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
          ? 'Click the chart to move the views to that level · drag across a normal segment to make it the reference.'
          : 'Click the chart to move the views to that level.'}
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
          : 'One click in any view, inside the dark lumen.',
      state: phase === 'seed' ? 'on' : seed !== null ? 'done' : 'todo',
    },
    {
      title: 'Mark the true vocal folds',
      sub:
        glottis !== null
          ? `glottis at slice ${glottis + 1}`
          : 'Optional — gives the distance from the glottis to the narrowest point, which is what the anaesthetist needs.',
      state: optional(glottis !== null, picking === 'glottis'),
    },
    {
      title: 'Bracket a normal segment',
      sub:
        picking === 'ref' && refPending !== null
          ? `first end at slice ${refPending + 1} — now click the other end`
          : refRange !== null
            ? `reference ${rangeLabel(refRange)} · ${refRange[1] - refRange[0] + 1} slices, median CSA`
            : 'Optional — two clicks at the ends of healthy trachea, or drag on the chart after a run.',
      state: optional(refRange !== null, picking === 'ref'),
    },
  ];

  return (
    <div className="ct-steps">
      {steps.map((s, i) => (
        <div key={s.title} className={`ct-step${s.state === 'on' ? ' on' : ''}${s.state === 'done' ? ' done' : ''}`}>
          <span className="n">{s.state === 'done' ? <Icon name="check" size={11} /> : i + 1}</span>
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
        <Button
          size="sm"
          icon="pin"
          active={picking === 'glottis'}
          disabled={busy}
          onClick={() => airway.armGlottis()}
          title="Click at the level of the true vocal folds in any view"
        >
          {picking === 'glottis' ? 'Click the vocal folds…' : glottis === null ? 'Mark the vocal folds' : 'Re-mark'}
        </Button>
        {glottis !== null && (
          <Button size="sm" disabled={busy} onClick={() => airway.clearGlottis()}>
            Clear
          </Button>
        )}
      </div>
      <div className="aw-actions">
        <Button
          size="sm"
          icon="bracket"
          active={picking === 'ref'}
          disabled={busy}
          onClick={() => airway.armReference()}
          title="Two clicks, one at each end of a normal segment; only the slice of each click matters"
        >
          {picking === 'ref' ? 'Click both ends…' : refRange === null ? 'Bracket a normal segment' : 'Re-bracket'}
        </Button>
        {refRange !== null && (
          <Button size="sm" disabled={busy} onClick={() => airway.clearReference()}>
            Clear
          </Button>
        )}
      </div>

      <Toggle
        leading
        checked={cap}
        disabled={busy || glottis === null}
        onChange={(v) => airway.setCapAtGlottis(v)}
        label="Stop at the vocal folds"
        hint="Drops the pharynx and nose above the glottis, so the profile describes the laryngotracheal airway."
      />

      {phase === 'setup' && (
        <Button
          tone="primary"
          size="sm"
          icon="play"
          block
          disabled={!seed || picking !== null}
          onClick={() => void airway.run()}
        >
          Run
        </Button>
      )}
      {phase === 'result' && changed && (
        <Button tone="primary" size="sm" icon="refresh" block disabled={picking !== null} onClick={() => void airway.run()}>
          Re-run with these inputs
        </Button>
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
  const glottis = useAirwayStore((s) => s.glottisSlice);
  const uid = useAppStore((s) => s.activeSeries?.series_uid);
  const changed = useAirwayStore((s) => inputsChanged(s, uid));
  if (!result) return null;

  const eq = minEquivalentDiameterMm(result);
  const pat = patency(eq);
  const running = phase === 'running';
  const stale = changed && !running;
  const atSlice = result.sample_k?.[result.min_csa_index];

  return (
    <div className={`ct-result${running ? ' aw-stale' : ''}`}>
      <div className="ct-top">
        <span className="ct-head-line">
          Airway {pat.word}
          {typeof atSlice === 'number' ? ` · slice ${atSlice + 1}` : ''}
        </span>
      </div>

      <TileRow>
        <Tile
          size="lg"
          value={result.min_csa_mm2.toFixed(1)}
          unit="mm²"
          label="narrowest lumen"
          severity={pat.severity}
        />
        <Tile size="sm" value={eq.toFixed(1)} unit="mm" label="equivalent ⌀" severity={pat.severity} />
        {result.distance_from_glottis_mm !== null && glottis !== null ? (
          <Tile
            size="sm"
            value={result.distance_from_glottis_mm.toFixed(1)}
            unit="mm"
            label="below glottis"
          />
        ) : (
          <Tile size="sm" value="—" label="below glottis" sub="not marked" />
        )}
      </TileRow>

      <dl className="ct-kv">
        <dt>Narrowed length</dt>
        <dd>{result.stenosis_length_mm.toFixed(1)} mm</dd>
        <dt>Reduction vs reference</dt>
        <dd>{Math.round(result.stenosis_pct)} %</dd>
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

      <p className="aw-caveat">
        Patency for airway planning. {"Margin"} does not assign a stenosis grade — the reference
        segment is yours to choose, so a percentage is a measurement, not a classification.
      </p>

      {stale && <div className="aw-stale-note">The inputs changed since this result — re-run to update it.</div>}

      <div className="ct-actions">
        {stale ? (
          <Button tone="primary" size="sm" icon="refresh" onClick={() => void airway.run()}>
            Re-run
          </Button>
        ) : (
          <Button
            tone="primary"
            size="sm"
            icon={added ? 'check' : 'plus'}
            disabled={added || running}
            onClick={() => airway.addToMeasurements()}
          >
            {added ? 'Added' : 'Add to measurements'}
          </Button>
        )}
        <Button size="sm" icon="undo" disabled={running} onClick={() => airway.redo()}>
          Redo
        </Button>
      </div>
      {structureAdded && <div className="aw-note">The lumen is in the Structures list and the 3D view.</div>}
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
          <Icon name="airway" size={17} />
          <span className="ct-name">Airway patency</span>
          <kbd className="mg-kbd">Y</kbd>
        </div>
        <p className="ct-desc">
          Cross-sectional area along the tracheal centreline, the narrowest point and how far it sits
          from the glottis — the numbers an anaesthetist asks for before induction.
        </p>

        {phase === 'idle' ? (
          <Button tone="primary" size="sm" icon="play" block onClick={() => airway.start()}>
            Start analysis
          </Button>
        ) : (
          <Button size="sm" icon="close" block disabled={phase === 'running'} onClick={() => airway.cancel()}>
            Cancel · Esc
          </Button>
        )}
      </div>

      {phase !== 'idle' && <Stepper />}

      {hint && (
        <div className="ct-hint">
          <Icon name="warning" size={14} className="ico" />
          <div>{hint}</div>
        </div>
      )}

      {phase === 'seed' && picking === null && (
        <div className="aw-actions">
          <Button size="sm" icon="pin" onClick={() => airway.armSeed()}>
            Pick the seed again
          </Button>
        </div>
      )}

      {(phase === 'setup' || phase === 'result' || phase === 'running') && <Inputs />}

      {phase === 'running' && (
        <div className="aw-running">
          <MarginMark size={16} progress={null} />
          Segmenting the lumen, tracking the centreline and cutting perpendicular sections — a few
          seconds.
        </div>
      )}

      <ResultCard />
    </>
  );
}
