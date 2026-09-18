/**
 * The viewport stage (UI-OVERHAUL.md §3).
 *
 *   "primary viewport (the plane being read) + 236 px context strip
 *    (SAG, COR, 3D structures) with 2 px gutters. Layout switch:
 *    primary+strip (default), 2x2, 1x1."
 *
 * Why primary+strip and not a 2x2: reading happens in one plane. A 2x2 gives
 * four small images and no working view; this gives one big one and keeps the
 * other planes where the eye can still use them for orientation.
 *
 * Every pane carries the signature scrubber with findings on it, and the
 * primary pane carries the anatomy chip.
 */
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';

import { PANE_META, useAppStore, type PaneId } from '../store/useAppStore';
import { viewer } from '../viewer/ViewerCore';
import { volumePresetsFor } from '../viewer/presets';
import {
  formatIntensity,
  inferSequenceKind,
  intensityUnit,
  normaliseModality,
  SEQUENCE_LABEL,
} from '../viewer/modality';
import { formatDicomDate, formatPersonName } from '../api/client';
import { deriveFindings, scrubberMarkers } from '../findings';
import { useStructureStore } from '../labels/structureStore';
import { useCarotidStore } from '../tools/carotid';
import { useAirwayStore } from '../tools/airway';
import { Banner, Button, Icon, MarginMark, Scrubber, WithTooltip } from '../ui';
import type { ScrubberMarker } from '../ui';

const MPR_ORDER: PaneId[] = ['axial', 'sagittal', 'coronal', 'volume3d'];
const SCRUB_PANES: PaneId[] = ['axial', 'sagittal', 'coronal', 'stack'];

/* ------------------------------------------------------------------ */
/* findings -> scrubber markers                                        */
/* ------------------------------------------------------------------ */

/**
 * Derived once for the stage and handed to every pane, so four scrubbers cost
 * one derivation rather than four.
 */
function useFindingMarkers(): Partial<Record<PaneId, ScrubberMarker[]>> {
  const series = useAppStore((s) => s.activeSeries);
  const measurements = useAppStore((s) => s.measurements);
  const structures = useStructureStore((s) => s.items);
  const carotid = useCarotidStore((s) => s.result);
  const airwayResult = useAirwayStore((s) => s.result);
  const glottis = useAirwayStore((s) => s.glottisSlice);

  return useMemo(() => {
    const findings = deriveFindings({
      modality: series?.modality ?? null,
      sequenceKind: series ? inferSequenceKind(series) : null,
      carotid,
      airway: airwayResult,
      airwayGlottisMarked: glottis !== null,
      structures,
      measurements,
    });
    const byPane: Partial<Record<PaneId, ScrubberMarker[]>> = {};
    SCRUB_PANES.forEach((p) => {
      byPane[p] = scrubberMarkers(findings, p);
    });
    return byPane;
  }, [series, carotid, airwayResult, glottis, structures, measurements]);
}

/* ------------------------------------------------------------------ */
/* one viewport                                                        */
/* ------------------------------------------------------------------ */

interface PaneProps {
  id: PaneId;
  visible: boolean;
  /** The big one. Carries the anatomy chip and the full overlay set. */
  primary: boolean;
  markers: ScrubberMarker[];
}

function Pane({ id, visible, primary, markers }: PaneProps) {
  const meta = PANE_META[id];
  const activePane = useAppStore((s) => s.activePane);
  const maximized = useAppStore((s) => s.maximized);
  const grid = useAppStore((s) => s.grid);
  const pane = useAppStore((s) => s.panes[id]);
  const series = useAppStore((s) => s.activeSeries);
  const study = useAppStore((s) => s.activeStudy);
  const volumePresetId = useAppStore((s) => s.volumePresetId);
  const loading = useAppStore((s) => s.loading);
  const probe = useAppStore((s) => s.probe);
  const anatomy = useAppStore((s) => s.anatomy);
  const windowSource = useAppStore((s) => s.windowSource);
  const set = useAppStore((s) => s.set);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const compare = useAppStore((s) => s.compareSeries);
  const isActive = activePane === id;
  const is3d = id === 'volume3d';
  const linkedLabel = compare ? (compare.description || compare.modality || 'series') : null;
  const preset = volumePresetsFor(series?.modality).find((p) => p.id === volumePresetId);
  const streaming = loading.active && pane.total === 0;

  const modality = normaliseModality(series?.modality);
  const seqKind = series ? inferSequenceKind(series) : null;
  const unit = intensityUnit(modality, seqKind);

  const toggleMax = () => set({ maximized: maximized === id ? null : id, activePane: id });
  /** Clicking a strip pane promotes it to primary — the fastest plane switch. */
  const promote = () => set({ primaryPane: id, activePane: id });

  const paneClass = [
    'pane',
    isActive ? 'active' : '',
    primary ? 'primary' : '',
    visible ? '' : 'hidden',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={paneClass}
      style={{ '--plane': meta.color } as CSSProperties}
      data-pane={id}
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
        <div className="pane-skeleton">
          <MarginMark size={26} progress={loading.total > 0 ? loading.loaded / loading.total : null} />
          <div className="ps-name">{series?.description || meta.label}</div>
          <div className="ps-sub mono">
            {loading.total > 0 ? `${loading.loaded} / ${loading.total}` : loading.label}
          </div>
        </div>
      )}

      {/* top-left: who and when. Only on the primary — four copies is noise. */}
      {primary && (
        <div className="ov tl">
          <div>{formatPersonName(study?.patient_name)}</div>
          <div className="dim">
            {study?.patient_id ?? '—'} · {formatDicomDate(study?.study_date)}
          </div>
        </div>
      )}

      <div className="ov tr">
        <div className="ov-plane">{is3d && linkedLabel ? 'Linked' : meta.label}</div>
        {primary && (
          <div className="dim">
            {series?.description || series?.modality || '—'}
            {seqKind ? ` · ${SEQUENCE_LABEL[seqKind]}` : ''}
          </div>
        )}
        {!is3d && pane.total > 0 && (
          <div>
            <span className="hi">{pane.slice + 1}</span>
            <span className="dim"> / {pane.total}</span>
          </div>
        )}
        {is3d && linkedLabel && <div className="ac">{linkedLabel}</div>}
        {is3d && !linkedLabel && preset && <div className="ac">{preset.label}</div>}
      </div>

      <div className="ov bl">
        {!is3d ? (
          <>
            <div>
              W {pane.ww} <span className="dim">/</span> L {pane.wc}
              {primary && windowSource !== 'preset' && windowSource !== 'fallback' && (
                <span className="dim" title={`window from ${windowSource}`}>
                  {' '}
                  auto
                </span>
              )}
            </div>
            {primary && <div className="dim">{pane.zoom ? `${pane.zoom.toFixed(2)}×` : ''}</div>}
          </>
        ) : (
          <div className="dim">drag rotate · right pan · wheel zoom</div>
        )}
      </div>

      {/* bottom-right: the anatomy chip (UI-OVERHAUL.md §2). */}
      {primary && !is3d && (anatomy.name !== null || probe.hu !== null) ? (
        <div className="anat-chip">
          {anatomy.name !== null && (
            <>
              <span className="anat-sw" style={{ background: anatomy.color ?? 'var(--text-3)' }} />
              <span className="anat-name">{anatomy.name}</span>
            </>
          )}
          <span className="anat-hu mono">{formatIntensity(probe.hu, modality, seqKind)}</span>
          {probe.hu !== null && modality !== 'CT' && <span className="anat-unit">{unit.short}</span>}
        </div>
      ) : (
        !is3d && (
          <div className="ov br">
            <div className="dim">{meta.short}</div>
          </div>
        )
      )}

      {!is3d && (
        <>
          <span className="orient t">{meta.letters[0]}</span>
          <span className="orient b">{meta.letters[1]}</span>
          <span className="orient l">{meta.letters[2]}</span>
          <span className="orient r">{meta.letters[3]}</span>
        </>
      )}

      {!is3d && pane.total > 1 && (
        <Scrubber
          slice={pane.slice}
          total={pane.total}
          markers={markers}
          onScrub={(i) => viewer.setSlice(id, i)}
          onMarker={(fid) => {
            const m = markers.find((x) => x.id === fid);
            if (!m) return;
            set({ selectedFinding: fid, panelTab: 'findings', panelOpen: true });
            viewer.setSlice(id, m.slice);
          }}
          accent={meta.color}
        />
      )}

      <div className="pane-actions">
        {!primary && grid === 'strip' && !is3d && (
          <WithTooltip label="Read this plane" placement="left">
            <button type="button" className="pane-act" aria-label="Make primary" onClick={promote}>
              <Icon name="layoutStrip" size={12} />
            </button>
          </WithTooltip>
        )}
        <WithTooltip label={maximized === id ? 'Restore' : 'Maximize'} hotkey="F" placement="left">
          <button type="button" className="pane-act" aria-label="Maximize or restore" onClick={toggleMax}>
            <Icon name={maximized === id ? 'minimize' : 'maximize'} size={12} />
          </button>
        </WithTooltip>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the stage                                                           */
/* ------------------------------------------------------------------ */

export function ViewportGrid() {
  const layout = useAppStore((s) => s.layout);
  const grid = useAppStore((s) => s.grid);
  const primaryPane = useAppStore((s) => s.primaryPane);
  const maximized = useAppStore((s) => s.maximized);
  const series = useAppStore((s) => s.activeSeries);
  const loading = useAppStore((s) => s.loading);
  const viewerError = useAppStore((s) => s.viewerError);
  const askOpen = useAppStore((s) => s.askOpen);
  const compare = useAppStore((s) => s.compareSeries);
  const set = useAppStore((s) => s.set);
  const stageRef = useRef<HTMLDivElement>(null);
  const shownUid = useRef<string | null>(null);
  const markers = useFindingMarkers();

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

  /**
   * The linked series takes over the 3D pane. Driven from the store rather
   * than from the Library click so that closing the primary series, or the
   * user unlinking from anywhere, tears it down through one path.
   */
  useEffect(() => {
    if (layout !== 'mpr') return;
    void viewer.setLinkedSeries(compare).then((ok) => {
      if (compare && !ok) {
        useAppStore.getState().toast({
          kind: 'err',
          title: 'Could not link that series',
          message: 'It needs at least three slices sharing one orientation.',
        });
        useAppStore.getState().set({ compareSeries: null });
      }
    });
  }, [compare, layout]);

  // Any layout change resizes the WebGL canvases; one rAF is not enough
  // because the CSS grid has to settle first.
  useEffect(() => {
    const t = window.setTimeout(() => viewer.resize(), 70);
    return () => window.clearTimeout(t);
  }, [maximized, layout, grid, primaryPane, askOpen]);

  if (layout === 'none') {
    return (
      <div className="stage" ref={stageRef}>
        <div className="mg-empty stage-empty">
          <MarginMark size={44} />
          <h3>No series open</h3>
          <p>
            Open the Library and pick a series. A volumetric study opens as a primary plane with a
            context strip; thick MR opens in its acquired plane; scouts open as a stack.
          </p>
          <Button tone="primary" icon="library" onClick={() => set({ screen: 'library' })}>
            Go to the library
          </Button>
        </div>
      </div>
    );
  }

  const panes: PaneId[] = layout === 'mpr' ? MPR_ORDER : ['stack'];
  const primary: PaneId = layout === 'mpr' ? primaryPane : 'stack';
  const strip = panes.filter((p) => p !== primary);

  const effective = layout === 'stack' || maximized !== null ? '1x1' : grid;
  const visible = (p: PaneId): boolean => {
    if (maximized) return maximized === p;
    if (effective === '1x1') return p === primary;
    return true;
  };

  const pct = loading.total > 0 ? Math.round((loading.loaded / loading.total) * 100) : 0;
  const ordered: PaneId[] = effective === 'strip' ? [primary, ...strip] : panes;

  return (
    <div className="stage" ref={stageRef}>
      {loading.active && (
        <div className="progress" title={`${loading.label} ${pct}%`}>
          <i style={{ width: `${loading.total > 0 ? pct : 12}%` }} />
        </div>
      )}

      <div className={`grid g-${effective}`}>
        {ordered.map((p) => (
          <Pane
            key={p}
            id={p}
            visible={visible(p)}
            primary={effective === '2x2' ? false : p === primary}
            markers={markers[p] ?? []}
          />
        ))}
      </div>

      {viewerError && (
        <div className="err-banner">
          <Banner kind="err" icon="warningCircle">
            {viewerError}
          </Banner>
        </div>
      )}
    </div>
  );
}
