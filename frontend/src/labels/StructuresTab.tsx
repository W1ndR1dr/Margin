/**
 * The Structures tab: quick segmentation presets, a region grow from a click,
 * and one row per structure with its volumetrics and display controls.
 *
 * The row whose structure is under the cursor glows (UI-OVERHAUL.md §2): its
 * hairline turns accent, so "what am I pointing at" is answered in two places
 * at once — the viewport chip and this list.
 */
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
import { Button, Chip, Icon, MarginMark, Slider, Tile, TileRow, WithTooltip } from '../ui';
import './structures.css';

/* ---------------- quick adds ---------------- */

function QuickAdds() {
  const busy = useStructureStore((s) => s.busy);
  const armed = useStructureStore((s) => s.grow.armed);
  const layout = useAppStore((s) => s.layout);
  const disabled = layout !== 'mpr' || busy !== null;

  return (
    <div className="st-quick">
      <div className="mg-section">Quick add</div>
      <div className="st-quick-grid">
        {QUICK_ADDS.map((q) => (
          <Button key={q.id} size="sm" disabled={disabled} title={q.hint} onClick={() => void quickAdd(q.id)}>
            <span className="st-sw" style={{ background: rgbToCss(q.color) }} />
            {q.label}
          </Button>
        ))}
        <Button
          size="sm"
          icon="wand"
          active={armed}
          disabled={layout !== 'mpr' || busy !== null}
          title="Then click inside the structure on any MPR view"
          onClick={() => (armed ? disarmRegionGrow() : armRegionGrow())}
        >
          {armed ? 'Click a voxel · Esc' : 'Region grow from click'}
        </Button>
      </div>
      {busy && (
        <div className="st-busy">
          <MarginMark size={14} progress={null} />
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
        <Icon name="wand" size={14} />
        <span>Region grow</span>
        <button
          type="button"
          className="st-icon"
          aria-label="Close"
          onClick={() => {
            disarmRegionGrow();
            set({ grow: { padHu: 60, radiusMm: 40, seedIjk: null, seedHu: null, armed: false } });
          }}
        >
          <Icon name="close" size={13} />
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
        <Slider
          label="± HU"
          min={5}
          max={600}
          step={5}
          value={grow.padHu}
          readout={`± ${grow.padHu}`}
          onChange={(v) => set({ grow: { ...grow, padHu: v } })}
        />
        <Slider
          label="Radius"
          min={2}
          max={120}
          step={2}
          value={grow.radiusMm}
          readout={`${grow.radiusMm} mm`}
          onChange={(v) => set({ grow: { ...grow, radiusMm: v } })}
        />
      </div>

      {grow.seedIjk !== null && (
        <>
          <div className="st-grow-window mono">
            window {lower} … {upper} HU
          </div>
          <Button size="sm" block busy={busy !== null} onClick={() => void runRegionGrow()}>
            Grow again with these values
          </Button>
        </>
      )}
    </div>
  );
}

/* ---------------- distance ---------------- */

function DistanceCard() {
  const distance = useStructureStore((s) => s.distance);
  const from = useStructureStore((s) => s.distanceFrom);

  if (from) {
    const a = structureById(from);
    return (
      <div className="st-distance pick">
        <Icon name="ruler" size={14} />
        <div>
          Pick the second structure for <strong>{a?.name ?? 'this structure'}</strong>.
          <Button size="sm" onClick={() => cancelDistance()}>
            Cancel
          </Button>
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
      <TileRow>
        <Tile
          size="sm"
          value={distance.mm.toFixed(1)}
          unit="mm"
          label="closest approach"
          sub={`${a?.name ?? '—'} → ${b?.name ?? '—'}`}
          severity={overlapping ? 'danger' : 'info'}
        />
      </TileRow>
      <div className="st-d-actions">
        <Button size="sm" icon="jump" onClick={() => jumpToDistance()}>
          Jump to the closest point
        </Button>
        <Button size="sm" tone="ghost" icon="close" iconOnly aria-label="Clear" onClick={() => clearDistance()} />
      </div>
      {overlapping && <div className="st-row-note warn">The two structures overlap.</div>}
    </div>
  );
}

/* ---------------- one structure ---------------- */

function StructureRow({ row }: { row: Structure }) {
  const distanceFrom = useStructureStore((s) => s.distanceFrom);
  const anatomy = useAppStore((s) => s.anatomy);
  const picking = distanceFrom !== null && distanceFrom !== row.id;
  const isSource = distanceFrom === row.id;

  // The glow: this row's segment is the one under the cursor right now.
  const hot =
    anatomy.segmentationId === row.segmentationId && anatomy.segmentIndex === row.segmentIndex;

  const cls = ['st-row', isSource ? 'src' : '', picking ? 'pick' : '', hot ? 'hot' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls}>
      <div className="st-line">
        <span
          className="st-sw"
          style={{ background: rgbToCss(row.color), opacity: row.visible ? 1 : 0.35 }}
        />
        <span className="st-name" title={`${row.name} · ${row.source}`}>
          {row.name}
        </span>
        <span className="st-vol mono">{row.volume_ml.toFixed(row.volume_ml < 10 ? 2 : 1)} ml</span>
        <WithTooltip label={row.visible ? 'Hide' : row.loaded ? 'Show' : 'Reload and show'} placement="left">
          <button
            type="button"
            className="st-icon"
            aria-label={row.visible ? 'Hide structure' : 'Show structure'}
            onClick={() => void setVisible(row.id, !row.visible)}
          >
            <Icon name={row.visible ? 'eye' : 'eyeOff'} size={14} weight={row.visible ? 'fill' : 'regular'} />
          </button>
        </WithTooltip>
      </div>

      <div className="st-line2">
        <Slider
          className="st-opacity"
          label="Opacity"
          min={0}
          max={100}
          step={5}
          value={Math.round(row.opacity * 100)}
          readout={`${Math.round(row.opacity * 100)} %`}
          accent={rgbToCss(row.color)}
          onChange={(v) => setOpacity(row.id, v / 100)}
        />
        <div className="st-row-actions">
          <WithTooltip label={row.in3d ? 'Remove from 3D' : 'Show surface in 3D'} placement="left">
            <button
              type="button"
              className={`st-icon${row.in3d ? ' on' : ''}`}
              aria-label="Toggle 3D surface"
              onClick={() => void toggle3d(row.id)}
            >
              <Icon name="volume3d" size={14} weight={row.in3d ? 'fill' : 'regular'} />
            </button>
          </WithTooltip>
          <WithTooltip label="Export STL" placement="left">
            <button type="button" className="st-icon" aria-label="Export STL" onClick={() => void exportStl(row.id)}>
              <Icon name="download" size={14} />
            </button>
          </WithTooltip>
          <WithTooltip label={picking ? 'Measure to this' : 'Distance to another structure'} placement="left">
            <button
              type="button"
              className={`st-icon${isSource ? ' on' : ''}`}
              aria-label="Measure distance"
              onClick={() =>
                picking && distanceFrom ? void measureDistance(distanceFrom, row.id) : startDistance(row.id)
              }
            >
              <Icon name="ruler" size={14} />
            </button>
          </WithTooltip>
          <WithTooltip label="Delete" placement="left">
            <button
              type="button"
              className="st-icon danger"
              aria-label="Delete structure"
              onClick={() => void removeStructure(row.id)}
            >
              <Icon name="trash" size={14} />
            </button>
          </WithTooltip>
        </div>
      </div>

      {row.busy && (
        <div className="st-row-note">
          <MarginMark size={12} progress={null} />
          {row.busy}
        </div>
      )}
      {!row.busy && !row.loaded && (
        <div className="st-row-note warn">
          <Icon name="warning" size={12} />
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
          type="button"
          className="st-icon"
          aria-label={allVisible ? 'Hide all in this group' : 'Show all in this group'}
          title={allVisible ? `Hide all ${CATEGORY_LABEL[category].toLowerCase()}` : 'Show all'}
          onClick={() => void setCategoryVisible(category, !allVisible)}
        >
          <Icon name={allVisible ? 'eye' : 'eyeOff'} size={14} weight={allVisible ? 'fill' : 'regular'} />
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
    <>
      <QuickAdds />
      <GrowForm />
      <DistanceCard />

      {items.length === 0 ? (
        <div className="mg-empty">
          <Icon name="selection" size={24} className="mg-empty-ico" />
          <h3>No structures yet</h3>
          <p>
            {layout === 'mpr'
              ? 'Use a quick add above, grow a region from a click, or run the AI segmentation below. Once structures are loaded the cursor names whatever it is over.'
              : 'Open a volumetric study — segmentation needs the MPR layout.'}
          </p>
        </div>
      ) : (
        <>
          <div className="mg-section">
            Structures
            <span className="sp" />
            <Chip size="sm">{items.length}</Chip>
          </div>
          {groups.map((g) => (
            <Group key={g.c} category={g.c} rows={g.rows} />
          ))}
        </>
      )}
    </>
  );
}
