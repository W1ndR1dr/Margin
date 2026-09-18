/**
 * Tooltip — "Name · key", the rail's label (DESIGN.md).
 *
 * CSS-driven rather than JS-positioned: the tooltip is a child of the control
 * and appears on hover and on keyboard focus. That keeps it out of React's
 * render path entirely, which matters in the rail where a pointer sweep would
 * otherwise re-render twelve buttons per frame while the viewer is streaming.
 *
 * `title` attributes are NOT used for these — the native tooltip has a ~1 s
 * delay, its own ugly chrome, and never appears on focus.
 */
import type { ReactNode } from 'react';

export interface TooltipProps {
  label: ReactNode;
  /** Shown in mono at the right of the bubble. */
  hotkey?: string;
  placement?: 'right' | 'below' | 'above' | 'left';
}

export function Tooltip({ label, hotkey, placement = 'right' }: TooltipProps) {
  return (
    <span className={`mg-tip p-${placement}`} role="tooltip">
      {label}
      {hotkey && <span className="mg-tip-k mono">{hotkey}</span>}
    </span>
  );
}

/**
 * Wrap anything to give it a tooltip. The wrapper is `display: contents`-free
 * on purpose (it needs to be the positioning context), so it is an
 * inline-flex span.
 */
export function WithTooltip({
  label,
  hotkey,
  placement,
  children,
  className,
}: TooltipProps & { children: ReactNode; className?: string }) {
  return (
    <span className={`mg-tip-host${className ? ` ${className}` : ''}`}>
      {children}
      <Tooltip label={label} hotkey={hotkey} placement={placement} />
    </span>
  );
}
