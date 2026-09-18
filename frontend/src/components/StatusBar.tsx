/**
 * The 26 px status bar (UI-OVERHAUL.md §3).
 *
 *   HU · LPS · structure under cursor · slice · W/L · fps ·
 *   readiness ("anatomy ready · nodal levels ready") · Local only
 *
 * The readiness cluster is the AI-native part: it says what Margin already
 * knows about this study before anyone asks, so the surgeon can tell at a
 * glance whether the anatomy under the cursor is trustworthy or absent.
 */
import { useEffect, useMemo } from 'react';

import { PANE_META, useAppStore } from '../store/useAppStore';
import { checkBackend } from '../library';
import { useStructureStore } from '../labels/structureStore';
import { formatIntensity, inferSequenceKind, intensityUnit, normaliseModality } from '../viewer/modality';
import { APP_VERSION } from '../config';
import { Icon, Pill, WithTooltip } from '../ui';

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
  const anatomy = useAppStore((s) => s.anatomy);
  const layout = useAppStore((s) => s.layout);
  const fps = useAppStore((s) => s.fps);
  const series = useAppStore((s) => s.activeSeries);
  const structures = useStructureStore((s) => s.items);

  const meta = PANE_META[activePane];
  // With nothing open the readout is still labelled HU: this is a CT-first
  // tool, and "VALUE" as a resting state reads like a bug.
  const modality = series ? normaliseModality(series.modality) : 'CT';
  const seqKind = series ? inferSequenceKind(series) : null;
  const unit = intensityUnit(modality, seqKind);

  /** "anatomy ready · nodal levels ready" — what Margin knows already. */
  const readiness = useMemo(() => {
    if (!structures.length) return null;
    const nodal = structures.filter((s) => s.category === 'nodal').length;
    const anatomyCount = structures.length - nodal;
    const parts: string[] = [];
    if (anatomyCount > 0) parts.push(`anatomy ready · ${anatomyCount}`);
    if (nodal > 0) parts.push(`nodal levels ready · ${nodal}`);
    return parts.join('  ·  ');
  }, [structures]);

  const led =
    backend === 'up' ? 'var(--ok)' : backend === 'checking' ? 'var(--warn)' : 'var(--danger)';

  return (
    <footer className="statusbar">
      <div className="st">
        <span className="k">{unit.short}</span>
        <span className={`v${probe.hu !== null ? ' ac' : ''}`}>
          {formatIntensity(probe.hu, modality, seqKind).replace(/\s*(HU|SUV|ADC)$/, '')}
        </span>
      </div>

      <div className="st">
        <span className="v">
          {probe.lps
            ? `L ${probe.lps[0].toFixed(1)}  P ${probe.lps[1].toFixed(1)}  S ${probe.lps[2].toFixed(1)}`
            : 'L —  P —  S —'}
        </span>
      </div>

      {/* structure under cursor */}
      <div className="st anat" title="Structure under the cursor">
        {anatomy.name !== null ? (
          <>
            <span className="sw" style={{ background: anatomy.color ?? 'var(--text-3)' }} />
            <span className="v name">{anatomy.name}</span>
          </>
        ) : (
          <span className="v dim">{structures.length ? 'background' : 'no structures loaded'}</span>
        )}
      </div>

      {layout !== 'none' && (
        <div className="st">
          <span className="k">{meta.short}</span>
          <span className="v">{pane.total > 0 ? `${pane.slice + 1}/${pane.total}` : '—'}</span>
        </div>
      )}

      {layout !== 'none' && (
        <div className="st">
          <span className="v">
            W{pane.ww} L{pane.wc}
          </span>
        </div>
      )}

      <div className="st">
        <span className="v">{fps} fps</span>
      </div>

      <span className="st-spacer" />

      {readiness && (
        <div className="st ready">
          <Icon name="sparkle" size={11} weight="fill" />
          <span className="v">{readiness}</span>
        </div>
      )}

      <WithTooltip label="Backend health — click to re-check" placement="above">
        <button type="button" className="st act" onClick={() => void checkBackend(false)}>
          <span className="dot" style={{ background: led }} />
          <span className="k">
            {backend === 'up' ? 'index online' : backend === 'checking' ? 'connecting' : 'index offline'}
          </span>
        </button>
      </WithTooltip>

      <div className="st">
        <span className="v dim">v{APP_VERSION}</span>
      </div>

      <div className="st">
        <Pill tone="ok" icon="shieldCheck" title="Nothing leaves this machine">
          Local only
        </Pill>
      </div>
    </footer>
  );
}
