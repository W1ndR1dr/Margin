/**
 * The 52 px left rail (UI-OVERHAUL.md §3).
 *
 *   navigate · measure · head & neck tools · layout / snapshot
 *
 * "active tool on --raised with accent icon; tooltip 'Name · key'". The active
 * icon switches to Phosphor's fill cut, so the state reads at a glance without
 * a second colour. Clinical tools carry Health Icons; anything with no fitting
 * icon carries a short text label rather than a homemade glyph (Brian's rule).
 */
import { useAppStore, type GridMode } from '../store/useAppStore';
import { carotid, useCarotidStore } from '../tools/carotid';
import { airway, useAirwayStore } from '../tools/airway';
import { RAIL_TOOLS, viewer } from '../viewer/ViewerCore';
import { volumePresetsFor } from '../viewer/presets';
import { Icon, PopItem, Popover, WithTooltip, type IconName } from '../ui';

/** Rail tool name -> icon. Every RAIL_TOOLS entry must appear here. */
const TOOL_ICON: Record<string, IconName> = {
  WindowLevel: 'windowLevel',
  Pan: 'pan',
  Zoom: 'zoom',
  StackScroll: 'scroll',
  Crosshairs: 'crosshair',
  Length: 'length',
  Bidirectional: 'bidirectional',
  Angle: 'angle',
  EllipticalROI: 'ellipseRoi',
  RectangleROI: 'rectangleRoi',
  PlanarFreehandROI: 'freehandRoi',
  Probe: 'probe',
};

const GRIDS: Array<{ id: GridMode; label: string; icon: IconName }> = [
  { id: 'strip', label: 'Primary + context strip', icon: 'layoutStrip' },
  { id: '2x2', label: 'Quad MPR + 3D', icon: 'layoutQuad' },
  { id: '1x1', label: 'Single viewport', icon: 'layoutSingle' },
];

/** Head & neck tools still on the roadmap; they carry their version. */
const SOON: Array<{ id: string; label: string; key: string; icon: IconName; when: string }> = [
  { id: 'node', label: 'Node level', key: 'N', icon: 'node', when: 'v0.3' },
  { id: 'mandible', label: 'Mandible planner', key: 'M', icon: 'tooth', when: 'v0.4' },
];

function RailButton({
  icon,
  label,
  hotkey,
  on,
  disabled,
  onClick,
  text,
}: {
  icon?: IconName;
  label: string;
  hotkey?: string;
  on?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** Shown instead of an icon when no icon in either set fits the tool. */
  text?: string;
}) {
  return (
    <WithTooltip label={label} hotkey={hotkey}>
      <button
        type="button"
        className={`rail-btn${on ? ' on' : ''}`}
        disabled={disabled}
        onClick={onClick}
        aria-label={label}
        aria-pressed={on}
      >
        {icon ? <Icon name={icon} size={20} weight={on ? 'fill' : 'regular'} /> : <span className="rail-text">{text}</span>}
      </button>
    </WithTooltip>
  );
}

export function ToolRail({ onScreenshot }: { onScreenshot: () => void }) {
  const activeTool = useAppStore((s) => s.activeTool);
  const layout = useAppStore((s) => s.layout);
  const grid = useAppStore((s) => s.grid);
  const volumePresetId = useAppStore((s) => s.volumePresetId);
  const modality = useAppStore((s) => s.activeSeries?.modality);
  const cine = useAppStore((s) => s.cine);
  const carotidPhase = useCarotidStore((s) => s.phase);
  const airwayPhase = useAirwayStore((s) => s.phase);
  const structuresMenuOpen = useAppStore((s) => s.structuresMenuOpen);
  const set = useAppStore((s) => s.set);

  const idle = layout === 'none';
  const mpr = layout === 'mpr';
  const navigate = RAIL_TOOLS.filter((t) => t.group === 'navigate');
  const measure = RAIL_TOOLS.filter((t) => t.group === 'measure');

  const renderTool = (name: string, label: string, key: string, mprOnly?: boolean) => (
    <RailButton
      key={name}
      icon={TOOL_ICON[name] ?? 'crosshair'}
      label={label}
      hotkey={key.toUpperCase()}
      on={activeTool === name}
      disabled={idle || (mprOnly === true && !mpr)}
      onClick={() => viewer.setActiveTool(name)}
    />
  );

  return (
    <aside className="rail" aria-label="Tools">
      {navigate.map((t) => renderTool(t.name, t.label, t.key, t.mprOnly))}

      <div className="rail-sep" />

      {measure.map((t) => renderTool(t.name, t.label, t.key))}

      <div className="rail-sep" />

      {/* head & neck — Health Icons */}
      <RailButton
        icon="vessel"
        label="Carotid encasement"
        hotkey="C"
        on={carotidPhase !== 'idle'}
        disabled={!mpr}
        onClick={() => carotid.start()}
      />
      <RailButton
        icon="airway"
        label="Airway patency"
        hotkey="Y"
        on={airwayPhase !== 'idle'}
        disabled={!mpr}
        onClick={() => airway.start()}
      />
      <RailButton
        icon="selection"
        label="Segment · quick menu"
        hotkey="G"
        on={structuresMenuOpen}
        disabled={!mpr}
        onClick={() => set({ structuresMenuOpen: !structuresMenuOpen })}
      />
      {SOON.map((t) => (
        <RailButton key={t.id} icon={t.icon} label={`${t.label} · ${t.when}`} hotkey={t.key} disabled />
      ))}

      <div className="rail-sep" />

      {GRIDS.map((g) => (
        <RailButton
          key={g.id}
          icon={g.icon}
          label={g.label}
          on={grid === g.id && !idle}
          disabled={idle || !mpr}
          onClick={() => set({ grid: g.id, maximized: null })}
        />
      ))}

      <Popover
        placement="side"
        disabled={!mpr}
        trigger={() => (
          <WithTooltip label="3D presets">
            <button type="button" className="rail-btn" disabled={!mpr} aria-label="3D presets">
              <Icon name="volume3d" size={20} />
            </button>
          </WithTooltip>
        )}
      >
        {(close) => (
          <>
            <div className="mg-pop-label">Volume rendering</div>
            {volumePresetsFor(modality).map((p) => (
              <PopItem
                key={p.id}
                on={p.id === volumePresetId}
                main={p.label}
                sub={p.hint}
                onClick={() => {
                  viewer.setVolumePreset(p.id);
                  close();
                }}
              />
            ))}
          </>
        )}
      </Popover>

      <RailButton
        icon={cine ? 'pause' : 'play'}
        label={cine ? 'Stop cine' : 'Cine loop'}
        hotkey="Space"
        on={cine}
        disabled={idle}
        onClick={() => viewer.toggleCine(!cine)}
      />
      <RailButton icon="reset" label="Reset views" hotkey="R" disabled={idle} onClick={() => viewer.resetViews()} />
      <RailButton icon="snapshot" label="Snapshot PNG" hotkey="K" disabled={idle} onClick={onScreenshot} />

      <div className="rail-spacer" />

      <RailButton
        icon="report"
        label="Report"
        onClick={() => set({ panelTab: 'report', panelOpen: true, askOpen: false })}
      />
    </aside>
  );
}
