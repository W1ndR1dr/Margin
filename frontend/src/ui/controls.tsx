/**
 * Margin's control set.
 *
 * UI-OVERHAUL.md §1 is binding: there is no `<input type=range>`, no
 * `<select>`, no native checkbox or radio, and no default button styling
 * anywhere in the app. Each control here is built from tokens, driven from the
 * keyboard, and carries the same visible 2 px accent focus ring.
 *
 * Styles live in ui.css next to this file, keyed by the `mg-` prefix so they
 * can never collide with the viewer's own classes.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from './Icon';

/* ================================================================== */
/* Button                                                             */
/* ================================================================== */

export type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  tone?: ButtonTone;
  size?: ButtonSize;
  icon?: IconName;
  /** Icon on the right — used for "jump" and disclosure affordances. */
  iconAfter?: IconName;
  /** Square, label-free. `aria-label` becomes required in spirit. */
  iconOnly?: boolean;
  /** Fill the row. */
  block?: boolean;
  /** Pressed / latched, e.g. a picking mode that is armed. */
  active?: boolean;
  busy?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    tone = 'secondary',
    size = 'md',
    icon,
    iconAfter,
    iconOnly,
    block,
    active,
    busy,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const cls = [
    'mg-btn',
    `t-${tone}`,
    `s-${size}`,
    iconOnly ? 'only' : '',
    block ? 'block' : '',
    active ? 'on' : '',
    busy ? 'busy' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      disabled={disabled || busy}
      aria-pressed={active === undefined ? undefined : active}
      {...rest}
    >
      {busy ? (
        <Icon name="spinner" size={size === 'sm' ? 13 : 15} className="mg-spin" />
      ) : (
        icon && <Icon name={icon} size={size === 'sm' ? 13 : 15} />
      )}
      {children !== undefined && <span className="mg-btn-l">{children}</span>}
      {iconAfter && <Icon name={iconAfter} size={size === 'sm' ? 13 : 15} />}
    </button>
  );
});

/* ================================================================== */
/* Toggle (switch)                                                    */
/* ================================================================== */

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  /** One line under the label, for the "why would I turn this on" sentence. */
  hint?: ReactNode;
  disabled?: boolean;
  /** Put the switch first instead of at the end of the row. */
  leading?: boolean;
  id?: string;
}

export function Toggle({ checked, onChange, label, hint, disabled, leading, id }: ToggleProps) {
  const auto = useId();
  const labelId = id ?? auto;
  const track = (
    <span className="mg-toggle-track" aria-hidden>
      <span className="mg-toggle-knob" />
    </span>
  );
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={label ? `${labelId}-l` : undefined}
      disabled={disabled}
      className={`mg-toggle${checked ? ' on' : ''}${leading ? ' lead' : ''}`}
      onClick={() => onChange(!checked)}
    >
      {leading && track}
      {label !== undefined && (
        <span className="mg-toggle-text">
          <span className="mg-toggle-label" id={`${labelId}-l`}>
            {label}
          </span>
          {hint !== undefined && <span className="mg-toggle-hint">{hint}</span>}
        </span>
      )}
      {!leading && track}
    </button>
  );
}

/* ================================================================== */
/* Segmented                                                          */
/* ================================================================== */

export interface SegmentedOption<T extends string> {
  value: T;
  label?: ReactNode;
  icon?: IconName;
  /** Tooltip text; also the accessible name when there is no label. */
  title?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (next: T) => void;
  /** Screen-reader name for the whole group. */
  label: string;
  size?: ButtonSize;
  block?: boolean;
  className?: string;
}

/**
 * A radio group that behaves like one: arrow keys move between options and
 * only the selected option is in the tab order (WAI-ARIA roving tabindex).
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  block,
  className,
}: SegmentedProps<T>) {
  const ref = useRef<HTMLDivElement>(null);

  const move = (dir: 1 | -1) => {
    const live = options.filter((o) => !o.disabled);
    if (!live.length) return;
    const at = live.findIndex((o) => o.value === value);
    const next = live[(at + dir + live.length) % live.length];
    onChange(next.value);
    // Keep focus on the newly selected option so the roving tabindex holds.
    window.requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
    });
  };

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      className={`mg-seg s-${size}${block ? ' block' : ''}${className ? ` ${className}` : ''}`}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.label === undefined ? (o.title ?? o.value) : undefined}
            title={o.title}
            disabled={o.disabled}
            tabIndex={on ? 0 : -1}
            className={`mg-seg-opt${on ? ' on' : ''}${o.label === undefined ? ' only' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.icon && <Icon name={o.icon} size={size === 'sm' ? 14 : 16} weight={on ? 'fill' : 'regular'} />}
            {o.label !== undefined && <span>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ================================================================== */
/* Slider                                                             */
/* ================================================================== */

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  /** Called once when a drag ends — for expensive commits. */
  onCommit?: (next: number) => void;
  label: string;
  /** Rendered at the right of the label row; usually the value in mono. */
  readout?: ReactNode;
  disabled?: boolean;
  /** Paint the fill in this colour (structure opacity uses the swatch). */
  accent?: string;
  className?: string;
}

/**
 * A pointer-and-keyboard slider. Not `<input type=range>`: that control cannot
 * be styled to the hairline/tick language the rest of the app uses without
 * vendor pseudo-elements that differ per engine, and UI-OVERHAUL.md §1 rules
 * native controls out anyway.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  onCommit,
  label,
  readout,
  disabled,
  accent,
  className,
}: SliderProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const clamp = useCallback(
    (v: number) => {
      const snapped = Math.round((v - min) / step) * step + min;
      // Re-round to the step's own precision so 0.1 steps do not drift.
      const decimals = (String(step).split('.')[1] ?? '').length;
      return Number(Math.max(min, Math.min(max, snapped)).toFixed(decimals));
    },
    [min, max, step],
  );

  const valueAt = (clientX: number): number => {
    const el = railRef.current;
    if (!el) return value;
    const r = el.getBoundingClientRect();
    const t = r.width ? (clientX - r.left) / r.width : 0;
    return clamp(min + Math.max(0, Math.min(1, t)) * (max - min));
  };

  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const big = (max - min) / 10;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - step;
    else if (e.key === 'PageUp') next = value + big;
    else if (e.key === 'PageDown') next = value - big;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    const v = clamp(next);
    onChange(v);
    onCommit?.(v);
  };

  return (
    <div className={`mg-slider${disabled ? ' off' : ''}${className ? ` ${className}` : ''}`}>
      <div className="mg-slider-head">
        <span className="mg-slider-label">{label}</span>
        {readout !== undefined && <span className="mg-slider-readout mono">{readout}</span>}
      </div>
      <div
        ref={railRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-disabled={disabled || undefined}
        className="mg-slider-rail"
        style={accent ? ({ '--mg-slider-accent': accent } as CSSProperties) : undefined}
        onKeyDown={disabled ? undefined : onKey}
        onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
          if (disabled || e.button !== 0) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          onChange(valueAt(e.clientX));
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          onChange(valueAt(e.clientX));
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            /* pointer already gone */
          }
          onCommit?.(valueAt(e.clientX));
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        <span className="mg-slider-track" />
        <span className="mg-slider-fill" style={{ width: `${pct}%` }} />
        <span className="mg-slider-knob" style={{ left: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ================================================================== */
/* Chip / Pill                                                        */
/* ================================================================== */

export type Severity = 'ok' | 'caution' | 'danger' | 'info' | 'node' | 'tumor';

/**
 * Severity as shape AND colour (UI-OVERHAUL.md §2): dot (ok), half ring
 * (caution), full ring (danger). Colourblind-safe by construction — the glyph
 * carries the meaning even in greyscale.
 */
export function SeverityGlyph({ severity, size = 11 }: { severity: Severity; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" className="mg-sev-glyph" aria-hidden>
      {(severity === 'ok' || severity === 'info') && <circle cx="6" cy="6" r="2.6" fill="currentColor" />}
      {severity === 'caution' && (
        <path
          d="M6 1.6a4.4 4.4 0 0 1 0 8.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      )}
      {severity === 'danger' && <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="2.2" />}
      {severity === 'node' && (
        <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2 1.6" />
      )}
      {severity === 'tumor' && <rect x="2.4" y="2.4" width="7.2" height="7.2" rx="2.2" fill="currentColor" />}
    </svg>
  );
}

export interface ChipProps {
  children: ReactNode;
  severity?: Severity;
  icon?: IconName;
  /** Colour swatch instead of an icon — structures use this. */
  swatch?: string;
  /** Interactive chips get hover/focus affordances. */
  onClick?: () => void;
  active?: boolean;
  /** Hairline turns accent — the anatomy chip glow (UI-OVERHAUL.md §2). */
  glow?: boolean;
  title?: string;
  size?: ButtonSize;
  className?: string;
}

/** A labelled token. Carries a severity glyph when it carries a severity. */
export function Chip({
  children,
  severity,
  icon,
  swatch,
  onClick,
  active,
  glow,
  title,
  size = 'md',
  className,
}: ChipProps) {
  const cls = [
    'mg-chip',
    `s-${size}`,
    severity ? `sev-${severity}` : '',
    active ? 'on' : '',
    glow ? 'glow' : '',
    onClick ? 'act' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const inner = (
    <>
      {swatch !== undefined && <span className="mg-chip-sw" style={{ background: swatch }} aria-hidden />}
      {severity !== undefined && swatch === undefined && icon === undefined && (
        <SeverityGlyph severity={severity} size={size === 'sm' ? 10 : 11} />
      )}
      {icon && <Icon name={icon} size={size === 'sm' ? 12 : 14} weight={active ? 'fill' : 'regular'} />}
      <span className="mg-chip-l">{children}</span>
    </>
  );

  if (!onClick) {
    return (
      <span className={cls} title={title}>
        {inner}
      </span>
    );
  }
  return (
    <button type="button" className={cls} title={title} onClick={onClick} aria-pressed={active}>
      {inner}
    </button>
  );
}

export interface PillProps {
  children: ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'muted';
  /** A progress fraction painted behind the label — "segmenting 62 %". */
  progress?: number | null;
  icon?: IconName;
  title?: string;
  className?: string;
}

/**
 * A status pill. Distinct from Chip: a Pill reports a machine's state (ready,
 * queued, 3 findings), a Chip is a thing the user picked or can pick.
 */
export function Pill({ children, tone = 'neutral', progress, icon, title, className }: PillProps) {
  const pct = typeof progress === 'number' ? Math.max(0, Math.min(1, progress)) * 100 : null;
  return (
    <span className={`mg-pill t-${tone}${className ? ` ${className}` : ''}`} title={title}>
      {pct !== null && <span className="mg-pill-bar" style={{ width: `${pct}%` }} aria-hidden />}
      {icon && <Icon name={icon} size={12} />}
      <span className="mg-pill-l">{children}</span>
    </span>
  );
}

/* ================================================================== */
/* Field                                                              */
/* ================================================================== */

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  icon?: IconName;
  /** Rendered inside the field on the right — a unit, a key hint, a button. */
  trailing?: ReactNode;
  mono?: boolean;
  block?: boolean;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, icon, trailing, mono, block, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <div className={`mg-field${block ? ' block' : ''}${error ? ' err' : ''}${className ? ` ${className}` : ''}`}>
      {label !== undefined && (
        <label className="mg-field-label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      <div className="mg-field-box">
        {icon && <Icon name={icon} size={15} className="mg-field-ico" />}
        <input
          ref={ref}
          id={fieldId}
          className={`mg-field-input${mono ? ' mono' : ''}`}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          {...rest}
        />
        {trailing !== undefined && <span className="mg-field-trail">{trailing}</span>}
      </div>
      {error !== undefined ? (
        <div className="mg-field-err">{error}</div>
      ) : (
        hint !== undefined && <div className="mg-field-hint">{hint}</div>
      )}
    </div>
  );
});

/* ================================================================== */
/* Kbd                                                                */
/* ================================================================== */

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mg-kbd">{children}</kbd>;
}

/* ================================================================== */
/* Popover                                                            */
/* ================================================================== */

export interface PopoverProps {
  trigger: (open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: 'below' | 'below-right' | 'side' | 'above';
  disabled?: boolean;
  className?: string;
}

/** Click-outside and Escape close it; the trigger keeps its own focus ring. */
export function Popover({ trigger, children, placement = 'below', disabled, className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className={`mg-pop-anchor${className ? ` ${className}` : ''}`} ref={ref}>
      <div onClick={() => !disabled && setOpen((v) => !v)}>{trigger(open)}</div>
      {open && !disabled && (
        <div className={`mg-pop ${placement}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export interface PopItemProps {
  on?: boolean;
  main: ReactNode;
  sub?: ReactNode;
  icon?: IconName;
  onClick: () => void;
  disabled?: boolean;
}

export function PopItem({ on, main, sub, icon, onClick, disabled }: PopItemProps) {
  return (
    <button
      type="button"
      className={`mg-pop-item${on ? ' on' : ''}`}
      role="menuitemradio"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
    >
      {icon && <Icon name={icon} size={14} weight={on ? 'fill' : 'regular'} />}
      <span className="main">{main}</span>
      {sub !== undefined && <span className="sub">{sub}</span>}
    </button>
  );
}
