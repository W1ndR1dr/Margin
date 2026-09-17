import { useCallback, useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { checkBackend, openSeriesFromUrl } from './library';
import { RAIL_TOOLS, initCornerstone, viewer } from './viewer/ViewerCore';
import { WINDOW_PRESETS } from './viewer/presets';
import { TopBar } from './components/TopBar';
import { ToolRail } from './components/ToolRail';
import { ViewportGrid } from './components/ViewportGrid';
import { Library } from './components/Library';
import { SidePanel } from './components/SidePanel';
import { StatusBar } from './components/StatusBar';
import { CommandPalette, ImportDialog, ShortcutsSheet, Toasts } from './components/Overlays';
import { formatPersonName } from './api/client';
import { APP_NAME } from './config';

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
        } else if (k === 'l') {
          e.preventDefault();
          set({ screen: s.screen === 'library' ? 'view' : 'library' });
        } else if (k === 'i') {
          e.preventDefault();
          set({ panelOpen: !s.panelOpen });
        } else if (k === 'o') {
          e.preventDefault();
          set({ importOpen: true });
        }
        return;
      }

      if (e.key === 'Escape') {
        if (s.paletteOpen || s.shortcutsOpen || s.importOpen) {
          set({ paletteOpen: false, shortcutsOpen: false, importOpen: false });
        } else if (s.layout !== 'none') {
          viewer.setActiveTool('WindowLevel');
        }
        return;
      }
      if (s.paletteOpen || s.shortcutsOpen || s.importOpen) return;

      if (e.key === '?') {
        set({ shortcutsOpen: true });
        return;
      }
      if (s.screen !== 'view' || s.layout === 'none') return;

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
        case 'f':
          e.preventDefault();
          set({ maximized: s.maximized === s.activePane ? null : s.activePane });
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
          const i = WINDOW_PRESETS.findIndex((p) => p.id === s.windowPresetId);
          const next = WINDOW_PRESETS[(i + 1) % WINDOW_PRESETS.length];
          viewer.applyWindow(next.ww, next.wc, next.id);
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

  return (
    <div className="app">
      <TopBar />

      <div className="workbench">
        <ToolRail onScreenshot={() => void snapshot()} />

        <div className="workarea">
          {/* The viewer stays mounted so Cornerstone keeps its WebGL contexts. */}
          <div style={{ position: 'absolute', inset: 0, visibility: screen === 'view' ? 'visible' : 'hidden' }}>
            <ViewportGrid />
          </div>
          {screen === 'library' && (
            <div style={{ position: 'absolute', inset: 0, background: 'var(--canvas)', zIndex: 20 }}>
              <Library />
            </div>
          )}
        </div>

        <SidePanel />
      </div>

      <StatusBar />

      <Toasts />
      <ImportDialog />
      <CommandPalette />
      <ShortcutsSheet />
    </div>
  );
}
