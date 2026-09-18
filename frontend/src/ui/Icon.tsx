/**
 * The only way Margin draws an icon.
 *
 * Backed by the generated offline bundle (`iconData.ts`) through
 * `@iconify/react/offline`, which — unlike the default entry point — has no
 * API client compiled in and therefore cannot make a network request even by
 * accident. Both servers bind 127.0.0.1 and there is no CDN at runtime.
 *
 * `name` is Margin's own vocabulary, not the upstream glyph name, so the art
 * can be swapped without touching a single call site.
 */
import { Icon as Iconify } from '@iconify/react/offline';
import { ICON_DATA, type IconName } from './iconData';

export type { IconName };

export interface IconProps {
  name: IconName;
  /** 20 in the rail, 16 in lists, 14 in dense chrome (UI-OVERHAUL.md §1). */
  size?: number;
  /** Phosphor's solid cut. The active state, never the resting one. */
  weight?: 'regular' | 'fill';
  className?: string;
  /** Inline colour override; prefer `currentColor` and colour the parent. */
  color?: string;
  style?: React.CSSProperties;
}

export function Icon({ name, size = 16, weight = 'regular', className, color, style }: IconProps) {
  const pair = ICON_DATA[name];
  return (
    <Iconify
      icon={weight === 'fill' ? pair.fill : pair.regular}
      width={size}
      height={size}
      className={className}
      color={color}
      style={style}
      aria-hidden
      // Icons are always decorative here: every control that carries one also
      // carries a text label or an aria-label, so the glyph stays out of the
      // accessibility tree rather than reading its own name twice.
      focusable={false}
    />
  );
}

/** True when a string is a name the bundle actually carries. */
export function isIconName(s: string): s is IconName {
  return Object.prototype.hasOwnProperty.call(ICON_DATA, s);
}
