/**
 * The "distance to…" line, drawn on every MPR pane.
 *
 * Same approach as the carotid arc overlay: a plain SVG layer parked inside
 * the Cornerstone host element, recomputed from world millimetres through the
 * viewport's own `worldToCanvas` on every render so it stays welded to the
 * anatomy under pan, zoom and scroll.
 *
 * The two endpoints rarely share a plane, so what is drawn is the projection
 * of the segment onto each view — the endpoints are ringed and the one that is
 * off-plane is dimmed, so it never reads as an in-plane measurement.
 */
import { Enums, type Types } from '@cornerstonejs/core';
import { viewer } from '../viewer/ViewerCore';
import type { PaneId } from '../store/useAppStore';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MPR: PaneId[] = ['axial', 'sagittal', 'coronal'];
/** Off-plane distance (mm) past which an endpoint is drawn as a ghost. */
const IN_PLANE_MM = 2;

export interface LineGeometry {
  a: Types.Point3;
  b: Types.Point3;
  label: string;
  color: string;
}

type MprViewport = Types.IViewport & {
  worldToCanvas?: (p: Types.Point3) => Types.Point2;
  getCamera?: () => { focalPoint?: Types.Point3; viewPlaneNormal?: Types.Point3 };
};

class LineOverlay {
  private layers = new Map<PaneId, SVGSVGElement>();
  private listening = new Map<PaneId, HTMLElement>();
  private geom: LineGeometry | null = null;
  private readonly redraw = () => this.draw();

  show(geom: LineGeometry): void {
    this.geom = geom;
    this.draw();
  }

  hide(): void {
    this.geom = null;
    this.layers.forEach((svg) => {
      svg.style.display = 'none';
    });
  }

  destroy(): void {
    this.hide();
    this.listening.forEach((host, pane) => {
      host.removeEventListener(Enums.Events.IMAGE_RENDERED, this.redraw);
      host.removeEventListener(Enums.Events.CAMERA_MODIFIED, this.redraw);
      this.layers.get(pane)?.remove();
    });
    this.listening.clear();
    this.layers.clear();
  }

  private ensureMounted(pane: PaneId): SVGSVGElement | null {
    const host = viewer.getElement(pane);
    if (!host) return null;
    let svg = this.layers.get(pane);
    if (!svg) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'hn-line-layer');
      Object.assign(svg.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        pointerEvents: 'none',
        overflow: 'visible',
        zIndex: '5',
      } as Partial<CSSStyleDeclaration>);
      this.layers.set(pane, svg);
    }
    if (svg.parentElement !== host) host.appendChild(svg);
    if (this.listening.get(pane) !== host) {
      const prev = this.listening.get(pane);
      if (prev) {
        prev.removeEventListener(Enums.Events.IMAGE_RENDERED, this.redraw);
        prev.removeEventListener(Enums.Events.CAMERA_MODIFIED, this.redraw);
      }
      host.addEventListener(Enums.Events.IMAGE_RENDERED, this.redraw);
      host.addEventListener(Enums.Events.CAMERA_MODIFIED, this.redraw);
      this.listening.set(pane, host);
    }
    return svg;
  }

  private draw(): void {
    const panes = viewer.mprPanes.length ? viewer.mprPanes : MPR;
    panes.forEach((pane) => this.drawPane(pane));
  }

  private drawPane(pane: PaneId): void {
    const svg = this.ensureMounted(pane);
    if (!svg) return;
    const geom = this.geom;
    const vp = viewer.getViewport(pane) as MprViewport | null;
    const host = viewer.getElement(pane);
    const canvas = host?.querySelector('canvas');
    if (!geom || !vp?.worldToCanvas || !host || !canvas) {
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

    const cam = vp.getCamera?.();
    const n = cam?.viewPlaneNormal;
    const f = cam?.focalPoint;
    const offPlane = (p: Types.Point3): number => {
      if (!n || !f) return 0;
      return Math.abs((p[0] - f[0]) * n[0] + (p[1] - f[1]) * n[1] + (p[2] - f[2]) * n[2]);
    };

    const pa = vp.worldToCanvas(geom.a);
    const pb = vp.worldToCanvas(geom.b);
    const aNear = offPlane(geom.a) <= IN_PLANE_MM;
    const bNear = offPlane(geom.b) <= IN_PLANE_MM;

    const parts: string[] = [];
    parts.push(
      `<line x1="${fx(pa[0])}" y1="${fx(pa[1])}" x2="${fx(pb[0])}" y2="${fx(pb[1])}" ` +
        `style="stroke:${geom.color}" stroke-width="1.6" stroke-dasharray="5 3" stroke-opacity="0.9" />`,
    );
    parts.push(endpoint(pa, geom.color, aNear));
    parts.push(endpoint(pb, geom.color, bNear));

    const mx = (pa[0] + pb[0]) / 2;
    const my = (pa[1] + pb[1]) / 2;
    parts.push(
      `<text x="${fx(mx)}" y="${fx(my - 8)}" text-anchor="middle" dominant-baseline="middle" ` +
        `font-family="'JetBrains Mono', ui-monospace, monospace" font-size="12" ` +
        `paint-order="stroke" stroke="rgba(10,12,16,0.85)" stroke-width="3.5" stroke-linejoin="round" ` +
        `style="fill:${geom.color}">${escapeText(geom.label)}</text>`,
    );

    svg.innerHTML = parts.join('');
  }
}

function endpoint(p: Types.Point2, color: string, near: boolean): string {
  return (
    `<circle cx="${fx(p[0])}" cy="${fx(p[1])}" r="${near ? 4 : 3}" fill="none" ` +
    `style="stroke:${color}" stroke-width="${near ? 2 : 1}" stroke-opacity="${near ? 1 : 0.45}" />`
  );
}

function fx(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : '0';
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const lineOverlay = new LineOverlay();
