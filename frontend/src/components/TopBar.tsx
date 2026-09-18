/**
 * The 48 px top bar (UI-OVERHAUL.md §3).
 *
 *   mark + "Margin" · patient banner · study timeline chips ·
 *   Read / Plan / Compare / Board · Ask Margin bar (⌘K)
 *
 * The timeline chips are the whole of "Compare is one click": every study this
 * patient has, oldest to newest, with the open one marked. Clicking a prior
 * opens it; there is no separate study picker to go and find.
 */
import { useMemo } from 'react';

import { useAppStore, type Screen } from '../store/useAppStore';
import { formatDicomDate, formatPersonName, type Study } from '../api/client';
import { openStudyFirstSeries } from '../library';
import { APP_NAME } from '../config';
import { Button, Chip, Icon, Kbd, MarginMark, Tabs, WithTooltip, type TabDef } from '../ui';

const WORKSPACES: Array<TabDef<Screen>> = [
  { id: 'read', label: 'Read', icon: 'findings' },
  { id: 'plan', label: 'Plan', icon: 'plan' },
  { id: 'compare', label: 'Compare', icon: 'compare' },
  { id: 'board', label: 'Board', icon: 'board' },
];

/** Age at the study date, from the two DICOM date strings. */
function ageAt(birth: string | null | undefined, study: string | null | undefined): number | null {
  if (!birth || !study) return null;
  const b = birth.replace(/[^0-9]/g, '');
  const d = study.replace(/[^0-9]/g, '');
  if (b.length !== 8 || d.length !== 8) return null;
  let years = Number(d.slice(0, 4)) - Number(b.slice(0, 4));
  if (d.slice(4) < b.slice(4)) years -= 1;
  return years > 0 && years < 130 ? years : null;
}

function StudyTimeline({ studies, current }: { studies: Study[]; current: Study | null }) {
  if (studies.length < 1) return null;
  return (
    <div className="timeline" role="group" aria-label="Studies for this patient">
      {studies.map((st, i) => {
        const on = st.study_uid === current?.study_uid;
        const last = i === studies.length - 1;
        return (
          <Chip
            key={st.study_uid}
            size="sm"
            active={on}
            onClick={on ? undefined : () => void openStudyFirstSeries(st)}
            title={`${st.description || 'Study'} · ${formatDicomDate(st.study_date)} · ${
              st.series_count
            } series`}
          >
            <span className="tl-when">{last ? 'Current' : 'Prior'}</span>
            <span className="tl-date mono">{formatDicomDate(st.study_date).slice(2)}</span>
          </Chip>
        );
      })}
    </div>
  );
}

export function TopBar() {
  const screen = useAppStore((s) => s.screen);
  const study = useAppStore((s) => s.activeStudy);
  const series = useAppStore((s) => s.activeSeries);
  const studies = useAppStore((s) => s.studies);
  const patients = useAppStore((s) => s.patients);
  const panelOpen = useAppStore((s) => s.panelOpen);
  const askOpen = useAppStore((s) => s.askOpen);
  const loading = useAppStore((s) => s.loading);
  const layout = useAppStore((s) => s.layout);
  const set = useAppStore((s) => s.set);

  const patient = study ? patients.find((p) => p.patient_id === study.patient_id) : undefined;
  const age = ageAt(patient?.birth_date, study?.study_date);

  /** Every study this patient has, oldest first — the timeline. */
  const patientStudies = useMemo(() => {
    if (!study) return [];
    return studies
      .filter((s) => s.patient_id === study.patient_id)
      .sort((a, b) => (a.study_date ?? '').localeCompare(b.study_date ?? ''));
  }, [studies, study]);

  const streaming = loading.active;
  const pct = loading.total > 0 ? loading.loaded / loading.total : null;

  return (
    <header className="topbar">
      <button
        className="brand"
        onClick={() => set({ screen: 'library' })}
        title={`${APP_NAME} library · Ctrl L`}
      >
        <MarginMark size={20} progress={streaming ? pct : undefined} />
        <span className="brand-name">{APP_NAME}</span>
      </button>

      <div className="vrule" />

      {study || series ? (
        <div className="banner">
          <span className="bn-name">{formatPersonName(study?.patient_name)}</span>
          <span className="bn-ids mono">
            {study?.patient_id ?? '—'}
            {age !== null && ` · ${age}`}
            {patient?.sex && ` ${patient.sex}`}
          </span>
          <span className="bn-desc" title={study?.description ?? series?.description ?? ''}>
            {study?.description || series?.description || 'Study'}
          </span>
          <StudyTimeline studies={patientStudies} current={study} />
        </div>
      ) : (
        <div className="banner idle">No study open</div>
      )}

      <Tabs
        variant="solid"
        label="Workspace"
        value={screen === 'library' ? 'read' : screen}
        tabs={WORKSPACES.map((w) => ({
          ...w,
          disabled: w.id === 'read' && layout === 'none',
        }))}
        onChange={(id) => set({ screen: id })}
        className="workspaces"
      />

      {/* Ask Margin bar — the AI-native front door (DESIGN.md v2 §4). */}
      <button
        className={`askbar${askOpen ? ' on' : ''}`}
        onClick={() => set({ askOpen: !askOpen })}
        title="Ask Margin about this study"
      >
        <MarginMark size={14} />
        <span className="askbar-l">Ask Margin</span>
        <Icon name="ask" size={14} />
      </button>

      <WithTooltip label="Command palette" hotkey="Ctrl K" placement="below">
        <Button
          tone="ghost"
          size="sm"
          icon="search"
          aria-label="Command palette"
          onClick={() => set({ paletteOpen: true })}
        >
          <Kbd>⌘K</Kbd>
        </Button>
      </WithTooltip>

      <WithTooltip label="Keyboard shortcuts" hotkey="?" placement="below">
        <Button
          tone="ghost"
          size="sm"
          icon="keyboard"
          iconOnly
          aria-label="Keyboard shortcuts"
          onClick={() => set({ shortcutsOpen: true })}
        />
      </WithTooltip>

      <WithTooltip label={panelOpen ? 'Hide panel' : 'Show panel'} hotkey="Ctrl I" placement="below">
        <Button
          tone="ghost"
          size="sm"
          icon="panelRight"
          iconOnly
          active={panelOpen}
          aria-label="Toggle side panel"
          onClick={() => set({ panelOpen: !panelOpen })}
        />
      </WithTooltip>
    </header>
  );
}
