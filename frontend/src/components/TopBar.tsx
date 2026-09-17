import { Keyboard, PanelRightClose, PanelRightOpen, Search } from 'lucide-react';
import { useAppStore, type Screen } from '../store/useAppStore';
import { formatDicomDate, formatPersonName } from '../api/client';
import { APP_NAME } from '../config';
import { BrandMark } from './ui';

const SCREENS: Array<{ id: Screen | 'plan' | 'compare' | 'report'; label: string; ready: boolean }> = [
  { id: 'library', label: 'Library', ready: true },
  { id: 'view', label: 'View', ready: true },
  { id: 'plan', label: 'Plan', ready: false },
  { id: 'compare', label: 'Compare', ready: false },
  { id: 'report', label: 'Report', ready: false },
];

export function TopBar() {
  const screen = useAppStore((s) => s.screen);
  const study = useAppStore((s) => s.activeStudy);
  const series = useAppStore((s) => s.activeSeries);
  const patients = useAppStore((s) => s.patients);
  const panelOpen = useAppStore((s) => s.panelOpen);
  const layout = useAppStore((s) => s.layout);
  const set = useAppStore((s) => s.set);

  const patient = study ? patients.find((p) => p.patient_id === study.patient_id) : undefined;
  const age = (() => {
    if (!patient?.birth_date || !study?.study_date) return null;
    const b = patient.birth_date.replace(/[^0-9]/g, '');
    const d = study.study_date.replace(/[^0-9]/g, '');
    if (b.length !== 8 || d.length !== 8) return null;
    let years = Number(d.slice(0, 4)) - Number(b.slice(0, 4));
    if (d.slice(4) < b.slice(4)) years -= 1;
    return years > 0 && years < 130 ? years : null;
  })();

  return (
    <header className="topbar">
      <div className="brand">
        <BrandMark />
        <span className="brand-name">{APP_NAME}</span>
      </div>

      <div className="vrule" />

      {study || series ? (
        <div className="banner" title={series?.description ?? ''}>
          <strong>{formatPersonName(study?.patient_name)}</strong>
          <span className="sep">·</span>
          <span className="mono">{study?.patient_id ?? '—'}</span>
          {(age !== null || patient?.sex) && (
            <>
              <span className="sep">·</span>
              <span className="mono">
                {age !== null ? `${age}` : ''}
                {patient?.sex ? ` ${patient.sex}` : ''}
              </span>
            </>
          )}
          <span className="sep">·</span>
          <span>{study?.description || series?.description || 'Study'}</span>
          <span className="sep">·</span>
          <span className="mono">{formatDicomDate(study?.study_date)}</span>
        </div>
      ) : (
        <div className="banner idle">No study open</div>
      )}

      <nav className="nav">
        {SCREENS.map((s) => (
          <button
            key={s.id}
            className={screen === s.id ? 'on' : ''}
            disabled={!s.ready || (s.id === 'view' && layout === 'none')}
            title={s.ready ? undefined : 'Coming in a later release'}
            onClick={() => s.ready && set({ screen: s.id as Screen })}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div className="vrule" />

      <button className="btn ghost" onClick={() => set({ paletteOpen: true })} title="Command palette">
        <Search size={14} strokeWidth={1.8} />
        <span className="mono" style={{ fontSize: 11 }}>
          Ctrl K
        </span>
      </button>
      <button className="btn ghost icon" onClick={() => set({ shortcutsOpen: true })} title="Keyboard shortcuts (?)">
        <Keyboard size={16} />
      </button>
      <button
        className="btn ghost icon"
        onClick={() => set({ panelOpen: !panelOpen })}
        title="Toggle side panel (Ctrl I)"
      >
        {panelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
      </button>
    </header>
  );
}
