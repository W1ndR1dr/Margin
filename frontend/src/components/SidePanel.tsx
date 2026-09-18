/**
 * The 340 px right panel (UI-OVERHAUL.md §3).
 *
 *   tabs: Findings (first) · Structures · Measure · Report
 *
 * Findings is first and default because the AI-native promise is that the
 * viewer knows the anatomy before the surgeon asks: opening a study should
 * show what Margin already found, not an empty measurement list.
 *
 * The head-and-neck tool panels no longer have a tab of their own — a running
 * tool takes over the panel it belongs to (carotid and airway publish
 * findings; segmentation publishes structures), which is one fewer place to
 * look.
 */
import { useMemo, useState } from 'react';

import { PANE_META, useAppStore, type PanelTab } from '../store/useAppStore';
import { viewer } from '../viewer/ViewerCore';
import { formatDicomDate, formatPersonName } from '../api/client';
import { CarotidPanel, useCarotidStore } from '../tools/carotid';
import { AirwayPanel, useAirwayStore } from '../tools/airway';
import { AiPanel } from '../tools/ai';
import { StructuresTab } from '../labels';
import { useStructureStore } from '../labels/structureStore';
import {
  effectiveSliceSpacing,
  inferSequenceKind,
  intensityUnit,
  normaliseModality,
  SEQUENCE_LABEL,
} from '../viewer/modality';
import { APP_NAME } from '../config';
import { Button, Chip, Icon, Tabs, type IconName, type TabDef } from '../ui';
import { FindingsTab, useFindings } from './FindingsTab';

/* ---------------- measurements ---------------- */

const M_ICON: Record<string, IconName> = {
  Length: 'length',
  Bidirectional: 'bidirectional',
  Angle: 'angle',
  Probe: 'probe',
  'Ellipse ROI': 'ellipseRoi',
  'Rectangle ROI': 'rectangleRoi',
  'Freehand ROI': 'freehandRoi',
  'Carotid contact': 'vessel',
  'Airway stenosis': 'airway',
  'Structure distance': 'ruler',
};

function MeasurementsTab() {
  const measurements = useAppStore((s) => s.measurements);
  const selected = useAppStore((s) => s.selectedMeasurement);
  const toast = useAppStore((s) => s.toast);

  const copyAll = () => {
    const text = measurements
      .map((m) => {
        const meta = PANE_META[m.paneId];
        const slice = m.sliceIndex !== null ? ` (${meta.short} slice ${m.sliceIndex + 1})` : '';
        return `${m.toolName}: ${m.value}${m.extra ? ` — ${m.extra}` : ''}${slice}`;
      })
      .join('\n');
    void navigator.clipboard
      .writeText(text)
      .then(() => toast({ kind: 'ok', title: 'Measurements copied' }))
      .catch(() => toast({ kind: 'err', title: 'Clipboard blocked by the browser' }));
  };

  if (!measurements.length) {
    return (
      <div className="side-body">
        <div className="mg-empty">
          <Icon name="length" size={24} className="mg-empty-ico" />
          <h3>No measurements yet</h3>
          <p>
            Pick Length (L), Bidirectional (B), Angle (A) or an ROI in the rail and drag on any
            viewport. Values update live and a click jumps back to the slice.
          </p>
        </div>
        <SeriesFacts />
      </div>
    );
  }

  return (
    <>
      <div className="side-body">
        {measurements.map((m) => {
          const meta = PANE_META[m.paneId];
          return (
            <div
              key={m.uid}
              className={`m-row${selected === m.uid ? ' sel' : ''}`}
              onClick={() => viewer.jumpToMeasurement(m.uid)}
              title="Jump to this measurement"
            >
              <Icon name={M_ICON[m.toolName] ?? 'length'} size={15} className="m-ico" />
              <div className="m-body">
                <div className="m-line">
                  <span className="m-name">{m.toolName}</span>
                  <span className="m-val mono">{m.value}</span>
                </div>
                <div className="m-meta mono">
                  {meta.short}
                  {m.sliceIndex !== null ? ` · slice ${m.sliceIndex + 1}` : ''}
                  {m.extra ? ` · ${m.extra}` : ''}
                </div>
              </div>
              <button
                type="button"
                className="m-del"
                aria-label="Delete measurement"
                onClick={(e) => {
                  e.stopPropagation();
                  viewer.removeMeasurement(m.uid);
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          );
        })}
        <SeriesFacts />
      </div>
      <div className="side-foot">
        <Button icon="copy" block onClick={copyAll}>
          Copy all
        </Button>
        <Button tone="danger" icon="trash" block onClick={() => viewer.clearMeasurements()}>
          Clear
        </Button>
      </div>
    </>
  );
}

/* ---------------- report ---------------- */

function ReportTab() {
  const measurements = useAppStore((s) => s.measurements);
  const series = useAppStore((s) => s.activeSeries);
  const study = useAppStore((s) => s.activeStudy);
  const toast = useAppStore((s) => s.toast);
  const findings = useFindings();

  const text = useMemo(() => {
    const lines: string[] = [];
    lines.push(`${formatPersonName(study?.patient_name)}  ·  ${study?.patient_id ?? '—'}`);
    lines.push(`${study?.description || 'Study'}  ·  ${formatDicomDate(study?.study_date)}`);
    if (series) {
      lines.push(
        `Series ${series.series_number ?? '—'}: ${series.description || series.modality || '—'} (${
          series.instance_count
        } images)`,
      );
    }
    lines.push('');
    if (findings.length) {
      lines.push('FINDINGS');
      findings.forEach((f, i) => {
        const statement = f.statement.map((p) => p.text).join('');
        lines.push(`  ${i + 1}. ${statement}`);
        if (f.evidence) lines.push(`     ${f.evidence}`);
      });
      lines.push('');
    }
    if (!measurements.length) {
      lines.push('MEASUREMENTS: none recorded.');
    } else {
      lines.push('MEASUREMENTS');
      measurements.forEach((m, i) => {
        const meta = PANE_META[m.paneId];
        const slice = m.sliceIndex !== null ? `${meta.short} slice ${m.sliceIndex + 1}` : meta.short;
        lines.push(`  ${i + 1}. ${m.toolName} — ${m.value}${m.extra ? ` (${m.extra})` : ''}  [${slice}]`);
      });
    }
    lines.push('');
    lines.push(`Generated locally by ${APP_NAME}. No data left this machine.`);
    lines.push('Imaging findings only — not a diagnosis.');
    return lines.join('\n');
  }, [findings, measurements, series, study]);

  return (
    <>
      <div className="side-body">
        <div className="mg-section">Draft findings</div>
        <pre className="report-pre">{text}</pre>
        <div className="mg-empty" style={{ padding: '10px 18px 22px' }}>
          <p>Key images, tumour board slides and NI-RADS scoring arrive in v0.6.</p>
        </div>
      </div>
      <div className="side-foot">
        <Button
          tone="primary"
          icon="copy"
          block
          onClick={() =>
            void navigator.clipboard
              .writeText(text)
              .then(() => toast({ kind: 'ok', title: 'Report copied to the clipboard' }))
              .catch(() => toast({ kind: 'err', title: 'Clipboard blocked by the browser' }))
          }
        >
          Copy as text
        </Button>
      </div>
    </>
  );
}

/* ---------------- series facts ---------------- */

function SeriesFacts() {
  const series = useAppStore((s) => s.activeSeries);
  const study = useAppStore((s) => s.activeStudy);
  const pane = useAppStore((s) => s.panes[s.activePane]);
  const [open, setOpen] = useState(false);
  if (!series) return null;

  const modality = normaliseModality(series.modality);
  const kind = inferSequenceKind(series);
  const unit = intensityUnit(modality, kind);
  const spacing = effectiveSliceSpacing(series);
  const px = series.pixel_spacing
    ? `${series.pixel_spacing[0].toFixed(2)} × ${series.pixel_spacing[1].toFixed(2)} mm`
    : '—';

  return (
    <div className="facts">
      <button type="button" className="facts-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Series details
        <Icon name={open ? 'caretDown' : 'caretRight'} size={12} />
      </button>
      {open && (
        <dl className="kv">
          <dt>Patient</dt>
          <dd>{formatPersonName(study?.patient_name)}</dd>
          <dt>Series</dt>
          <dd>
            {series.series_number !== null ? `#${series.series_number} · ` : ''}
            {series.description || '—'}
          </dd>
          <dt>Modality</dt>
          <dd>
            {series.modality ?? '—'}
            {kind ? ` · ${SEQUENCE_LABEL[kind]}` : ''}
          </dd>
          <dt>Body part</dt>
          <dd>{series.body_part || '—'}</dd>
          <dt>Matrix</dt>
          <dd>
            {series.rows ?? '?'} × {series.cols ?? '?'} × {series.instance_count}
          </dd>
          <dt>Pixel</dt>
          <dd>{px}</dd>
          <dt>Slice</dt>
          <dd>{spacing !== null ? `${spacing.toFixed(2)} mm` : '—'}</dd>
          <dt>Window</dt>
          <dd>
            W {pane.ww} / L {pane.wc}
          </dd>
          <dt>Units</dt>
          <dd>{unit.long}</dd>
          <dt>Series UID</dt>
          <dd className="tiny">{series.series_uid}</dd>
        </dl>
      )}
    </div>
  );
}

/* ---------------- structures + the tool panels ---------------- */

/**
 * Structures owns the segmentation tools. A tool that is mid-run pins its own
 * card to the top of this tab so the stepper is next to what it is producing.
 */
function StructuresPane() {
  const carotidPhase = useCarotidStore((s) => s.phase);
  const airwayPhase = useAirwayStore((s) => s.phase);
  const [toolsOpen, setToolsOpen] = useState(false);
  const busy = carotidPhase !== 'idle' || airwayPhase !== 'idle';

  return (
    <div className="side-body">
      {busy && (
        <div className="tool-live">
          {carotidPhase !== 'idle' && <CarotidPanel />}
          {airwayPhase !== 'idle' && <AirwayPanel />}
        </div>
      )}

      <StructuresTab />

      <div className="mg-hairline" />
      <button
        type="button"
        className="facts-head"
        onClick={() => setToolsOpen((v) => !v)}
        aria-expanded={toolsOpen}
      >
        Head &amp; neck tools
        <Icon name={toolsOpen ? 'caretDown' : 'caretRight'} size={12} />
      </button>
      {toolsOpen && (
        <div className="tool-stack">
          {carotidPhase === 'idle' && <CarotidPanel />}
          {airwayPhase === 'idle' && <AirwayPanel />}
          <AiPanel />
        </div>
      )}
    </div>
  );
}

/* ---------------- the panel shell ---------------- */

export function SidePanel() {
  const tab = useAppStore((s) => s.panelTab);
  const open = useAppStore((s) => s.panelOpen);
  const askOpen = useAppStore((s) => s.askOpen);
  const count = useAppStore((s) => s.measurements.length);
  const structureCount = useStructureStore((s) => s.items.length);
  const set = useAppStore((s) => s.set);
  const findings = useFindings();

  const tabs: Array<TabDef<PanelTab>> = [
    { id: 'findings', label: 'Findings', count: findings.length },
    { id: 'structures', label: 'Structures', count: structureCount },
    { id: 'measurements', label: 'Measure', count },
    { id: 'report', label: 'Report' },
  ];

  // The Ask drawer replaces the panel rather than stacking next to it.
  if (askOpen) return null;

  return (
    <aside className={`side${open ? '' : ' collapsed'}`} aria-label="Study panel">
      <Tabs variant="underline" label="Panel" value={tab} tabs={tabs} onChange={(t) => set({ panelTab: t })} />

      {tab === 'findings' && (
        <div className="side-body">
          <FindingsTab />
        </div>
      )}
      {tab === 'structures' && <StructuresPane />}
      {tab === 'measurements' && <MeasurementsTab />}
      {tab === 'report' && <ReportTab />}
    </aside>
  );
}

/* ---------------- coming-soon workspaces ---------------- */

interface SoonSpec {
  icon: IconName;
  title: string;
  line: string;
  points: string[];
}

const SOON: Record<'plan' | 'compare' | 'board', SoonSpec> = {
  plan: {
    icon: 'plan',
    title: 'Plan',
    line: 'Resection and reconstruction on the 3D anatomy Margin already segmented.',
    points: [
      'Mandible osteotomy planes, defect length and HCL class',
      'Fibula segments fitted to the arc, with wedge angles',
      'STL export for the plate pre-bend model',
    ],
  },
  compare: {
    icon: 'compare',
    title: 'Compare',
    line: 'Prior and current side by side, registered, with what changed as a list.',
    points: [
      'Rigid registration, synced scroll and window',
      'Volume delta per structure, new and resolved nodes',
      'NI-RADS entry with the linked management step',
    ],
  },
  board: {
    icon: 'board',
    title: 'Board',
    line: 'The case as it will be shown: key images, 3D snapshots, the findings table.',
    points: [
      'Key images pulled from the findings that jump to them',
      'De-identified export for the tumour board deck',
      'One-page OR summary',
    ],
  },
};

/**
 * Elegant, not a disabled grey (UI-OVERHAUL.md §3). The point is that the user
 * should be able to tell what the workspace will do and decide whether to wait
 * for it, so each one carries its actual scope rather than the word "soon".
 */
export function ComingSoon({ which }: { which: 'plan' | 'compare' | 'board' }) {
  const spec = SOON[which];
  const set = useAppStore((s) => s.set);
  return (
    <div className="soon">
      <div className="soon-card">
        <div className="soon-mark">
          <Icon name={spec.icon} size={26} />
        </div>
        <h2>{spec.title}</h2>
        <p className="soon-line">{spec.line}</p>
        <ul className="soon-points">
          {spec.points.map((p) => (
            <li key={p}>
              <Icon name="check" size={12} />
              {p}
            </li>
          ))}
        </ul>
        <div className="soon-foot">
          <Chip size="sm" severity="info">
            In build
          </Chip>
          <Button size="sm" icon="arrowLeft" onClick={() => set({ screen: 'read' })}>
            Back to Read
          </Button>
        </div>
      </div>
    </div>
  );
}
