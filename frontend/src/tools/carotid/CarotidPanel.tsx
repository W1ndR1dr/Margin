/**
 * The Tools-tab panel for carotid encasement: a two-step stepper, an inline
 * hint when the inputs are on the wrong plane or slice, and the result card.
 */
import { CornerUpLeft, Play, Plus, TriangleAlert, Waypoints, X } from 'lucide-react';
import { clockLabel, type Severity } from './geometry';
import { carotid, SIDE_LABEL, useCarotidStore, type CarotidPhase } from './carotidTool';
import { APP_NAME } from '../../config';
import './carotid.css';

const STEPS: Array<{ title: string; sub: string; phase: CarotidPhase }> = [
  {
    title: 'Circle the carotid lumen',
    sub: 'On the axial view, drag from the centre of the vessel out to its wall.',
    phase: 'circle',
  },
  {
    title: 'Trace the tumour',
    sub: 'Draw round the tumour margin on the same slice; release to close it.',
    phase: 'tumor',
  },
];

const CHIP: Record<Severity, { label: string; color: string; tint: string }> = {
  abutment: { label: 'Abutment', color: 'var(--ok)', tint: 'rgba(74, 222, 128, 0.10)' },
  partial: { label: 'Partial encasement', color: 'var(--warn)', tint: 'rgba(245, 165, 36, 0.10)' },
  encasement: { label: 'Encasement', color: 'var(--danger)', tint: 'rgba(240, 85, 79, 0.10)' },
};

/** Colour plus a shape: dot, half ring, full ring (DESIGN.md accessibility). */
function SeverityGlyph({ severity }: { severity: Severity }) {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
      {severity === 'abutment' && <circle cx="6" cy="6" r="2.6" fill="currentColor" />}
      {severity === 'partial' && (
        <path d="M6 1.6a4.4 4.4 0 0 1 0 8.8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      )}
      {severity === 'encasement' && (
        <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="2.2" />
      )}
    </svg>
  );
}

export function SeverityChip({ severity }: { severity: Severity }) {
  const c = CHIP[severity];
  return (
    <span
      className="ct-sev"
      style={{ color: c.color, borderColor: c.color, background: c.tint }}
      title={`${c.label} — ${severity === 'abutment' ? 'under 180°' : severity === 'partial' ? '180–270°' : 'over 270°'}`}
    >
      <SeverityGlyph severity={severity} />
      {c.label}
    </span>
  );
}

function Stepper({ phase }: { phase: CarotidPhase }) {
  const index = phase === 'circle' ? 0 : phase === 'tumor' ? 1 : 2;
  return (
    <div className="ct-steps">
      {STEPS.map((s, i) => (
        <div key={s.phase} className={`ct-step${i === index ? ' on' : ''}${i < index ? ' done' : ''}`}>
          <span className="n">{i < index ? '✓' : i + 1}</span>
          <span className="ct-t">
            {s.title}
            <span className="ct-s">{s.sub}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function ResultCard() {
  const result = useCarotidStore((s) => s.result);
  const added = useCarotidStore((s) => s.added);
  if (!result) return null;

  const clock = clockLabel(result);
  const rounded = Math.round(result.angleDeg);

  return (
    <div className="ct-result">
      <div className="ct-top">
        <div className="ct-big">
          {rounded}
          <span className="deg">°</span>
        </div>
        <SeverityChip severity={result.severity} />
      </div>

      <div className="ct-line">contact, {SIDE_LABEL[result.side]}</div>
      <div className="ct-meta">
        slice {result.sliceIndex + 1}
        {clock ? ` · arc ${clock}` : ' · no contact'}
      </div>

      <dl className="ct-kv">
        <dt>Longest contiguous arc</dt>
        <dd>{result.longestArcDeg.toFixed(0)}°</dd>
        <dt>Contact sectors</dt>
        <dd>{result.arcs.length}</dd>
        <dt>Lumen diameter</dt>
        <dd>{(result.radiusMm * 2).toFixed(1)} mm</dd>
        <dt>Contact tolerance</dt>
        <dd>{result.toleranceMm.toFixed(1)} mm</dd>
      </dl>

      <div className="ct-actions">
        <button
          className="btn primary"
          disabled={added}
          onClick={() => carotid.addToMeasurements()}
          title={added ? 'Already in the measurement list' : 'Add to the Measure tab'}
        >
          <Plus size={14} strokeWidth={1.8} />
          {added ? 'Added' : 'Add to measurements'}
        </button>
        <button className="btn" onClick={() => carotid.redo()} title="Measure again">
          <CornerUpLeft size={14} strokeWidth={1.8} />
          Redo
        </button>
      </div>
    </div>
  );
}

export function CarotidPanel() {
  const phase = useCarotidStore((s) => s.phase);
  const hint = useCarotidStore((s) => s.hint);
  const anchorSlice = useCarotidStore((s) => s.anchorSlice);

  return (
    <>
      <div className="ct-card">
        <div className="ct-head">
          <Waypoints size={16} strokeWidth={1.5} />
          <span className="ct-name">Carotid encasement</span>
          <span className="kbd">C</span>
        </div>
        <p className="ct-desc">
          Degrees of circumferential contact between the tumour and the carotid lumen on one axial
          slice. {APP_NAME} samples the vessel wall 360 times and grades the arc.
        </p>
        {phase === 'idle' ? (
          <button className="btn primary" onClick={() => carotid.start()}>
            <Play size={14} strokeWidth={1.8} />
            Start measurement
          </button>
        ) : (
          <button className="btn" onClick={() => carotid.cancel()}>
            <X size={14} strokeWidth={1.8} />
            Cancel · Esc
          </button>
        )}
      </div>

      {phase !== 'idle' && <Stepper phase={phase} />}

      {hint && (
        <div className="ct-hint">
          <TriangleAlert size={14} strokeWidth={1.8} className="ico" />
          <div>
            {hint}
            {phase === 'tumor' && anchorSlice !== null && (
              <button className="btn" onClick={() => carotid.gotoAnchor()}>
                Go to slice {anchorSlice + 1}
              </button>
            )}
          </div>
        </div>
      )}

      <ResultCard />

      {phase === 'idle' && (
        <div className="ct-legend">
          <SeverityChip severity="abutment" />
          <SeverityChip severity="partial" />
          <SeverityChip severity="encasement" />
        </div>
      )}
    </>
  );
}
