/**
 * Drawer — the Ask Margin surface, and the shell for any panel that replaces
 * the right panel rather than floating over the image.
 *
 * UI-OVERHAUL.md §3: "Ask Margin drawer 460 px replaces the right panel when
 * open (Esc closes)". It is deliberately NOT a modal: the viewport stays live
 * and interactive behind it, because the whole point is to look at the image
 * while reading the answer. So: no scrim, no focus trap that blocks the
 * viewport, but Escape closes and focus moves in on open and back out on close.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './controls';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** One line under the title. */
  sub?: ReactNode;
  /** Pinned to the bottom, outside the scroll area — the Ask input lives here. */
  footer?: ReactNode;
  /** Extra controls in the header row, before the close button. */
  actions?: ReactNode;
  width?: number;
  children: ReactNode;
}

export function Drawer({ open, onClose, title, sub, footer, actions, width, children }: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    // Focus the first control inside so the keyboard lands where the user is
    // looking, without trapping — Tab can still walk back to the viewport.
    const first = ref.current?.querySelector<HTMLElement>(
      'input, textarea, button, [tabindex]:not([tabindex="-1"])',
    );
    window.setTimeout(() => first?.focus(), 30);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Let a nested popover eat Escape first; it stops propagation.
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      returnTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <aside
      ref={ref}
      className="mg-drawer"
      style={width ? { width } : undefined}
      role="complementary"
      aria-label={typeof title === 'string' ? title : 'Drawer'}
    >
      <header className="mg-drawer-head">
        <div className="mg-drawer-titles">
          <div className="mg-drawer-title">{title}</div>
          {sub !== undefined && <div className="mg-drawer-sub">{sub}</div>}
        </div>
        {actions}
        <Button tone="ghost" icon="close" iconOnly size="sm" aria-label="Close (Esc)" onClick={onClose} />
      </header>
      <div className="mg-drawer-body">{children}</div>
      {footer !== undefined && <footer className="mg-drawer-foot">{footer}</footer>}
    </aside>
  );
}

/**
 * Modal dialog — for the things that genuinely must be answered before the
 * app continues (import, shortcut sheet). Scrim, Escape, click-outside.
 */
export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  sub?: ReactNode;
  footer?: ReactNode;
  /** 'md' 520 px · 'lg' 780 px · 'xl' 980 px. */
  size?: 'md' | 'lg' | 'xl';
  children: ReactNode;
}

export function Modal({ open, onClose, title, sub, footer, size = 'md', children }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const first = ref.current?.querySelector<HTMLElement>(
      'input, textarea, button, [tabindex]:not([tabindex="-1"])',
    );
    window.setTimeout(() => first?.focus(), 30);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="mg-scrim center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className={`mg-modal s-${size}`} role="dialog" aria-modal="true">
        <header className="mg-modal-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mg-modal-title">{title}</div>
            {sub !== undefined && <div className="mg-modal-sub">{sub}</div>}
          </div>
          <Button tone="ghost" icon="close" iconOnly size="sm" aria-label="Close" onClick={onClose} />
        </header>
        <div className="mg-modal-body">{children}</div>
        {footer !== undefined && <footer className="mg-modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
