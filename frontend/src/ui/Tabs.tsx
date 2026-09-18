/**
 * Tabs — the right panel (Findings · Structures · Measure · Report) and the
 * workspace switcher (Read / Plan / Compare / Board).
 *
 * Two visual cuts of the same keyboard behaviour:
 *   underline  panel tabs: a 1 px accent rule under the active label
 *   solid      top-bar workspaces: the active tab sits on --raised
 *
 * Arrow keys move, Home/End jump, and only the selected tab is tabbable
 * (roving tabindex), so the panel is one Tab stop from the viewport.
 */
import { useRef, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  icon?: IconName;
  /** Small count to the right of the label (measurements, findings). */
  count?: number | null;
  /** A dot instead of a count — "there is something here". */
  dot?: boolean;
  disabled?: boolean;
  title?: string;
}

export interface TabsProps<T extends string> {
  value: T;
  tabs: Array<TabDef<T>>;
  onChange: (next: T) => void;
  label: string;
  variant?: 'underline' | 'solid';
  className?: string;
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
  label,
  variant = 'underline',
  className,
}: TabsProps<T>) {
  const ref = useRef<HTMLDivElement>(null);

  const move = (dir: 1 | -1 | 'home' | 'end') => {
    const live = tabs.filter((t) => !t.disabled);
    if (!live.length) return;
    let next: TabDef<T>;
    if (dir === 'home') next = live[0];
    else if (dir === 'end') next = live[live.length - 1];
    else {
      const at = live.findIndex((t) => t.id === value);
      next = live[(at + dir + live.length) % live.length];
    }
    onChange(next.id);
    window.requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
    });
  };

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      className={`mg-tabs v-${variant}${className ? ` ${className}` : ''}`}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          move(-1);
        } else if (e.key === 'Home') {
          e.preventDefault();
          move('home');
        } else if (e.key === 'End') {
          e.preventDefault();
          move('end');
        }
      }}
    >
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`mg-tab-${t.id}`}
            aria-selected={on}
            aria-controls={`mg-tabpanel-${t.id}`}
            tabIndex={on ? 0 : -1}
            disabled={t.disabled}
            title={t.title}
            className={`mg-tab${on ? ' on' : ''}`}
            onClick={() => onChange(t.id)}
          >
            {t.icon && <Icon name={t.icon} size={15} weight={on ? 'fill' : 'regular'} />}
            <span className="mg-tab-l">{t.label}</span>
            {typeof t.count === 'number' && t.count > 0 && (
              <span className="mg-tab-count mono">{t.count}</span>
            )}
            {t.dot && <span className="mg-tab-dot" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

/** The body half of a Tabs pair; wires up the aria relationship. */
export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`mg-tabpanel-${id}`} aria-labelledby={`mg-tab-${id}`} className="mg-tabpanel">
      {children}
    </div>
  );
}
