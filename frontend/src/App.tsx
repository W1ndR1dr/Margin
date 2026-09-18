import { useCallback, useEffect } from 'react';

import { useAppStore, type PanelTab, type PaneId } from './store/useAppStore';
import { checkBackend, openSeriesFromUrl } from './library';
import { RAIL_TOOLS, initCornerstone, viewer } from './viewer/ViewerCore';
import { presetsFor, normaliseModality } from './viewer/modality';
import { carotid } from './tools/carotid';
import { airway } from './tools/airway';
import { AskDrawer } from './tools/ask';
import { WINDOW_PRESETS } from './viewer/presets';
import { TopBar } from './components/TopBar';
import { ToolRail } from './components/ToolRail';
import { ViewportGrid } from './components/ViewportGrid';
import { Library } from './components/Library';
import { ComingSoon, SidePanel } from './components/SidePanel';
import { StatusBar } from './components/StatusBar';
import {
  CommandPalette,
  ImportDialog,
  ShortcutsSheet,
  StructuresQuickMenu,
  Toasts,
} from './components/Overlays';
import { disarmRegionGrow } from './labels';
import { formatPersonName } from './api/client';
import { APP_NAME } from './config';

/** Planes the V key cycles between as the primary view. */
const PRIMARY_CYCLE: PaneId[] = ['axial', 'sagittal', 'coronal'];

const TAB_BY_DIGIT: Record<string, PanelTab> = {
  '1': 'findings',
  '2': 'structures',
  '3': 'measurements',
  '4': 'report',
};

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
}

function slug(s: string | null | undefined, fallback: string): string {
  const t = (s ?? '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return t || fallback;
}

export default function App() {
  const screen = useAppStore((s) => s.screen);
  const set = useAppStore((s) => s.set);

  /* ---- boot ---- */
  useEffect(() => {
    document.title = APP_NAME;
    void initCornerstone().catch((e: unknown) => {
      useAppStore.getState().set({
        viewerError: `Rendering engine failed to start: ${
          (e as Error)?.message ?? e
        }. WebGL2 may be unavailable.`,
      });
    });
    void checkBackend().then((up) => {
      if (up) void openSeriesFromUrl();
    });
    return () => viewer.destroy();
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (useAppStore.getState().backend !== 'up') void checkBackend();
    }, 5000);
    return () => window.clearInterval(id);
  }, []);

  /* ---- snapshot ---- */
  const snapshot = useCallback(async () => {
    const s = useAppStore.getState();
    if (s.layout === 'none') return;
    const pane = s.activePane;
    try {
      const url = await viewer.screenshot(pane);
      if (!url) throw new Error('nothing to capture');
      const date = s.activeStudy?.study_date?.replace(/[^0-9]/g, '') ?? 'nodate';
      const name = [
        APP_NAME.toLowerCase(),
        slug(formatPersonName(s.activeStudy?.patient_name), 'patient'),
        slug(s.activeSeries?.description ?? s.activeSeries?.modality, 'series'),
        date,
        pane,
      ].join('_');
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      s.toast({ kind: 'ok', title: 'Snapshot saved', message: `${name}.png` });
    } catch (e) {
      s.toast({ kind: 'err', title: 'Snapshot failed', message: (e as Error)?.message });
    }
  }, []);

  // The palette's "Snapshot PNG" command reaches the same code path.
  useEffect(() => {
    const h = () => void snapshot();
    window.addEventListener('margin:snapshot', h);
    return () => window.removeEventListener('margin:snapshot', h);
  }, [snapshot]);

  /* ---- keyboard ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useAppStore.getState();
      if (isTyping(e.target)) return;

      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'k') {
          e.preventDefault();
          set({ paletteOpen: !s.paletteOpen });
        } else if (k === 'j') {
          e.preventDefault();
          set({ askOpen: !s.askOpen });
        } else if (k === 'l') {
          e.preventDefault();
          set({ screen: s.screen === 'library' ? 'read' : 'library' });
        } else if (k === 'i') {
          e.preventDefault();
          set({ panelOpen: !s.panelOpen });
        } else if (k === 'o') {
          e.preventDefault();
          set({ importOpen: true });
        } else if (TAB_BY_DIGIT[k]) {
          e.preventDefault();
          set({ panelTab: TAB_BY_DIGIT[k], panelOpen: true, askOpen: false });
        }
        return;
      }

      if (e.key === 'Escape') {
        if (s.paletteOpen || s.shortcutsOpen || s.importOpen || s.structuresMenuOpen) {
          set({
            paletteOpen: false,
            shortcutsOpen: false,
            importOpen: false,
            structuresMenuOpen: false,
          });
        } else if (s.askOpen) {
          set({ askOpen: false });
        } else if (airway.cancel() || carotid.cancel()) {
          // a head-and-neck tool was running; it put the viewer back itself
        } else if (s.layout !== 'none') {
          disarmRegionGrow();
          viewer.setActiveTool('WindowLevel');
        }
        return;
      }
      if (s.paletteOpen || s.shortcutsOpen || s.importOpen || s.structuresMenuOpen) return;

      if (e.key === '?') {
        set({ shortcutsOpen: true });
        return;
      }
      if (s.screen !== 'read' || s.layout === 'none') return;

      const key = e.key.toLowerCase();

      // digits select rail tools in rail order (CONTRACT.md)
      if (/^[1-9]$/.test(key)) {
        const t = RAIL_TOOLS[Number(key) - 1];
        if (t && !(t.mprOnly && s.layout !== 'mpr')) {
          e.preventDefault();
          viewer.setActiveTool(t.name);
        }
        return;
      }

      const tool = RAIL_TOOLS.find((t) => t.key === key);
      if (tool && !(tool.mprOnly && s.layout !== 'mpr')) {
        e.preventDefault();
        viewer.setActiveTool(tool.name);
        return;
      }

      switch (key) {
        case 'c':
          e.preventDefault();
          carotid.start();
          return;
        case 'y':
          e.preventDefault();
          airway.start();
          return;
        case 'g':
          e.preventDefault();
          if (s.layout === 'mpr') set({ structuresMenuOpen: true });
          return;
        case 'f':
          e.preventDefault();
          set({ maximized: s.maximized === s.activePane ? null : s.activePane });
          return;
        case 'v': {
          // Cycle which plane is the big one — the fastest way to change what
          // you are reading without leaving the keyboard.
          e.preventDefault();
          if (s.layout !== 'mpr') return;
          const i = PRIMARY_CYCLE.indexOf(s.primaryPane);
          const next = PRIMARY_CYCLE[(i + 1) % PRIMARY_CYCLE.length];
          set({ primaryPane: next, activePane: next, maximized: null });
          return;
        }
        case '[':
          e.preventDefault();
          set({ grid: 'strip', maximized: null });
          return;
        case ']':
          e.preventDefault();
          set({ grid: '2x2', maximized: null });
          return;
        case 'r':
          e.preventDefault();
          viewer.resetViews();
          return;
        case 'k':
          e.preventDefault();
          void snapshot();
          return;
        case 'i':
          e.preventDefault();
          viewer.setInvert(!s.invert);
          return;
        case 'q': {
          e.preventDefault();
          // Cycle within the presets that belong to THIS modality, so Q on an
          // MR walks T1/T2/STIR rather than bone and lung HU windows.
          const list = presetsFor(normaliseModality(s.activeSeries?.modality), WINDOW_PRESETS);
          const i = list.findIndex((p) => p.id === s.windowPresetId);
          const next = list[(i + 1) % list.length];
          // applyPreset, not applyWindow: on MR the preset is a ratio that has
          // to be re-anchored onto this volume's own intensity centre.
          viewer.applyPreset(next.id);
          s.toast({ kind: 'info', title: next.label, message: `W ${next.ww} / L ${next.wc}` });
          return;
        }
        case ' ':
          e.preventDefault();
          viewer.toggleCine(!s.cine);
          return;
        default:
          break;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        viewer.scrollPane(s.activePane, 1);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        viewer.scrollPane(s.activePane, -1);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        viewer.scrollPane(s.activePane, 10);
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        viewer.scrollPane(s.activePane, -10);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [set, snapshot]);

  const soon = screen === 'plan' || screen === 'compare' || screen === 'board';

  return (
    <div className="app">
      <TopBar />

      <div className="workbench">
        <ToolRail onScreenshot={() => void snapshot()} />

        <div className="workarea">
          {/* The viewer stays mounted so Cornerstone keeps its WebGL contexts. */}
          <div
            className="viewer-host"
            style={{ visibility: screen === 'read' ? 'visible' : 'hidden' }}
          >
            <ViewportGrid />
          </div>
          {screen === 'library' && (
            <div className="screen-over">
              <Library />
            </div>
          )}
          {soon && (
            <div className="screen-over">
              <ComingSoon which={screen} />
            </div>
          )}
        </div>

        <SidePanel />
        <AskDrawer />
      </div>

      <StatusBar />

      <Toasts />
      <ImportDialog />
      <CommandPalette />
      <StructuresQuickMenu />
      <ShortcutsSheet />
    </div>
  );
}
