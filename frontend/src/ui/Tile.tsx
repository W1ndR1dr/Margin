/**
 * Evidence tile — Margin's signature way of showing a measured number.
 *
 * UI-OVERHAUL.md §2: "Big JetBrains Mono number (28-40 px), 11 px label below,
 * on --raised with a hairline. Used in findings, tool results, Ask."
 *
 * The number is the hero; the unit rides at its baseline at a smaller size so
 * a column of tiles still aligns on the digits. Tabular numerals throughout,
 * so 139° and 38° line up in a row of tiles the way they would in a table.
 */
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { SeverityGlyph, type Severity } from './controls';

export interface TileProps {
  /** The measured value. Already formatted — the tile never rounds. */
  value: ReactNode;
  /** Small unit at the value's baseline: °, mm, ml, mm². */
  unit?: ReactNode;
  /** 11 px caption under the number. */
  label: ReactNode;
  /** One more line of provenance: "slice 112", "left ICA". */
  sub?: ReactNode;
  severity?: Severity;
  icon?: IconName;
  size?: 'sm' | 'md' | 'lg';
  /** Clickable tiles jump to the slice the number came from. */
  onClick?: () => void;
  title?: string;
  className?: string;
}

export function Tile({
  value,
  unit,
  label,
  sub,
  severity,
  icon,
  size = 'md',
  onClick,
  title,
  className,
}: TileProps) {
  const cls = [
    'mg-tile',
    `s-${size}`,
    severity ? `sev-${severity}` : '',
    onClick ? 'act' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const body = (
    <>
      <span className="mg-tile-num mono">
        {value}
        {unit !== undefined && <span className="mg-tile-unit">{unit}</span>}
      </span>
      <span className="mg-tile-label">
        {severity && <SeverityGlyph severity={severity} size={9} />}
        {icon && !severity && <Icon name={icon} size={11} />}
        {label}
      </span>
      {sub !== undefined && <span className="mg-tile-sub mono">{sub}</span>}
    </>
  );

  if (!onClick) {
    return (
      <div className={cls} title={title}>
        {body}
      </div>
    );
  }
  return (
    <button type="button" className={cls} title={title} onClick={onClick}>
      {body}
    </button>
  );
}

/** A row of tiles that wraps and keeps them equal-width. */
export function TileRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`mg-tile-row${className ? ` ${className}` : ''}`}>{children}</div>;
}
