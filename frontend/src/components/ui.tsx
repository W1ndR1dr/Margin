import { useEffect, useRef, useState, type ReactNode } from 'react';

/* ---------------- brand mark (mirrors public/icon-mono.svg) ---------------- */

export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className="brand-mark"
      aria-hidden
    >
      <path
        d="M22.55 12.48 Q24.7 16 22.49 19.44 Q20.29 22.87 16.05 23.37 Q11.82 23.86 9.81 20.07 Q7.8 16.29 9.88 12.35 Q11.96 8.41 16.18 8.69 Q20.4 8.96 22.55 12.48 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeOpacity=".85"
      />
      <path
        d="M20.87 13.41 Q22.5 16 20.81 18.5 Q19.13 21 15.99 21.46 Q12.85 21.92 11.43 19.07 Q10 16.21 11.5 13.28 Q13 10.35 16.12 10.59 Q19.23 10.83 20.87 13.41 Z"
        fill="currentColor"
      />
      <path d="M20.3 19.6 L23.3 22.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeOpacity=".7" />
    </svg>
  );
}

/* ---------------- popover ---------------- */

export function Popover({
  trigger,
  children,
  placement = 'below',
  disabled,
}: {
  trigger: (open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: 'below' | 'below-right' | 'side';
  disabled?: boolean;
}) {
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
    <div className="pop-anchor" ref={ref}>
      <div onClick={() => !disabled && setOpen((v) => !v)}>{trigger(open)}</div>
      {open && !disabled && (
        <div className={`pop ${placement}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function PopItem({
  on,
  main,
  sub,
  onClick,
}: {
  on?: boolean;
  main: ReactNode;
  sub?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className={`pop-item${on ? ' on' : ''}`} onClick={onClick} role="menuitem">
      <span className="main">{main}</span>
      {sub !== undefined && <span className="sub">{sub}</span>}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

/** Rail tooltip: "Name · hotkey" */
export function Tip({ label, hotkey }: { label: string; hotkey?: string }) {
  return (
    <span className="tip">
      {label}
      {hotkey && <span className="k">{hotkey}</span>}
    </span>
  );
}
