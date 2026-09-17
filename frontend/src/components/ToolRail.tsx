import {
  Box,
  Brush,
  Camera,
  Circle,
  Columns2,
  Contrast,
  Pause,
  Play,
  Crosshair,
  Grid2x2,
  Hand,
  Lasso,
  MoveDiagonal,
  MoveVertical,
  Pipette,
  RotateCcw,
  Ruler,
  Square,
  Triangle,
  Waypoints,
  Wind,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react';
import { useAppStore, type GridMode } from '../store/useAppStore';
import { carotid, useCarotidStore } from '../tools/carotid';
import { airway, useAirwayStore } from '../tools/airway';
import { RAIL_TOOLS, viewer } from '../viewer/ViewerCore';
import { VOLUME_PRESETS } from '../viewer/presets';
import { Popover, PopItem, Tip } from './ui';

const TOOL_ICON: Record<string, LucideIcon> = {
  WindowLevel: Contrast,
  Pan: Hand,
  Zoom: ZoomIn,
  StackScroll: MoveVertical,
  Crosshairs: Crosshair,
  Length: Ruler,
  Bidirectional: MoveDiagonal,
  Angle: Triangle,
  EllipticalROI: Circle,
  RectangleROI: Square,
  PlanarFreehandROI: Lasso,
  Probe: Pipette,
};

/** Head & neck tools still on the roadmap; they carry their version instead. */
const HN_TOOLS: Array<{ id: string; label: string; key: string; icon: LucideIcon; when: string }> = [
  { id: 'node', label: 'Node level', key: 'N', icon: Circle, when: 'v0.3' },
  { id: 'mandible', label: 'Mandible planner', key: 'M', icon: Box, when: 'v0.4' },
];

const GRIDS: Array<{ id: GridMode; label: string; icon: LucideIcon }> = [
  { id: '1x1', label: 'Single', icon: Square },
  { id: '1x2', label: 'Side by side', icon: Columns2 },
  { id: '2x2', label: 'Quad MPR + 3D', icon: Grid2x2 },
];

export function ToolRail({ onScreenshot }: { onScreenshot: () => void }) {
  const activeTool = useAppStore((s) => s.activeTool);
  const layout = useAppStore((s) => s.layout);
  const grid = useAppStore((s) => s.grid);
  const volumePresetId = useAppStore((s) => s.volumePresetId);
  const panelTab = useAppStore((s) => s.panelTab);
  const cine = useAppStore((s) => s.cine);
  const carotidPhase = useCarotidStore((s) => s.phase);
  const airwayPhase = useAirwayStore((s) => s.phase);
  const structuresMenuOpen = useAppStore((s) => s.structuresMenuOpen);
  const set = useAppStore((s) => s.set);

  const idle = layout === 'none';
  const navigate = RAIL_TOOLS.filter((t) => t.group === 'navigate');
  const measure = RAIL_TOOLS.filter((t) => t.group === 'measure');

  const renderTool = (name: string, label: string, key: string, mprOnly?: boolean) => {
    const Icon = TOOL_ICON[name] ?? Crosshair;
    const disabled = idle || (mprOnly === true && layout !== 'mpr');
    return (
      <button
        key={name}
        className={`rail-btn${activeTool === name ? ' on' : ''}`}
        disabled={disabled}
        onClick={() => viewer.setActiveTool(name)}
        aria-label={label}
      >
        <Icon size={18} strokeWidth={1.5} />
        <Tip label={label} hotkey={key.toUpperCase()} />
      </button>
    );
  };

  return (
    <aside className="rail">
      {navigate.map((t) => renderTool(t.name, t.label, t.key, t.mprOnly))}

      <div className="rail-sep" />

      {measure.map((t) => renderTool(t.name, t.label, t.key))}

      <div className="rail-sep" />

      <button
        className={`rail-btn${carotidPhase !== 'idle' ? ' on' : ''}`}
        disabled={layout !== 'mpr'}
        onClick={() => carotid.start()}
        aria-label="Carotid encasement"
      >
        <Waypoints size={18} strokeWidth={1.5} />
        <Tip label="Carotid encasement" hotkey="C" />
      </button>

      <button
        className={`rail-btn${airwayPhase !== 'idle' ? ' on' : ''}`}
        disabled={layout !== 'mpr'}
        onClick={() => airway.start()}
        aria-label="Airway analyser"
      >
        <Wind size={18} strokeWidth={1.5} />
        <Tip label="Airway analyser" hotkey="Y" />
      </button>

      <button
        className={`rail-btn${structuresMenuOpen ? ' on' : ''}`}
        disabled={layout !== 'mpr'}
        onClick={() => set({ structuresMenuOpen: !structuresMenuOpen })}
        aria-label="Segment"
      >
        <Brush size={18} strokeWidth={1.5} />
        <Tip label="Segment · quick menu" hotkey="G" />
      </button>

      {HN_TOOLS.map((t) => (
        <button
          key={t.id}
          className="rail-btn"
          disabled
          title={`${t.label} · ${t.when}`}
          onClick={() => set({ panelTab: 'tools' })}
          aria-label={t.label}
        >
          <t.icon size={18} strokeWidth={1.5} />
          <Tip label={`${t.label} · ${t.when}`} hotkey={t.key} />
        </button>
      ))}

      <div className="rail-sep" />

      {GRIDS.map((g) => (
        <button
          key={g.id}
          className={`rail-btn${grid === g.id && !idle ? ' on' : ''}`}
          disabled={idle || layout !== 'mpr'}
          onClick={() => set({ grid: g.id, maximized: null })}
          aria-label={g.label}
        >
          <g.icon size={18} strokeWidth={1.5} />
          <Tip label={g.label} />
        </button>
      ))}

      <Popover
        placement="side"
        disabled={layout !== 'mpr'}
        trigger={() => (
          <button className="rail-btn" disabled={layout !== 'mpr'} aria-label="3D presets">
            <Box size={18} strokeWidth={1.5} />
            <Tip label="3D presets" />
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="pop-label">Volume rendering</div>
            {VOLUME_PRESETS.map((p) => (
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

      <button
        className={`rail-btn${cine ? ' on' : ''}`}
        disabled={idle}
        onClick={() => viewer.toggleCine(!cine)}
        aria-label="Cine loop"
      >
        {cine ? <Pause size={18} strokeWidth={1.5} /> : <Play size={18} strokeWidth={1.5} />}
        <Tip label={cine ? 'Stop cine' : 'Cine loop'} hotkey="Space" />
      </button>
      <button className="rail-btn" disabled={idle} onClick={() => viewer.resetViews()} aria-label="Reset">
        <RotateCcw size={18} strokeWidth={1.5} />
        <Tip label="Reset views" hotkey="R" />
      </button>
      <button className="rail-btn" disabled={idle} onClick={onScreenshot} aria-label="Snapshot">
        <Camera size={18} strokeWidth={1.5} />
        <Tip label="Snapshot PNG" hotkey="K" />
      </button>

      <div className="spacer" />

      <button
        className={`rail-btn${panelTab === 'report' ? ' on' : ''}`}
        onClick={() => set({ panelTab: 'report', panelOpen: true })}
        aria-label="Report"
      >
        <ReportGlyph />
        <Tip label="Report" />
      </button>
    </aside>
  );
}

function ReportGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" strokeLinejoin="round" />
      <path d="M14 3v5h5M9 13h6M9 17h4" strokeLinecap="round" />
    </svg>
  );
}
