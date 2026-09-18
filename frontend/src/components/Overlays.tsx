/**
 * Everything that floats above the shell: toasts, the import dialog, the
 * command palette, the segment quick menu and the shortcut sheet.
 *
 * All five are built from `src/ui` primitives — there is no bespoke dialog or
 * list markup left in here, which is what keeps the keyboard behaviour and the
 * focus ring identical across them.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { useAppStore } from '../store/useAppStore';
import { importFolder, openSeries, refreshLibrary } from '../library';
import { pickFolder } from '../api/importClient';
import { carotid } from '../tools/carotid';
import { airway } from '../tools/airway';
import { QUICK_ADDS, armRegionGrow, quickAdd } from '../labels/structureStore';
import { RAIL_TOOLS, viewer } from '../viewer/ViewerCore';
import { SLAB_OPTIONS, WINDOW_PRESETS, volumePresetsFor } from '../viewer/presets';
import { presetsFor, normaliseModality, inferSequenceKind, SEQUENCE_LABEL } from '../viewer/modality';
import { formatDicomDate, formatPersonName } from '../api/client';
import { APP_NAME } from '../config';
import {
  Button,
  Field,
  Icon,
  Kbd,
  Modal,
  Palette,
  ToastStack,
  type IconName,
  type PaletteItem,
} from '../ui';

/* ---------------- toasts ---------------- */

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const drop = useAppStore((s) => s.dropToast);
  return <ToastStack toasts={toasts} onDismiss={drop} />;
}

/* ---------------- import dialog ---------------- */

/**
 * Two ways in that do not need a typed path — the native picker on the server
 * machine, and drag-and-drop onto the Library — plus the typed path as the
 * fallback that always works. `POST /api/import/pick-folder` does not exist
 * yet, so a 404 is reported as "this build has no picker", never as an error.
 */
export function ImportDialog() {
  const open = useAppStore((s) => s.importOpen);
  const health = useAppStore((s) => s.health);
  const set = useAppStore((s) => s.set);
  const toast = useAppStore((s) => s.toast);
  const [path, setPath] = useState('');
  const [picking, setPicking] = useState(false);
  const [pickerNote, setPickerNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setPath(health?.studies_root ?? '');
    setPickerNote(null);
    window.setTimeout(() => inputRef.current?.select(), 40);
  }, [open, health]);

  const submit = () => {
    set({ importOpen: false });
    void importFolder(path.trim());
  };

  const browse = async () => {
    setPicking(true);
    setPickerNote(null);
    try {
      const r = await pickFolder();
      if ('path' in r) {
        setPath(r.path);
        set({ importOpen: false });
        void importFolder(r.path);
      } else if ('cancelled' in r) {
        toast({ kind: 'info', title: 'Import cancelled' });
      } else {
        setPickerNote(r.message);
      }
    } finally {
      setPicking(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => set({ importOpen: false })}
      title="Import DICOM"
      sub="Files are indexed in place — only headers are read and nothing leaves this machine. Re-importing the same folder is safe."
      footer={
        <>
          <Button onClick={() => set({ importOpen: false })}>Cancel</Button>
          <Button tone="primary" icon="folderAdd" onClick={submit} disabled={!path.trim()}>
            Index folder
          </Button>
        </>
      }
    >
      <div className="imp-ways">
        <Button icon="folderAdd" busy={picking} onClick={() => void browse()} block>
          Browse folder…
        </Button>
        <span className="imp-or">or drop a folder onto the Library</span>
      </div>

      {pickerNote && (
        <div className="imp-note">
          <Icon name="info" size={13} />
          {pickerNote}
        </div>
      )}

      <div className="mg-hairline" />

      <Field
        ref={inputRef}
        block
        mono
        label="Folder path on this machine"
        value={path}
        icon="drive"
        placeholder={health?.studies_root ?? 'C:\\path\\to\\dicom'}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        hint={`Defaults to the ${APP_NAME} studies root. Sub-folders are walked recursively; non-DICOM files are skipped quietly.`}
      />
    </Modal>
  );
}

/* ---------------- command palette ---------------- */

export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const layout = useAppStore((s) => s.layout);
  const studies = useAppStore((s) => s.studies);
  const patients = useAppStore((s) => s.patients);
  const seriesByStudy = useAppStore((s) => s.seriesByStudy);
  const activeSeries = useAppStore((s) => s.activeSeries);
  const set = useAppStore((s) => s.set);

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [];
    const mpr = layout === 'mpr';
    const modality = normaliseModality(activeSeries?.modality);

    RAIL_TOOLS.forEach((t) =>
      list.push({
        id: `tool-${t.name}`,
        group: 'Tool',
        label: t.label,
        detail: t.key.toUpperCase(),
        icon: 'crosshair',
        run: () => viewer.setActiveTool(t.name),
      }),
    );

    // Window presets follow the modality: MR gets MR presets, not HU ones.
    presetsFor(modality, WINDOW_PRESETS).forEach((p) =>
      list.push({
        id: `win-${p.id}`,
        group: 'Window',
        label: p.label,
        detail: p.hint,
        icon: 'windowLevel',
        run: () => viewer.applyPreset(p.id),
      }),
    );

    if (mpr) {
      volumePresetsFor(activeSeries?.modality).forEach((p) =>
        list.push({
          id: `vol-${p.id}`,
          group: '3D preset',
          label: p.label,
          detail: p.hint,
          icon: 'volume3d',
          run: () => viewer.setVolumePreset(p.id),
        }),
      );
      SLAB_OPTIONS.forEach((p) =>
        list.push({
          id: `slab-${p.id}`,
          group: 'Slab',
          label: p.label,
          icon: 'slab',
          run: () => viewer.setSlab(p.id),
        }),
      );
      list.push(
        {
          id: 'hn-carotid',
          group: 'Head & neck',
          label: 'Carotid encasement',
          detail: 'C',
          icon: 'vessel',
          run: () => carotid.start(),
        },
        {
          id: 'hn-airway',
          group: 'Head & neck',
          label: 'Airway patency',
          detail: 'Y',
          icon: 'airway',
          run: () => airway.start(),
        },
        {
          id: 'hn-structures',
          group: 'Head & neck',
          label: 'Segment — quick menu',
          detail: 'G',
          icon: 'selection',
          run: () => set({ structuresMenuOpen: true }),
        },
      );
      QUICK_ADDS.forEach((q) =>
        list.push({
          id: `quick-${q.id}`,
          group: 'Segment',
          label: q.label,
          detail: q.hint,
          icon: 'selection',
          run: () => void quickAdd(q.id),
        }),
      );
      list.push({
        id: 'quick-grow',
        group: 'Segment',
        label: 'Region grow from click',
        icon: 'wand',
        run: () => armRegionGrow(),
      });
    }

    // UI-OVERHAUL.md §8: the palette fuzzy-matches patients and series too.
    patients.forEach((p) =>
      list.push({
        id: `patient-${p.patient_id}`,
        group: 'Patient',
        label: formatPersonName(p.name),
        detail: p.patient_id,
        keywords: `${p.name} ${p.patient_id}`,
        icon: 'user',
        run: () => {
          const first = studies.find((s) => s.patient_id === p.patient_id);
          set({ screen: 'library', expandedStudy: first?.study_uid ?? null });
        },
      }),
    );

    studies.forEach((st) =>
      list.push({
        id: `study-${st.study_uid}`,
        group: 'Study',
        label: `${formatPersonName(st.patient_name)} — ${st.description || 'Study'}`,
        detail: formatDicomDate(st.study_date),
        keywords: `${st.patient_id} ${st.accession ?? ''} ${(st.modalities ?? []).join(' ')}`,
        icon: 'study',
        run: () => set({ screen: 'library', expandedStudy: st.study_uid }),
      }),
    );

    Object.values(seriesByStudy)
      .flat()
      .forEach((s) => {
        const st = studies.find((x) => x.study_uid === s.study_uid);
        const kind = inferSequenceKind(s);
        list.push({
          id: `series-${s.series_uid}`,
          group: 'Series',
          label: `${formatPersonName(st?.patient_name)} — ${s.description || s.modality || 'series'}`,
          detail: `${s.modality ?? '??'}${kind ? ` ${SEQUENCE_LABEL[kind]}` : ''} · ${s.instance_count}`,
          keywords: `${s.modality ?? ''} ${s.description ?? ''} ${st?.patient_id ?? ''}`,
          icon: 'series',
          run: () => {
            set({ screen: 'read' });
            void openSeries(s);
          },
        });
      });

    list.push(
      { id: 'go-library', group: 'Go', label: 'Library', detail: 'Ctrl L', icon: 'library', run: () => set({ screen: 'library' }) },
      { id: 'go-read', group: 'Go', label: 'Read', icon: 'findings', run: () => set({ screen: 'read' }) },
      { id: 'go-findings', group: 'Go', label: 'Findings panel', icon: 'findings', run: () => set({ panelTab: 'findings', panelOpen: true, askOpen: false }) },
      { id: 'go-structures', group: 'Go', label: 'Structures panel', icon: 'selection', run: () => set({ panelTab: 'structures', panelOpen: true, askOpen: false }) },
      { id: 'go-report', group: 'Go', label: 'Report panel', icon: 'report', run: () => set({ panelTab: 'report', panelOpen: true, askOpen: false }) },
      { id: 'go-ask', group: 'Go', label: 'Ask Margin', icon: 'ask', run: () => set({ askOpen: true }) },
      { id: 'lay-strip', group: 'Layout', label: 'Primary + context strip', icon: 'layoutStrip', run: () => set({ grid: 'strip', maximized: null }) },
      { id: 'lay-2x2', group: 'Layout', label: 'Quad MPR + 3D', icon: 'layoutQuad', run: () => set({ grid: '2x2', maximized: null }) },
      { id: 'lay-1x1', group: 'Layout', label: 'Single viewport', icon: 'layoutSingle', run: () => set({ grid: '1x1', maximized: null }) },
      { id: 'view-reset', group: 'View', label: 'Reset all views', detail: 'R', icon: 'reset', run: () => viewer.resetViews() },
      { id: 'view-invert', group: 'View', label: 'Invert greyscale', detail: 'I', icon: 'invert', run: () => viewer.setInvert(!useAppStore.getState().invert) },
      { id: 'view-snap', group: 'View', label: 'Snapshot PNG', detail: 'K', icon: 'snapshot', run: () => window.dispatchEvent(new CustomEvent('margin:snapshot')) },
      { id: 'm-clear', group: 'Measure', label: 'Clear all measurements', icon: 'trash', run: () => viewer.clearMeasurements() },
      { id: 'lib-import', group: 'Library', label: 'Import folder…', detail: 'Ctrl O', icon: 'folderAdd', run: () => set({ importOpen: true }) },
      { id: 'lib-refresh', group: 'Library', label: 'Refresh the library', icon: 'refresh', run: () => void refreshLibrary() },
      { id: 'help-keys', group: 'Help', label: 'Keyboard shortcuts', detail: '?', icon: 'keyboard', run: () => set({ shortcutsOpen: true }) },
    );
    return list;
  }, [layout, patients, studies, seriesByStudy, activeSeries, set]);

  return (
    <Palette
      open={open}
      onClose={() => set({ paletteOpen: false })}
      items={items}
      placeholder={`Search ${APP_NAME} — tools, presets, patients, series, actions`}
    />
  );
}

/* ---------------- shortcut sheet ---------------- */

const SHORTCUTS: Array<[string, IconName, Array<[string, string]>]> = [
  [
    'Navigate',
    'crosshair',
    [
      ['Window / level', 'W'],
      ['Pan', 'P'],
      ['Zoom', 'Z'],
      ['Scroll slices', 'S'],
      ['Crosshairs', 'X'],
      ['Back to window / level', 'Esc'],
    ],
  ],
  [
    'Measure',
    'length',
    [
      ['Length', 'L'],
      ['Bidirectional', 'B'],
      ['Angle', 'A'],
      ['Ellipse ROI', 'E'],
      ['Rectangle ROI', 'T'],
      ['Freehand ROI', 'D'],
      ['Probe', 'H'],
    ],
  ],
  [
    'View',
    'layoutStrip',
    [
      ['Scroll slices', 'wheel / ↑ ↓'],
      ['Jump 10 slices', 'PgUp / PgDn'],
      ['Pan', 'right-drag'],
      ['Zoom', 'middle-drag'],
      ['Maximize viewport', 'F / dbl-click'],
      ['Primary + strip', '['],
      ['Quad layout', ']'],
      ['Cycle primary plane', 'V'],
      ['Reset views', 'R'],
      ['Invert greyscale', 'I'],
      ['Next window preset', 'Q'],
      ['Cine loop', 'Space'],
      ['Snapshot PNG', 'K'],
    ],
  ],
  [
    'Head & neck',
    'vessel',
    [
      ['Carotid encasement', 'C'],
      ['Airway patency', 'Y'],
      ['Segment quick menu', 'G'],
      ['Cancel the running tool', 'Esc'],
    ],
  ],
  [
    'Workspace',
    'command',
    [
      ['Ask Margin', 'Ctrl J'],
      ['Command palette', 'Ctrl K'],
      ['Library', 'Ctrl L'],
      ['Side panel', 'Ctrl I'],
      ['Import folder', 'Ctrl O'],
      ['Findings tab', 'Ctrl 1'],
      ['Structures tab', 'Ctrl 2'],
      ['Measure tab', 'Ctrl 3'],
      ['Report tab', 'Ctrl 4'],
      ['This sheet', '?'],
    ],
  ],
];

export function ShortcutsSheet() {
  const open = useAppStore((s) => s.shortcutsOpen);
  const set = useAppStore((s) => s.set);
  return (
    <Modal
      open={open}
      size="xl"
      onClose={() => set({ shortcutsOpen: false })}
      title="Keyboard"
      sub={`Single-key hotkeys, no modifiers — ${APP_NAME} is meant to be driven one-handed.`}
    >
      <div className="sheet-grid">
        {SHORTCUTS.map(([group, icon, rows]) => (
          <section className="sheet-col" key={group}>
            <h4>
              <Icon name={icon} size={14} />
              {group}
            </h4>
            {rows.map(([label, keys]) => (
              <div className="sheet-row" key={label}>
                <span>{label}</span>
                <span className="keys">
                  {keys.split(' ').map((k, i) => (
                    <Kbd key={i}>{k}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}

/* ---------------- structures quick menu (G) ---------------- */

export function StructuresQuickMenu() {
  const open = useAppStore((s) => s.structuresMenuOpen);
  const layout = useAppStore((s) => s.layout);
  const set = useAppStore((s) => s.set);

  const pick = (run: () => void) => {
    set({ structuresMenuOpen: false, panelTab: 'structures', panelOpen: true, askOpen: false });
    window.setTimeout(run, 0);
  };

  return (
    <Modal
      open={open && layout === 'mpr'}
      onClose={() => set({ structuresMenuOpen: false })}
      title="Segment"
      sub="Threshold presets run on the whole volume; region grow starts from one click."
    >
      <div className="quick-list">
        {QUICK_ADDS.map((q) => (
          <button key={q.id} type="button" className="quick-item" onClick={() => pick(() => void quickAdd(q.id))}>
            <span className="qi-sw" style={{ background: `rgb(${q.color.join(',')})` }} />
            <span className="qi-main">{q.label}</span>
            <span className="qi-sub mono">{q.hint}</span>
          </button>
        ))}
        <button type="button" className="quick-item" onClick={() => pick(() => armRegionGrow())}>
          <Icon name="wand" size={14} />
          <span className="qi-main">Region grow from click</span>
          <span className="qi-sub">then click inside the structure</span>
        </button>
      </div>
    </Modal>
  );
}
