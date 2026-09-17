import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Maximize2, Minimize2, TriangleAlert } from 'lucide-react';
import { PANE_META, useAppStore, type PaneId } from '../store/useAppStore';
import { viewer } from '../viewer/ViewerCore';
import { VOLUME_PRESETS } from '../viewer/presets';
import { formatDicomDate, formatPersonName } from '../api/client';

const MPR_ORDER: PaneId[] = ['axial', 'sagittal', 'coronal', 'volume3d'];

/* ---------------- slice scrubber ---------------- */

function Scrubber({ id, slice, total }: { id: PaneId; slice: number; total: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; index: number } | null>(null);
  const dragging = useRef(false);

  if (total <= 1) return null;

  const indexAt = (clientX: number): { index: number; x: number } => {
    const el = ref.current;
    if (!el) return { index: slice, x: 0 };
    const r = el.getBoundingClientRect();
    const t = Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
    return { index: Math.round(t * (total - 1)), x: clientX - r.left };
  };

  return (
    <div
      className="scrub"
      ref={ref}
      onPointerDown={(e) => {
        e.stopPropagation();
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        viewer.setSlice(id, indexAt(e.clientX).index);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const at = indexAt(e.clientX);
        setHover(at);
        if (dragging.current) viewer.setSlice(id, at.index);
      }}
      onPointerLeave={() => setHover(null)}
      title="Drag to scroll slices"
    >
      <div className="scrub-track">
        <div className="scrub-fill" style={{ width: `${((slice + 1) / total) * 100}%` }} />
      </div>
      {hover && (
        <span className="scrub-tip" style={{ left: hover.x }}>
          {hover.index + 1} / {total}
        </span>
      )}
    </div>
  );
}

/* ---------------- one viewport ---------------- */

function Pane({ id, visible }: { id: PaneId; visible: boolean }) {
  const meta = PANE_META[id];
  const activePane = useAppStore((s) => s.activePane);
  const maximized = useAppStore((s) => s.maximized);
  const pane = useAppStore((s) => s.panes[id]);
  const series = useAppStore((s) => s.activeSeries);
  const study = useAppStore((s) => s.activeStudy);
  const volumePresetId = useAppStore((s) => s.volumePresetId);
  const loading = useAppStore((s) => s.loading);
  const set = useAppStore((s) => s.set);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const isActive = activePane === id;
  const is3d = id === 'volume3d';
  const preset = VOLUME_PRESETS.find((p) => p.id === volumePresetId);
  const streaming = loading.active && pane.total === 0;

  const toggleMax = () => set({ maximized: maximized === id ? null : id, activePane: id });

  return (
    <div
      className={`pane${isActive ? ' active' : ''}${visible ? '' : ' hidden'}`}
      style={{ '--plane': meta.color } as CSSProperties}
      onPointerDown={() => set({ activePane: id })}
      onDoubleClick={toggleMax}
      onContextMenu={(e) => e.preventDefault()}
      onMouseMove={(e) => {
        if (is3d) return;
        const el = hostRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        viewer.probeAt(id, e.clientX - r.left, e.clientY - r.top);
      }}
      onMouseLeave={() => !is3d && viewer.clearProbe()}
    >
      <div
        className="pane-cs"
        ref={(el) => {
          hostRef.current = el;
          viewer.registerElement(id, el);
        }}
      />

      {streaming && (
        <div className="skeleton">
          <div>{series?.description || meta.label}</div>
          <div className="bar">
            <i />
          </div>
        </div>
      )}

      <div className="ov tl">
        <div>{formatPersonName(study?.patient_name)}</div>
        <div className="dim">
          {study?.patient_id ?? '—'} · {formatDicomDate(study?.study_date)}
        </div>
      </div>

      <div className="ov tr">
        <div className="ov-plane">{meta.label}</div>
        <div className="dim">{series?.description || series?.modality || '—'}</div>
        {!is3d && pane.total > 0 && (
          <div>
            <span className="hi">{pane.slice + 1}</span>
            <span className="dim"> / {pane.total}</span>
          </div>
        )}
        {is3d && preset && <div className="ac">{preset.label}</div>}
      </div>

      <div className="ov bl">
        {!is3d ? (
          <>
            <div>
              W {pane.ww} <span className="dim">/</span> L {pane.wc}
            </div>
            <div className="dim">{pane.zoom ? `${pane.zoom.toFixed(2)}×` : ''}</div>
          </>
        ) : (
          <div className="dim">drag rotate · right pan · wheel zoom</div>
        )}
      </div>

      <div className="ov br">
        <div className="dim">{meta.short}</div>
      </div>

      {!is3d && (
        <>
          <span className="orient t">{meta.letters[0]}</span>
          <span className="orient b">{meta.letters[1]}</span>
          <span className="orient l">{meta.letters[2]}</span>
          <span className="orient r">{meta.letters[3]}</span>
        </>
      )}

      {!is3d && <Scrubber id={id} slice={pane.slice} total={pane.total} />}

      <div className="pane-actions">
        <button className="pane-act" title="Maximize / restore (F)" onClick={toggleMax}>
          {maximized === id ? <Minimize2 size={12} strokeWidth={1.8} /> : <Maximize2 size={12} strokeWidth={1.8} />}
        </button>
      </div>
    </div>
  );
}

/* ---------------- grid ---------------- */

export function ViewportGrid() {
  const layout = useAppStore((s) => s.layout);
  const grid = useAppStore((s) => s.grid);
  const maximized = useAppStore((s) => s.maximized);
  const series = useAppStore((s) => s.activeSeries);
  const loading = useAppStore((s) => s.loading);
  const viewerError = useAppStore((s) => s.viewerError);
  const stageRef = useRef<HTMLDivElement>(null);
  const shownUid = useRef<string | null>(null);

  useEffect(() => {
    viewer.observeStage(stageRef.current);
    return () => viewer.observeStage(null);
  }, []);

  useEffect(() => {
    if (!series) {
      shownUid.current = null;
      return;
    }
    if (shownUid.current === series.series_uid) return;
    shownUid.current = series.series_uid;
    void viewer.display(series).catch((e: unknown) => {
      useAppStore.getState().set({
        viewerError: (e as Error)?.message ?? 'Could not display this series',
        loading: { active: false, loaded: 0, total: 0, label: '' },
      });
    });
  }, [series]);

  useEffect(() => {
    const t = window.setTimeout(() => viewer.resize(), 70);
    return () => window.clearTimeout(t);
  }, [maximized, layout, grid]);

  if (layout === 'none') {
    return (
      <div className="stage" ref={stageRef}>
        <div className="empty">
          <svg width="128" height="92" viewBox="0 0 128 92" fill="none" className="art" aria-hidden>
            <rect x="0.5" y="0.5" width="61" height="43" rx="2" stroke="currentColor" strokeOpacity=".6" />
            <rect x="66.5" y="0.5" width="61" height="43" rx="2" stroke="currentColor" strokeOpacity=".4" />
            <rect x="0.5" y="48.5" width="61" height="43" rx="2" stroke="currentColor" strokeOpacity=".4" />
            <rect x="66.5" y="48.5" width="61" height="43" rx="2" stroke="currentColor" strokeOpacity=".25" />
            <path d="M31 8v28M17 22h28" stroke="var(--accent)" strokeOpacity=".45" strokeDasharray="2 3" />
            <circle cx="31" cy="22" r="8.5" stroke="var(--accent)" strokeOpacity=".7" />
          </svg>
          <h2>No series open</h2>
          <p>
            Open the Library and pick a series. Volumetric CT opens as linked axial, sagittal and coronal
            MPR plus a 3D render; single slices and scouts open as a stack.
          </p>
          <div className="empty-actions">
            <button
              className="btn primary"
              onClick={() => useAppStore.getState().set({ screen: 'library' })}
            >
              Go to the library
            </button>
          </div>
        </div>
      </div>
    );
  }

  const panes: PaneId[] = layout === 'mpr' ? MPR_ORDER : ['stack'];
  const effectiveGrid = layout === 'stack' || maximized !== null ? '1x1' : grid;
  const visibleCount = effectiveGrid === '1x1' ? 1 : effectiveGrid === '1x2' ? 2 : 4;
  const visible = (p: PaneId, i: number) => (maximized ? maximized === p : i < visibleCount);
  const pct = loading.total > 0 ? Math.round((loading.loaded / loading.total) * 100) : 0;

  return (
    <div className="stage" ref={stageRef}>
      {loading.active && (
        <div className="progress" title={`${loading.label} ${pct}%`}>
          <i style={{ width: `${loading.total > 0 ? pct : 12}%` }} />
        </div>
      )}

      <div className={`grid q${effectiveGrid}`}>
        {panes.map((p, i) => (
          <Pane key={p} id={p} visible={visible(p, i)} />
        ))}
      </div>

      {viewerError && (
        <div className="err-banner">
          <TriangleAlert size={15} strokeWidth={1.8} />
          <span className="msg">{viewerError}</span>
        </div>
      )}
    </div>
  );
}
