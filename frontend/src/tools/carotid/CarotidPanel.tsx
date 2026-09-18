/**
 * The carotid encasement panel: a two-step stepper, an inline hint when the
 * inputs are on the wrong plane or slice, and the result as evidence tiles.
 *
 * Severity is shape AND colour — dot / half ring / full ring — so the grade
 * survives colour blindness and greyscale printing (DESIGN.md accessibility).
 */
import { Button, Chip, Icon, SeverityGlyph, Tile, TileRow, type Severity as UiSeverity } from '../../ui';
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

const CHIP: Record<Severity, { label: string; severity: UiSeverity; range: string }> = {
  abutment: { label: 'Abutment', severity: 'ok', range: 'under 180°' },
  partial: { label: 'Partial encasement', severity: 'caution', range: '180–270°' },
  encasement: { label: 'Encasement', severity: 'danger', range: 'over 270°' },
};

export function SeverityChip({ severity }: { severity: Severity }) {
  const c = CHIP[severity];
  return (
    <Chip severity={c.severity} title={`${c.label} — ${c.range}`}>
      {c.label}
    </Chip>
  );
}

function Stepper({ phase }: { phase: CarotidPhase }) {
  const index = phase === 'circle' ? 0 : phase === 'tumor' ? 1 : 2;
  return (
    <div className="ct-steps">
      {STEPS.map((s, i) => (
        <div key={s.phase} className={`ct-step${i === index ? ' on' : ''}${i < index ? ' done' : ''}`}>
          <span className="n">{i < index ? <Icon name="check" size={11} /> : i + 1}</span>
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
  const sev = CHIP[result.severity].severity;

  return (
    <div className="ct-result">
      <div className="ct-top">
        <span className={`ct-head-glyph sev-${sev}`}>
          <SeverityGlyph severity={sev} size={13} />
        </span>
        <span className="ct-head-line">
          {SIDE_LABEL[result.side]} · slice {result.sliceIndex + 1}
          {clock ? ` · arc ${clock}` : ' · no contact'}
        </span>
        <SeverityChip severity={result.severity} />
      </div>

      <TileRow>
        <Tile
          size="lg"
          value={Math.round(result.angleDeg)}
          unit="°"
          label="circumferential contact"
          severity={sev}
        />
        <Tile size="sm" value={result.longestArcDeg.toFixed(0)} unit="°" label="longest arc" />
        <Tile size="sm" value={(result.radiusMm * 2).toFixed(1)} unit="mm" label="lumen ⌀" />
      </TileRow>

      <dl className="ct-kv">
        <dt>Contact sectors</dt>
        <dd>{result.arcs.length}</dd>
        <dt>Contact tolerance</dt>
        <dd>{result.toleranceMm.toFixed(1)} mm</dd>
      </dl>

      <div className="ct-actions">
        <Button
          tone="primary"
          size="sm"
          icon={added ? 'check' : 'plus'}
          disabled={added}
          onClick={() => carotid.addToMeasurements()}
          title={added ? 'Already in the measurement list' : 'Add to the Measure tab'}
        >
          {added ? 'Added' : 'Add to measurements'}
        </Button>
        <Button size="sm" icon="undo" onClick={() => carotid.redo()} title="Measure again">
          Redo
        </Button>
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
          <Icon name="vessel" size={17} />
          <span className="ct-name">Carotid encasement</span>
          <kbd className="mg-kbd">C</kbd>
        </div>
        <p className="ct-desc">
          Degrees of circumferential contact between the tumour and the carotid lumen on one axial
          slice. {APP_NAME} samples the vessel wall 360 times and grades the arc.
        </p>
        {phase === 'idle' ? (
          <Button tone="primary" size="sm" icon="play" block onClick={() => carotid.start()}>
            Start measurement
          </Button>
        ) : (
          <Button size="sm" icon="close" block onClick={() => carotid.cancel()}>
            Cancel · Esc
          </Button>
        )}
      </div>

      {phase !== 'idle' && <Stepper phase={phase} />}

      {hint && (
        <div className="ct-hint">
          <Icon name="warning" size={14} className="ico" />
          <div>
            {hint}
            {phase === 'tumor' && anchorSlice !== null && (
              <Button size="sm" icon="jump" onClick={() => carotid.gotoAnchor()}>
                Go to slice {anchorSlice + 1}
              </Button>
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
