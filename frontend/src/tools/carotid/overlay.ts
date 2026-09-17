/**
 * The contact arc drawn on the axial image.
 *
 * Everything is recomputed from world millimetres through the viewport's own
 * `worldToCanvas` on every render, so the arc stays welded to the vessel under
 * pan, zoom, window and resize. It hides itself as soon as the axial viewport
 * leaves the slice the measurement was made on.
 *
 * This is a plain DOM layer parked inside the Cornerstone host element rather
 * than a React node: React never owns that element's children, and ViewerCore
 * stays the only owner of Cornerstone state.
 */
import { Enums, type Types } from '@cornerstonejs/core';
import { viewer } from '../../viewer/ViewerCore';
import { directionAt, type Arc } from './geometry';

export interface OverlayGeometry {
  /** Lumen centre in world (LPS) mm. */
  centerWorld: Types.Point3;
  radiusMm: number;
  arcs: Arc[];
  /** Axial slice the measurement belongs to. */
  sliceIndex: number;
  /** CSS colour for the arc — a design token, e.g. `var(--warn)`. */
  color: string;
  /** Short mono label, e.g. "116°". */
  label: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ARC_STEP_DEG = 1.5;
const RING_DASH = '2 4';

type AxialViewport = Types.IViewport & {
  worldToCanvas?: (p: Types.Point3) => Types.Point2;
  getSliceIndex?: () => number;
};

class CarotidArcOverlay {
  private svg: SVGSVGElement | null = null;
  private host: HTMLElement | null = null;
  private geom: OverlayGeometry | null = null;
  private listening: HTMLElement | null = null;
  private readonly redraw = () => this.draw();

  show(geom: OverlayGeometry): void {
    this.geom = geom;
    this.draw();
  }

  hide(): void {
    this.geom = null;
    if (this.svg) this.svg.style.display = 'none';
  }

  destroy(): void {
    this.hide();
    this.detachListeners();
    this.svg?.remove();
    this.svg = null;
    this.host = null;
  }

  /* ---------------- plumbing ---------------- */

  private ensureMounted(): SVGSVGElement | null {
    const host = viewer.getElement('axial');
    if (!host) return null;

    if (!this.svg) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'carotid-arc-layer');
      Object.assign(svg.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        pointerEvents: 'none',
        overflow: 'visible',
        zIndex: '5',
      } as Partial<CSSStyleDeclaration>);
      this.svg = svg;
    }
    if (this.svg.parentElement !== host) {
      host.appendChild(this.svg);
      this.host = host;
    }
    if (this.listening !== host) {
      this.detachListeners();
      host.addEventListener(Enums.Events.IMAGE_RENDERED, this.redraw);
      host.addEventListener(Enums.Events.CAMERA_MODIFIED, this.redraw);
      this.listening = host;
    }
    return this.svg;
  }

  private detachListeners(): void {
    if (!this.listening) return;
    this.listening.removeEventListener(Enums.Events.IMAGE_RENDERED, this.redraw);
    this.listening.removeEventListener(Enums.Events.CAMERA_MODIFIED, this.redraw);
    this.listening = null;
  }

  /* ---------------- drawing ---------------- */

  private draw(): void {
    const svg = this.ensureMounted();
    if (!svg) return;
    const geom = this.geom;
    if (!geom) {
      svg.style.display = 'none';
      return;
    }

    const vp = viewer.getViewport('axial') as AxialViewport | null;
    if (!vp?.worldToCanvas) {
      svg.style.display = 'none';
      return;
    }
    const slice = vp.getSliceIndex?.();
    if (typeof slice === 'number' && slice !== geom.sliceIndex) {
      svg.style.display = 'none';
      return;
    }

    // Sit exactly over the Cornerstone canvas: worldToCanvas answers in that
    // canvas's CSS pixels.
    const host = this.host;
    const canvas = host?.querySelector('canvas');
    if (!host || !canvas) {
      svg.style.display = 'none';
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      svg.style.display = 'none';
      return;
    }
    svg.style.display = 'block';
    svg.style.left = `${rect.left - hostRect.left}px`;
    svg.style.top = `${rect.top - hostRect.top}px`;
    svg.setAttribute('width', String(rect.width));
    svg.setAttribute('height', String(rect.height));
    svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);

    const at = (deg: number, scale = 1): Types.Point2 => {
      const [dx, dy] = directionAt(deg);
      const r = geom.radiusMm * scale;
      return vp.worldToCanvas!([
        geom.centerWorld[0] + r * dx,
        geom.centerWorld[1] + r * dy,
        geom.centerWorld[2],
      ]);
    };

    const parts: string[] = [];

    // guide ring over the whole sampled circumference
    parts.push(
      `<path d="${polyline(0, 360, at)}" fill="none" stroke="rgba(232,236,241,0.30)" ` +
        `stroke-width="1" stroke-dasharray="${RING_DASH}" />`,
    );

    for (const arc of geom.arcs) {
      parts.push(
        `<path d="${polyline(arc.startDeg, arc.endDeg, at)}" fill="none" ` +
          `style="stroke:${geom.color}" stroke-width="4" stroke-linecap="round" ` +
          `stroke-opacity="0.95" />`,
      );
      for (const end of [arc.startDeg, arc.endDeg]) {
        const a = at(end, 0.78);
        const b = at(end, 1.34);
        parts.push(
          `<line x1="${fx(a[0])}" y1="${fx(a[1])}" x2="${fx(b[0])}" y2="${fx(b[1])}" ` +
            `style="stroke:${geom.color}" stroke-width="1.2" stroke-opacity="0.8" />`,
        );
      }
    }

    if (geom.arcs.length && geom.label) {
      const mid = geom.arcs.reduce((best, a) =>
        a.endDeg - a.startDeg > best.endDeg - best.startDeg ? a : best,
      );
      const p = at((mid.startDeg + mid.endDeg) / 2, 2.3);
      parts.push(
        `<text x="${fx(p[0])}" y="${fx(p[1])}" text-anchor="middle" dominant-baseline="middle" ` +
          `font-family="'JetBrains Mono', ui-monospace, monospace" font-size="12" ` +
          `paint-order="stroke" stroke="rgba(10,12,16,0.85)" stroke-width="3.5" ` +
          `stroke-linejoin="round" style="fill:${geom.color}">${escapeText(geom.label)}</text>`,
      );
    }

    svg.innerHTML = parts.join('');
  }
}

function fx(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : '0';
}

function polyline(
  fromDeg: number,
  toDeg: number,
  at: (deg: number, scale?: number) => Types.Point2,
): string {
  const out: string[] = [];
  const push = (deg: number) => {
    const [x, y] = at(deg);
    out.push(`${out.length ? 'L' : 'M'}${fx(x)} ${fx(y)}`);
  };
  for (let d = fromDeg; d < toDeg; d += ARC_STEP_DEG) push(d);
  push(toDeg);
  return out.join(' ');
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const carotidOverlay = new CarotidArcOverlay();
