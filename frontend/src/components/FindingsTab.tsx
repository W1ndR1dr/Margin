/**
 * The Findings tab — first in the right panel, and filled on open
 * (DESIGN.md v2 §2, UI-OVERHAUL.md §3).
 *
 *   "Findings rows: severity glyph, statement with the number in mono, one
 *    evidence line, slice link at right. Green rows for checked-and-normal."
 *
 * The one rule that matters here: a green row may only appear when a check
 * actually ran. `deriveFindings` enforces that with `checked`; this component
 * never paints green on its own. Absence of evidence is never rendered as
 * evidence of absence.
 */
import { useMemo, useState } from 'react';

import { useAppStore } from '../store/useAppStore';
import { viewer } from '../viewer/ViewerCore';
import { useStructureStore } from '../labels/structureStore';
import { useCarotidStore } from '../tools/carotid';
import { useAirwayStore } from '../tools/airway';
import { deriveFindings, findingsSummary, type Finding } from '../findings';
import { inferSequenceKind } from '../viewer/modality';
import { Button, Chip, Icon, SeverityGlyph, Tile, TileRow, WithTooltip, type Severity } from '../ui';

const SEV_TO_UI: Record<Finding['severity'], Severity> = {
  ok: 'ok',
  caution: 'caution',
  danger: 'danger',
  info: 'info',
};

/** Live findings, derived from every tool's store. One hook, one memo. */
export function useFindings(): Finding[] {
  const series = useAppStore((s) => s.activeSeries);
  const measurements = useAppStore((s) => s.measurements);
  const structures = useStructureStore((s) => s.items);
  const carotid = useCarotidStore((s) => s.result);
  const airwayResult = useAirwayStore((s) => s.result);
  const glottis = useAirwayStore((s) => s.glottisSlice);

  return useMemo(
    () =>
      deriveFindings({
        modality: series?.modality ?? null,
        sequenceKind: series ? inferSequenceKind(series) : null,
        carotid,
        airway: airwayResult,
        airwayGlottisMarked: glottis !== null,
        structures,
        measurements,
      }),
    [series, carotid, airwayResult, glottis, structures, measurements],
  );
}

function FindingRow({ f }: { f: Finding }) {
  const selected = useAppStore((s) => s.selectedFinding);
  const set = useAppStore((s) => s.set);
  const [open, setOpen] = useState(false);

  const isGreen = f.checked && f.severity === 'ok';
  const hasTarget = f.target !== null;

  const jump = () => {
    if (!f.target) return;
    set({ selectedFinding: f.id });
    if (f.target.world) {
      viewer.jumpToWorld([f.target.world[0], f.target.world[1], f.target.world[2]]);
    } else if (f.target.pane && typeof f.target.sliceIndex === 'number') {
      viewer.setSlice(f.target.pane, f.target.sliceIndex);
      set({ activePane: f.target.pane });
    }
  };

  const cls = [
    'fx-row',
    `sev-${f.severity}`,
    isGreen ? 'green' : '',
    selected === f.id ? 'sel' : '',
    open ? 'open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls}>
      <button
        type="button"
        className="fx-main"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={f.metrics.length ? 'Show the numbers' : undefined}
      >
        <span className="fx-glyph">
          <SeverityGlyph severity={SEV_TO_UI[f.severity]} size={12} />
        </span>
        <span className="fx-body">
          <span className="fx-statement">
            {f.statement.map((p, i) =>
              p.mono ? (
                <span className="mono num" key={i}>
                  {p.text}
                </span>
              ) : (
                <span key={i}>{p.text}</span>
              ),
            )}
          </span>
          <span className="fx-evidence">{f.evidence}</span>
        </span>
      </button>

      {hasTarget && (
        <WithTooltip label="Jump to this slice" placement="left">
          <button type="button" className="fx-jump" onClick={jump} aria-label="Jump to this finding">
            <Icon name="jump" size={14} />
            {typeof f.target?.sliceIndex === 'number' && (
              <span className="mono">{f.target.sliceIndex + 1}</span>
            )}
          </button>
        </WithTooltip>
      )}

      {open && (
        <div className="fx-detail">
          {f.metrics.length > 0 && (
            <TileRow>
              {f.metrics.map((m, i) => (
                <Tile
                  key={i}
                  size="sm"
                  value={m.value}
                  unit={m.unit}
                  label={m.label}
                  sub={m.sub}
                  severity={i === 0 ? SEV_TO_UI[f.severity] : undefined}
                />
              ))}
            </TileRow>
          )}
          <div className="fx-source">
            <Icon name="info" size={11} />
            {f.source}
          </div>
        </div>
      )}
    </div>
  );
}

export function FindingsTab() {
  const findings = useFindings();
  const layout = useAppStore((s) => s.layout);
  const set = useAppStore((s) => s.set);
  const [filter, setFilter] = useState<'all' | 'flagged'>('all');

  const summary = useMemo(() => findingsSummary(findings), [findings]);
  const shown = useMemo(
    () => (filter === 'flagged' ? findings.filter((f) => f.severity === 'danger' || f.severity === 'caution') : findings),
    [findings, filter],
  );

  if (layout === 'none') {
    return (
      <div className="mg-empty">
        <Icon name="findings" size={26} className="mg-empty-ico" />
        <h3>Nothing open</h3>
        <p>Open a series and Margin fills this tab with everything it already knows about the study.</p>
      </div>
    );
  }

  if (!findings.length) {
    return (
      <div className="mg-empty">
        <Icon name="findings" size={26} className="mg-empty-ico" />
        <h3>No findings yet</h3>
        <p>
          Run a tool and its result lands here as a row that jumps to its slice and marks the
          scrubber. Nothing is claimed until a check has actually run.
        </p>
        <div className="fx-cta">
          <Button size="sm" icon="vessel" onClick={() => set({ panelTab: 'structures' })}>
            Segment anatomy
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="fx-head">
        <div className="fx-counts">
          {summary.danger > 0 && (
            <Chip size="sm" severity="danger">
              {summary.danger}
            </Chip>
          )}
          {summary.caution > 0 && (
            <Chip size="sm" severity="caution">
              {summary.caution}
            </Chip>
          )}
          {summary.ok > 0 && (
            <Chip size="sm" severity="ok">
              {summary.ok}
            </Chip>
          )}
          <span className="fx-total mono">
            {summary.total} finding{summary.total === 1 ? '' : 's'}
          </span>
        </div>
        {summary.danger + summary.caution > 0 && (
          <button
            type="button"
            className={`fx-filter${filter === 'flagged' ? ' on' : ''}`}
            onClick={() => setFilter((f) => (f === 'all' ? 'flagged' : 'all'))}
          >
            <Icon name="filter" size={12} />
            {filter === 'flagged' ? 'Flagged only' : 'All'}
          </button>
        )}
      </div>

      <div className="fx-list">
        {shown.map((f) => (
          <FindingRow key={f.id} f={f} />
        ))}
      </div>
    </>
  );
}
