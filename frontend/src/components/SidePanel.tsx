import { useMemo, useState } from 'react';
import {
  ChevronRight,
  Circle,
  Copy,
  MoveDiagonal,
  Pipette,
  Ruler,
  Square,
  Trash2,
  Triangle,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import { PANE_META, useAppStore, type PanelTab } from '../store/useAppStore';
import { viewer } from '../viewer/ViewerCore';
import { formatDicomDate, formatPersonName } from '../api/client';
import { CarotidPanel } from '../tools/carotid';
import { AirwayPanel } from '../tools/airway';
import { AiPanel } from '../tools/ai';
import { StructuresTab } from '../labels';
import { useStructureStore } from '../labels/structureStore';
import { APP_NAME } from '../config';

const TABS: Array<{ id: PanelTab; label: string }> = [
  { id: 'measurements', label: 'Measure' },
  { id: 'structures', label: 'Structures' },
  { id: 'tools', label: 'Tools' },
  { id: 'report', label: 'Report' },
];

const M_ICON: Record<string, LucideIcon> = {
  Length: Ruler,
  Bidirectional: MoveDiagonal,
  Angle: Triangle,
  Probe: Pipette,
  'Ellipse ROI': Circle,
  'Rectangle ROI': Square,
  'Freehand ROI': Waypoints,
};

/* ---------------- measurements ---------------- */

function MeasurementsTab() {
  const measurements = useAppStore((s) => s.measurements);
  const selected = useAppStore((s) => s.selectedMeasurement);
  const toast = useAppStore((s) => s.toast);

  if (!measurements.length) {
    return (
      <div className="side-body">
        <div className="empty-note">
          <Ruler size={20} className="ico" />
          <strong>No measurements yet</strong>
          Pick Length (L), Bidirectional (B), Angle (A) or an ROI in the rail and drag on any viewport.
          Values update live and click jumps back to the slice.
        </div>
        <SeriesFacts />
      </div>
    );
  }

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

  return (
    <>
      <div className="side-body">
        {measurements.map((m) => {
          const meta = PANE_META[m.paneId];
          const Icon = M_ICON[m.toolName] ?? Ruler;
          return (
            <div
              key={m.uid}
              className={`m-row${selected === m.uid ? ' sel' : ''}`}
              onClick={() => viewer.jumpToMeasurement(m.uid)}
              title="Jump to this measurement"
            >
              <Icon size={16} strokeWidth={1.5} className="m-ico" />
              <div className="m-body">
                <div className="m-line">
                  <span className="m-name">{m.toolName}</span>
                  <span className="m-val">{m.value}</span>
                </div>
                <div className="m-meta">
                  {meta.short}
                  {m.sliceIndex !== null ? ` · slice ${m.sliceIndex + 1}` : ''}
                  {m.extra ? ` · ${m.extra}` : ''}
                </div>
              </div>
              <button
                className="m-del"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  viewer.removeMeasurement(m.uid);
                }}
              >
                <Trash2 size={14} strokeWidth={1.5} />
              </button>
            </div>
          );
        })}
        <SeriesFacts />
      </div>
      <div className="side-foot">
        <button className="btn" onClick={copyAll}>
          <Copy size={14} strokeWidth={1.5} />
          Copy all
        </button>
        <button className="btn danger" onClick={() => viewer.clearMeasurements()}>
          <Trash2 size={14} strokeWidth={1.5} />
          Clear
        </button>
      </div>
    </>
  );
}

/* ---------------- tools (guided panel shell) ---------------- */

function ToolsTab() {
  return (
    <div className="side-body">
      <div className="panel-title">Head &amp; neck tools</div>
      <CarotidPanel />
      <AirwayPanel />
      <AiPanel />
      <div className="empty-note">
        Node level mapping and the mandible planner follow on the v0.3–v0.4 roadmap.
      </div>
    </div>
  );
}

/* ---------------- report ---------------- */

function ReportTab() {
  const measurements = useAppStore((s) => s.measurements);
  const series = useAppStore((s) => s.activeSeries);
  const study = useAppStore((s) => s.activeStudy);
  const toast = useAppStore((s) => s.toast);

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
    return lines.join('\n');
  }, [measurements, series, study]);

  return (
    <>
      <div className="side-body">
        <div className="panel-title">Draft findings</div>
        <pre className="report-pre">{text}</pre>
        <div className="empty-note" style={{ paddingTop: 4 }}>
          Key images, tumour board slides and NI-RADS scoring arrive in v0.6.
        </div>
      </div>
      <div className="side-foot">
        <button
          className="btn primary"
          onClick={() =>
            void navigator.clipboard
              .writeText(text)
              .then(() => toast({ kind: 'ok', title: 'Report copied to the clipboard' }))
              .catch(() => toast({ kind: 'err', title: 'Clipboard blocked by the browser' }))
          }
        >
          <Copy size={14} strokeWidth={1.5} />
          Copy as text
        </button>
      </div>
    </>
  );
}

/* ---------------- series facts (always available under Measure) ---------------- */

function SeriesFacts() {
  const series = useAppStore((s) => s.activeSeries);
  const study = useAppStore((s) => s.activeStudy);
  const pane = useAppStore((s) => s.panes[s.activePane]);
  const [open, setOpen] = useState(true);
  if (!series) return null;

  const px = series.pixel_spacing
    ? `${series.pixel_spacing[0].toFixed(2)} × ${series.pixel_spacing[1].toFixed(2)} mm`
    : '—';

  return (
    <div style={{ borderTop: '1px solid var(--hairline)' }}>
      <button className="facts-head" onClick={() => setOpen((v) => !v)}>
        Series details
        <ChevronRight size={12} strokeWidth={1.8} className={`chev${open ? ' open' : ''}`} />
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
          <dt>Body part</dt>
          <dd>{series.body_part || '—'}</dd>
          <dt>Matrix</dt>
          <dd>
            {series.rows ?? '?'} × {series.cols ?? '?'} × {series.instance_count}
          </dd>
          <dt>Pixel</dt>
          <dd>{px}</dd>
          <dt>Thickness</dt>
          <dd>
            {series.slice_thickness ? `${series.slice_thickness.toFixed(2)} mm` : '—'}
            {series.spacing_between_slices ? ` · gap ${series.spacing_between_slices.toFixed(2)} mm` : ''}
          </dd>
          <dt>Window</dt>
          <dd>
            W {pane.ww} / L {pane.wc}
          </dd>
          <dt>Series UID</dt>
          <dd style={{ fontSize: 10, color: 'var(--text-3)' }}>{series.series_uid}</dd>
        </dl>
      )}
    </div>
  );
}

/* ---------------- panel shell ---------------- */

export function SidePanel() {
  const tab = useAppStore((s) => s.panelTab);
  const open = useAppStore((s) => s.panelOpen);
  const count = useAppStore((s) => s.measurements.length);
  const structureCount = useStructureStore((s) => s.items.length);
  const set = useAppStore((s) => s.set);

  return (
    <aside className={`side${open ? '' : ' collapsed'}`}>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => set({ panelTab: t.id })}>
            {t.label}
            {t.id === 'measurements' && count > 0 && <span className="tab-count">{count}</span>}
            {t.id === 'structures' && structureCount > 0 && (
              <span className="tab-count">{structureCount}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'measurements' && <MeasurementsTab />}
      {tab === 'structures' && <StructuresTab />}
      {tab === 'tools' && <ToolsTab />}
      {tab === 'report' && <ReportTab />}
    </aside>
  );
}
