import { useEffect } from 'react';
import { ShieldCheck } from 'lucide-react';
import { PANE_META, useAppStore } from '../store/useAppStore';
import { checkBackend } from '../library';
import { APP_VERSION } from '../config';

/** Cheap rAF frame-rate meter; smoothed so the number does not flicker. */
function useFpsMeter() {
  const set = useAppStore((s) => s.set);
  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    let smoothed = 0;
    const tick = (now: number) => {
      frames += 1;
      if (now - last >= 500) {
        const fps = (frames * 1000) / (now - last);
        smoothed = smoothed ? smoothed * 0.6 + fps * 0.4 : fps;
        set({ fps: Math.round(smoothed) });
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [set]);
}

export function StatusBar() {
  useFpsMeter();
  const backend = useAppStore((s) => s.backend);
  const activePane = useAppStore((s) => s.activePane);
  const pane = useAppStore((s) => s.panes[s.activePane]);
  const probe = useAppStore((s) => s.probe);
  const layout = useAppStore((s) => s.layout);
  const fps = useAppStore((s) => s.fps);

  const meta = PANE_META[activePane];
  const ledColor = backend === 'up' ? 'var(--ok)' : backend === 'checking' ? 'var(--warn)' : 'var(--danger)';

  return (
    <footer className="statusbar">
      <div className="st">
        <span className="k">HU</span>
        <span className={`v${probe.hu !== null ? ' ac' : ''}`}>
          {probe.hu !== null ? Math.round(probe.hu) : '—'}
        </span>
      </div>

      <div className="st">
        <span className="v">
          {probe.lps
            ? `L ${probe.lps[0].toFixed(1)}  P ${probe.lps[1].toFixed(1)}  S ${probe.lps[2].toFixed(1)}`
            : 'L —  P —  S —'}
        </span>
      </div>

      {layout !== 'none' && (
        <div className="st">
          <span className="k">{meta.short}</span>
          <span className="v">
            {pane.total > 0 ? `${pane.slice + 1}/${pane.total}` : '—'}
          </span>
        </div>
      )}

      {layout !== 'none' && (
        <div className="st">
          <span className="v">
            W{pane.ww} L{pane.wc}
          </span>
        </div>
      )}

      {layout !== 'none' && (
        <div className="st">
          <span className="k">Zoom</span>
          <span className="v">{pane.zoom ? `${pane.zoom.toFixed(2)}×` : '—'}</span>
        </div>
      )}

      <div className="st">
        <span className="v">{fps} fps</span>
      </div>

      <span className="spacer" />

      <button
        className="st"
        onClick={() => void checkBackend(false)}
        title="Backend health — click to re-check"
        style={{ cursor: 'pointer' }}
      >
        <span className="dot" style={{ background: ledColor }} />
        <span className="k">
          {backend === 'up' ? 'index online' : backend === 'checking' ? 'connecting' : 'index offline'}
        </span>
      </button>

      <div className="st">
        <span className="v" style={{ color: 'var(--text-3)' }}>
          v{APP_VERSION}
        </span>
      </div>

      <div className="st">
        <span className="local-badge">
          <ShieldCheck size={11} strokeWidth={2} />
          Local only
        </span>
      </div>
    </footer>
  );
}
