/**
 * The Structures tab: quick segmentation presets, a region grow from a click,
 * and one row per structure with its volumetrics and display controls.
 */
import {
  Box,
  Crosshair,
  Download,
  Eye,
  EyeOff,
  Layers,
  Loader,
  MoveHorizontal,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';

import { useAppStore } from '../store/useAppStore';
import { CATEGORY_LABEL, CATEGORY_ORDER, rgbToCss, type Category } from './colors';
import {
  QUICK_ADDS,
  armRegionGrow,
  cancelDistance,
  clearDistance,
  disarmRegionGrow,
  exportStl,
  jumpToDistance,
  measureDistance,
  quickAdd,
  removeStructure,
  runRegionGrow,
  setCategoryVisible,
  setOpacity,
  setVisible,
  startDistance,
  structureById,
  toggle3d,
  useStructureStore,
  type Structure,
} from './structureStore';
import { MAX_RESIDENT } from './segmentationService';
import './structures.css';

/* ---------------- quick adds ---------------- */

function QuickAdds() {
  const busy = useStructureStore((s) => s.busy);
  const armed = useStructureStore((s) => s.grow.armed);
  const layout = useAppStore((s) => s.layout);
  const disabled = layout !== 'mpr' || busy !== null;

  return (
    <div className="st-quick">
      <div className="panel-title" style={{ padding: '10px 12px 6px' }}>
        Quick add
      </div>
      <div className="st-quick-grid">
        {QUICK_ADDS.map((q) => (
          <button
            key={q.id}
            className="btn"
            disabled={disabled}
            title={q.hint}
            onClick={() => void quickAdd(q.id)}
          >
            <span className="st-sw" style={{ background: rgbToCss(q.color) }} />
            {q.label}
          </button>
        ))}
        <button
          className={`btn${armed ? ' primary' : ''}`}
          disabled={layout !== 'mpr' || busy !== null}
          title="Then click inside the structure on any MPR view"
          onClick={() => (armed ? disarmRegionGrow() : armRegionGrow())}
        >
          <Crosshair size={14} strokeWidth={1.8} />
          {armed ? 'Click a voxel · Esc' : 'Region grow from click'}
        </button>
      </div>
      {busy && (
        <div className="st-busy">
          <Loader size={13} strokeWidth={1.8} className="spin" />
          {busy}
        </div>
      )}
    </div>
  );
}

/* ---------------- region grow form ---------------- */

function GrowForm() {
  const grow = useStructureStore((s) => s.grow);
  const busy = useStructureStore((s) => s.busy);
  const set = useStructureStore((s) => s.set);
  if (!grow.armed && grow.seedIjk === null) return null;

  const centre = grow.seedHu ?? 0;
  const lower = Math.round(centre - grow.padHu);
  const upper = Math.round(centre + grow.padHu);

  return (
    <div className="st-grow">
      <div className="st-grow-head">
        <Crosshair size={14} strokeWidth={1.8} />
        <span>Region grow</span>
        <button
          className="st-icon"
          title="Close"
          onClick={() => {
            disarmRegionGrow();
            set({ grow: { padHu: 60, radiusMm: 40, seedIjk: null, seedHu: null, armed: false } });
          }}
        >
          <X size={13} strokeWidth={1.8} />
        </button>
      </div>

      {grow.seedIjk === null ? (
        <p className="st-grow-hint">
          Click inside the structure on the axial, sagittal or coronal view. The HU window is built
          around the voxel you pick.
        </p>
      ) : (
        <p className="st-grow-hint mono">
          seed i {grow.seedIjk[0]} · j {grow.seedIjk[1]} · k {grow.seedIjk[2]}
          {grow.seedHu !== null ? ` · ${Math.round(grow.seedHu)} HU` : ''}
        </p>
      )}

      <div className="st-grow-fields">
        <label>
          ± HU
          <input
            className="input"
            type="number"
            min={5}
            max={2000}
            step={5}
            value={grow.padHu}
            onChange={(e) => set({ grow: { ...grow, padHu: clamp(Number(e.target.value), 5, 2000) } })}
          />
        </label>
        <label>
          Radius mm
          <input
            className="input"
            type="number"
            min={2}
            max={200}
            step={5}
            value={grow.radiusMm}
            onChange={(e) =>
              set({ grow: { ...grow, radiusMm: clamp(Number(e.target.value), 2, 200) } })
            }
          />
        </label>
      </div>

      {grow.seedIjk !== null && (
        <>
          <div className="st-grow-window mono">
            window {lower} … {upper} HU
          </div>
          <button className="btn" disabled={busy !== null} onClick={() => void runRegionGrow()}>
            Grow again with these values
          </button>
        </>
      )}
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/* ---------------- distance ---------------- */

function DistanceCard() {
  const distance = useStructureStore((s) => s.distance);
  const from = useStructureStore((s) => s.distanceFrom);

  if (from) {
    const a = structureById(from);
    return (
      <div className="st-distance pick">
        <MoveHorizontal size={14} strokeWidth={1.8} />
        <div>
          Pick the second structure for <strong>{a?.name ?? 'this structure'}</strong>.
          <button className="btn" onClick={() => cancelDistance()}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (!distance) return null;
  const a = structureById(distance.aId);
  const b = structureById(distance.bId);
  const overlapping = distance.mm < 0;

  return (
    <div className="st-distance">
      <div className="st-d-top">
        <span className="st-d-val" style={{ color: overlapping ? 'var(--danger)' : 'var(--accent)' }}>
          {distance.mm.toFixed(1)}
          <span className="u">mm</span>
        </span>
        <button className="st-icon" title="Clear" onClick={() => clearDistance()}>
          <X size={13} strokeWidth={1.8} />
        </button>
      </div>
      <div className="st-d-sub">
        {a?.name ?? '—'} → {b?.name ?? '—'}
        {overlapping ? ' · the two overlap' : ''}
      </div>
      <button className="btn" onClick={() => jumpToDistance()}>
        Jump to the closest point
      </button>
    </div>
  );
}

/* ---------------- one structure ---------------- */

function StructureRow({ row }: { row: Structure }) {
  const distanceFrom = useStructureStore((s) => s.distanceFrom);
  const picking = distanceFrom !== null && distanceFrom !== row.id;
  const isSource = distanceFrom === row.id;

  return (
    <div className={`st-row${isSource ? ' src' : ''}${picking ? ' pick' : ''}`}>
      <div className="st-line">
        <span
          className="st-sw"
          style={{ background: rgbToCss(row.color), opacity: row.visible ? 1 : 0.35 }}
        />
        <span className="st-name" title={`${row.name} · ${row.source}`}>
          {row.name}
        </span>
        <span className="st-vol">{row.volume_ml.toFixed(row.volume_ml < 10 ? 2 : 1)} ml</span>
        <button
          className="st-icon"
          title={row.visible ? 'Hide' : row.loaded ? 'Show' : 'Reload the mask and show'}
          onClick={() => void setVisible(row.id, !row.visible)}
        >
          {row.visible ? <Eye size={14} strokeWidth={1.6} /> : <EyeOff size={14} strokeWidth={1.6} />}
        </button>
      </div>

      <div className="st-line2">
        <input
          className="st-slider"
          type="range"
          min={0}
          max={100}
          value={Math.round(row.opacity * 100)}
          title={`Opacity ${Math.round(row.opacity * 100)}%`}
          onChange={(e) => setOpacity(row.id, Number(e.target.value) / 100)}
        />
        <button
          className={`st-icon${row.in3d ? ' on' : ''}`}
          title={row.in3d ? 'Remove from the 3D view' : 'Show the surface in 3D'}
          onClick={() => void toggle3d(row.id)}
        >
          <Box size={14} strokeWidth={1.6} />
        </button>
        <button className="st-icon" title="Export STL" onClick={() => void exportStl(row.id)}>
          <Download size={14} strokeWidth={1.6} />
        </button>
        <button
          className={`st-icon${isSource ? ' on' : ''}`}
          title={picking ? 'Measure to this structure' : 'Distance to another structure…'}
          onClick={() => (picking && distanceFrom ? void measureDistance(distanceFrom, row.id) : startDistance(row.id))}
        >
          <MoveHorizontal size={14} strokeWidth={1.6} />
        </button>
        <button className="st-icon danger" title="Delete" onClick={() => void removeStructure(row.id)}>
          <Trash2 size={14} strokeWidth={1.6} />
        </button>
      </div>

      {row.busy && (
        <div className="st-row-note">
          <Loader size={12} strokeWidth={1.8} className="spin" />
          {row.busy}
        </div>
      )}
      {!row.busy && !row.loaded && (
        <div className="st-row-note warn">
          <TriangleAlert size={12} strokeWidth={1.8} />
          {row.error ?? `Unloaded — only ${MAX_RESIDENT} labelmaps stay in memory.`}
        </div>
      )}
    </div>
  );
}

/* ---------------- grouped list ---------------- */

function Group({ category, rows }: { category: Category; rows: Structure[] }) {
  const allVisible = rows.every((r) => r.visible);
  const totalMl = rows.reduce((a, r) => a + r.volume_ml, 0);
  return (
    <div className="st-group">
      <div className="st-group-head">
        <span className="nm">{CATEGORY_LABEL[category]}</span>
        <span className="ct mono">
          {rows.length} · {totalMl.toFixed(totalMl < 10 ? 2 : 1)} ml
        </span>
        <button
          className="st-icon"
          title={allVisible ? `Hide all ${CATEGORY_LABEL[category].toLowerCase()}` : 'Show all'}
          onClick={() => void setCategoryVisible(category, !allVisible)}
        >
          {allVisible ? <Eye size={14} strokeWidth={1.6} /> : <EyeOff size={14} strokeWidth={1.6} />}
        </button>
      </div>
      {rows.map((r) => (
        <StructureRow key={r.id} row={r} />
      ))}
    </div>
  );
}

export function StructuresTab() {
  const items = useStructureStore((s) => s.items);
  const layout = useAppStore((s) => s.layout);

  const groups = CATEGORY_ORDER.map((c) => ({ c, rows: items.filter((r) => r.category === c) })).filter(
    (g) => g.rows.length > 0,
  );

  return (
    <div className="side-body">
      <QuickAdds />
      <GrowForm />
      <DistanceCard />

      {items.length === 0 ? (
        <div className="empty-note">
          <Layers size={20} className="ico" />
          <strong>No structures yet</strong>
          {layout === 'mpr'
            ? 'Use a quick add above, grow a region from a click, or run the airway analyser or the AI segmentation from the Tools tab.'
            : 'Open a volumetric CT — segmentation needs the MPR layout.'}
        </div>
      ) : (
        <>
          <div className="panel-title">
            Structures <span className="mono st-count">{items.length}</span>
          </div>
          {groups.map((g) => (
            <Group key={g.c} category={g.c} rows={g.rows} />
          ))}
        </>
      )}
    </div>
  );
}
