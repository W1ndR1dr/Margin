/**
 * Toasts — bottom-centre, one line, self-dismissing (DESIGN.md).
 *
 * Presentational only: the queue lives in the app store so any module can
 * raise one without importing React. An `action` turns a toast into the undo
 * affordance DESIGN.md asks for.
 */
import { useEffect, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { MarginMark } from './MarginMark';

export type ToastKind = 'ok' | 'err' | 'info' | 'busy';

export interface ToastData {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  /** 0..1 while a job runs; drives the mark's ring sweep. */
  progress?: number | null;
  action?: { label: string; run: () => void };
  /** ms before it fades. 0 pins it until dismissed. */
  ttl?: number;
}

const ICON: Record<Exclude<ToastKind, 'busy'>, IconName> = {
  ok: 'checkCircle',
  err: 'warningCircle',
  info: 'info',
};

const DEFAULT_TTL: Record<ToastKind, number> = { ok: 4000, info: 4000, err: 9000, busy: 0 };

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastData[];
  onDismiss: (id: number) => void;
}) {
  useEffect(() => {
    const timers = toasts
      .map((t) => {
        const ttl = t.ttl ?? DEFAULT_TTL[t.kind];
        if (!ttl) return null;
        return window.setTimeout(() => onDismiss(t.id), ttl);
      })
      .filter((t): t is number => t !== null);
    return () => timers.forEach(window.clearTimeout);
  }, [toasts, onDismiss]);

  return (
    <div className="mg-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className={`mg-toast k-${t.kind}`} key={t.id}>
          <span className="mg-toast-ico">
            {t.kind === 'busy' ? (
              <MarginMark size={16} progress={t.progress ?? null} />
            ) : (
              <Icon name={ICON[t.kind]} size={16} weight="fill" />
            )}
          </span>
          <span className="mg-toast-text">
            <span className="mg-toast-title">{t.title}</span>
            {t.message && <span className="mg-toast-msg">{t.message}</span>}
          </span>
          {t.action && (
            <button type="button" className="mg-toast-action" onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            className="mg-toast-close"
            aria-label="Dismiss"
            onClick={() => onDismiss(t.id)}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** A calm inline banner for state that is not transient enough to be a toast. */
export function Banner({
  kind = 'info',
  icon,
  children,
  action,
}: {
  kind?: 'info' | 'ok' | 'warn' | 'err';
  icon?: IconName;
  children: ReactNode;
  action?: ReactNode;
}) {
  const fallback: IconName = kind === 'err' || kind === 'warn' ? 'warning' : 'info';
  return (
    <div className={`mg-banner k-${kind}`}>
      <Icon name={icon ?? fallback} size={15} />
      <div className="mg-banner-body">{children}</div>
      {action}
    </div>
  );
}
