import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheckBig, Info, Search, TriangleAlert, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { importFolder, openSeries } from '../library';
import { carotid } from '../tools/carotid';
import { airway } from '../tools/airway';
import { QUICK_ADDS, armRegionGrow, quickAdd } from '../labels/structureStore';
import { RAIL_TOOLS, viewer } from '../viewer/ViewerCore';
import { SLAB_OPTIONS, VOLUME_PRESETS, WINDOW_PRESETS } from '../viewer/presets';
import { APP_NAME } from '../config';
import { formatPersonName } from '../api/client';
import { Kbd } from './ui';

/* ---------------- toasts ---------------- */

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const drop = useAppStore((s) => s.dropToast);

  useEffect(() => {
    if (!toasts.length) return;
    const timers = toasts.map((t) => window.setTimeout(() => drop(t.id), t.kind === 'err' ? 9000 : 4000));
    return () => timers.forEach(window.clearTimeout);
  }, [toasts, drop]);

  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div className={`toast ${t.kind}`} key={t.id} onClick={() => drop(t.id)}>
          <span className="ico">
            {t.kind === 'ok' ? (
              <CircleCheckBig size={15} strokeWidth={1.8} />
            ) : t.kind === 'err' ? (
              <TriangleAlert size={15} strokeWidth={1.8} />
            ) : (
              <Info size={15} strokeWidth={1.8} />
            )}
          </span>
          <span className="txt">{t.title}</span>
          {t.message && <span className="sub">{t.message}</span>}
        </div>
      ))}
    </div>
  );
}

/* ---------------- import dialog ---------------- */

export function ImportDialog() {
  const open = useAppStore((s) => s.importOpen);
  const health = useAppStore((s) => s.health);
  const set = useAppStore((s) => s.set);
  const [path, setPath] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPath(health?.studies_root ?? '');
      window.setTimeout(() => inputRef.current?.select(), 40);
    }
  }, [open, health]);

  if (!open) return null;
  const submit = () => void importFolder(path.trim());

  return (
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && set({ importOpen: false })}>
      <div className="dialog" role="dialog" aria-modal>
        <div className="dialog-head">
          <div style={{ flex: 1 }}>
            <div className="dialog-title">Import a DICOM folder</div>
            <div className="dialog-sub">
              Files are indexed in place — only headers are read, nothing is copied and nothing leaves this
              machine. Re-importing the same folder is safe.
            </div>
          </div>
          <button className="btn ghost icon" onClick={() => set({ importOpen: false })}>
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
        <div className="dialog-body">
          <div className="field">
            <label htmlFor="import-path">Folder path</label>
            <input
              id="import-path"
              ref={inputRef}
              className="input"
              value={path}
              spellCheck={false}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
                if (e.key === 'Escape') set({ importOpen: false });
              }}
              placeholder={health?.studies_root ?? 'C:\\path\\to\\dicom'}
            />
            <div className="hint">
              Defaults to the {APP_NAME} studies root. Sub-folders are walked recursively; non-DICOM files
              are skipped quietly.
            </div>
          </div>
        </div>
        <div className="dialog-foot">
          <button className="btn" onClick={() => set({ importOpen: false })}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            Index folder
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- command palette ---------------- */

interface Cmd {
  id: string;
  group: string;
  label: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const layout = useAppStore((s) => s.layout);
  const studies = useAppStore((s) => s.studies);
  const seriesByStudy = useAppStore((s) => s.seriesByStudy);
  const set = useAppStore((s) => s.set);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Cmd[]>(() => {
    const list: Cmd[] = [];
    RAIL_TOOLS.forEach((t) =>
      list.push({
        id: `tool-${t.name}`,
        group: 'Tool',
        label: `${t.label}  (${t.key.toUpperCase()})`,
        run: () => viewer.setActiveTool(t.name),
      }),
    );
    WINDOW_PRESETS.forEach((p) =>
      list.push({
        id: `win-${p.id}`,
        group: 'Window',
        label: `${p.label} — ${p.hint}`,
        run: () => viewer.applyWindow(p.ww, p.wc, p.id),
      }),
    );
    if (layout === 'mpr') {
      VOLUME_PRESETS.forEach((p) =>
        list.push({
          id: `vol-${p.id}`,
          group: '3D preset',
          label: `${p.label} — ${p.hint}`,
          run: () => viewer.setVolumePreset(p.id),
        }),
      );
      SLAB_OPTIONS.forEach((p) =>
        list.push({
          id: `slab-${p.id}`,
          group: 'Slab',
          label: p.label,
          run: () => viewer.setSlab(p.id),
        }),
      );
    }
    Object.values(seriesByStudy)
      .flat()
      .forEach((s) => {
        const st = studies.find((x) => x.study_uid === s.study_uid);
        list.push({
          id: `series-${s.series_uid}`,
          group: 'Series',
          label: `${formatPersonName(st?.patient_name)} — ${s.description || s.modality || 'series'}`,
          run: () => {
            set({ screen: 'view' });
            void openSeries(s);
          },
        });
      });
    if (layout === 'mpr') {
      list.push(
        {
          id: 'hn-carotid',
          group: 'Head & neck',
          label: 'Carotid encasement  (C)',
          run: () => carotid.start(),
        },
        {
          id: 'hn-airway',
          group: 'Head & neck',
          label: 'Airway analyser  (Y)',
          run: () => airway.start(),
        },
        {
          id: 'hn-structures',
          group: 'Head & neck',
          label: 'Segment — quick menu  (G)',
          run: () => set({ structuresMenuOpen: true }),
        },
      );
      QUICK_ADDS.forEach((q) =>
        list.push({
          id: `quick-${q.id}`,
          group: 'Segment',
          label: `${q.label} — ${q.hint}`,
          run: () => void quickAdd(q.id),
        }),
      );
      list.push({
        id: 'quick-grow',
        group: 'Segment',
        label: 'Region grow from click',
        run: () => armRegionGrow(),
      });
    }
    list.push(
      { id: 'screen-library', group: 'Go', label: 'Library', run: () => set({ screen: 'library' }) },
      { id: 'screen-view', group: 'Go', label: 'Viewer', run: () => set({ screen: 'view' }) },
      { id: 'reset', group: 'View', label: 'Reset all views', run: () => viewer.resetViews() },
      { id: 'invert', group: 'View', label: 'Invert greyscale', run: () => viewer.setInvert(!useAppStore.getState().invert) },
      { id: 'clear', group: 'Measure', label: 'Clear all measurements', run: () => viewer.clearMeasurements() },
      { id: 'import', group: 'Library', label: 'Import folder…', run: () => set({ importOpen: true }) },
      { id: 'shortcuts', group: 'Help', label: 'Keyboard shortcuts', run: () => set({ shortcutsOpen: true }) },
    );
    return list;
  }, [layout, set, seriesByStudy, studies]);

  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return commands.slice(0, 40);
    return commands.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(t)).slice(0, 40);
  }, [commands, q]);

  useEffect(() => {
    if (open) {
      setQ('');
      setCursor(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);
  useEffect(() => setCursor(0), [q]);

  if (!open) return null;

  const runAt = (i: number) => {
    const c = matches[i];
    if (!c) return;
    set({ paletteOpen: false });
    window.setTimeout(() => c.run(), 0);
  };

  return (
    <div className="scrim top" onMouseDown={(e) => e.target === e.currentTarget && set({ paletteOpen: false })}>
      <div className="palette" role="dialog" aria-modal>
        <div className="palette-input">
          <Search size={17} strokeWidth={1.5} />
          <input
            ref={inputRef}
            value={q}
            placeholder={`Search ${APP_NAME} — tools, presets, series, actions`}
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, matches.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                runAt(cursor);
              } else if (e.key === 'Escape') {
                set({ paletteOpen: false });
              }
            }}
          />
        </div>
        <div className="palette-list">
          {matches.length === 0 && <div className="empty-note">Nothing matches “{q}”.</div>}
          {matches.map((c, i) => (
            <button
              key={c.id}
              className={`palette-item${i === cursor ? ' cur' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => runAt(i)}
            >
              <span className="main">{c.label}</span>
              <span className="grp">{c.group}</span>
            </button>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate
          </span>
          <span>
            <Kbd>⏎</Kbd> run
          </span>
          <span>
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---------------- shortcut sheet ---------------- */

const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
  [
    'Navigate',
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
    [
      ['Length', 'L'],
      ['Bidirectional', 'B'],
      ['Angle', 'A'],
      ['Ellipse ROI', 'E'],
      ['Rectangle ROI', 'T'],
      ['Freehand ROI', 'D'],
      ['Probe (HU)', 'H'],
    ],
  ],
  [
    'View',
    [
      ['Scroll slices', 'wheel / ↑ ↓'],
      ['Jump 10 slices', 'PgUp / PgDn'],
      ['Pan', 'right-drag'],
      ['Zoom', 'middle-drag'],
      ['Maximize viewport', 'F / double-click'],
      ['Reset views', 'R'],
      ['Invert greyscale', 'I'],
      ['Next window preset', 'Q'],
      ['Cine loop', 'Space'],
      ['Snapshot PNG', 'K'],
    ],
  ],
  [
    'Head & neck',
    [
      ['Carotid encasement', 'C'],
      ['Airway analyser', 'Y'],
      ['Segment quick menu', 'G'],
      ['Cancel the running tool', 'Esc'],
    ],
  ],
  [
    'Workspace',
    [
      ['Command palette', 'Ctrl K'],
      ['Library', 'Ctrl L'],
      ['Side panel', 'Ctrl I'],
      ['Import folder', 'Ctrl O'],
      ['This sheet', '?'],
    ],
  ],
];

export function ShortcutsSheet() {
  const open = useAppStore((s) => s.shortcutsOpen);
  const set = useAppStore((s) => s.set);
  if (!open) return null;
  return (
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && set({ shortcutsOpen: false })}>
      <div className="dialog sheet" role="dialog" aria-modal>
        <div className="dialog-head">
          <div style={{ flex: 1 }}>
            <div className="dialog-title">Keyboard</div>
            <div className="dialog-sub">
              Single-key hotkeys, no modifiers — {APP_NAME} is meant to be driven one-handed.
            </div>
          </div>
          <button className="btn ghost icon" onClick={() => set({ shortcutsOpen: false })}>
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
        <div className="sheet-grid">
          {SHORTCUTS.map(([group, rows]) => (
            <div className="sheet-col" key={group}>
              <h4>{group}</h4>
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
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- structures quick menu (G) ---------------- */

export function StructuresQuickMenu() {
  const open = useAppStore((s) => s.structuresMenuOpen);
  const layout = useAppStore((s) => s.layout);
  const set = useAppStore((s) => s.set);
  if (!open || layout !== 'mpr') return null;

  const pick = (run: () => void) => {
    set({ structuresMenuOpen: false, panelTab: 'structures', panelOpen: true });
    window.setTimeout(run, 0);
  };

  return (
    <div
      className="scrim center"
      onMouseDown={(e) => e.target === e.currentTarget && set({ structuresMenuOpen: false })}
    >
      <div className="dialog quick" role="dialog" aria-modal>
        <div className="dialog-head">
          <div style={{ flex: 1 }}>
            <div className="dialog-title">Segment</div>
            <div className="dialog-sub">
              Threshold presets run on the whole volume; region grow starts from one click.
            </div>
          </div>
          <button className="btn ghost icon" onClick={() => set({ structuresMenuOpen: false })}>
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
        <div className="quick-list">
          {QUICK_ADDS.map((q) => (
            <button key={q.id} className="palette-item" onClick={() => pick(() => void quickAdd(q.id))}>
              <span className="main">{q.label}</span>
              <span className="grp">{q.hint}</span>
            </button>
          ))}
          <button className="palette-item" onClick={() => pick(() => armRegionGrow())}>
            <span className="main">Region grow from click</span>
            <span className="grp">then click inside the structure</span>
          </button>
        </div>
      </div>
    </div>
  );
}
