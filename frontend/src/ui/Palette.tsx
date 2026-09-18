/**
 * The command palette — a generic, fuzzy-matching command surface.
 *
 * Kept free of app state on purpose: callers hand it a flat list of
 * `PaletteItem`s (tools, presets, patients, series, actions) and it does the
 * matching, grouping, keyboard handling and rendering. That is what lets
 * UI-OVERHAUL.md §8 ("palette fuzzy-matches patients and series too") be a
 * one-line change at the call site rather than a rewrite here.
 *
 * Matching is subsequence-based with a score, not `includes`: typing "carenc"
 * finds "Carotid encasement", and "hn3" finds "HANSEG case 03". Consecutive
 * matches, word-start matches and matches in the label (rather than the group)
 * all score higher, so the obvious answer lands first.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Kbd } from './controls';

export interface PaletteItem {
  id: string;
  /** Section heading in the list, e.g. 'Tool', 'Patient', 'Window'. */
  group: string;
  label: string;
  /** Right-aligned detail: a hotkey, a date, a modality. */
  detail?: string;
  /** Extra text that matches but is never displayed (MRN, UID, synonyms). */
  keywords?: string;
  icon?: IconName;
  swatch?: string;
  run: () => void;
}

/* ------------------------------------------------------------------ */
/* fuzzy matching                                                     */
/* ------------------------------------------------------------------ */

export interface FuzzyHit {
  score: number;
  /** Indices in the haystack that matched, for highlighting. */
  hits: number[];
}

/**
 * Subsequence match with a score. Returns null when `needle` is not a
 * subsequence of `haystack` (case-insensitive).
 *
 * Scoring, highest first: a match right after a separator or at the start
 * (word boundary, +12), a match immediately after the previous one (+8), any
 * other match (+1); every skipped character costs 1, capped so a long label is
 * not punished into oblivion.
 */
export function fuzzyScore(haystack: string, needle: string): FuzzyHit | null {
  if (!needle) return { score: 0, hits: [] };
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const hits: number[] = [];
  let score = 0;
  let hi = 0;
  let prev = -2;

  for (let ni = 0; ni < n.length; ni++) {
    const ch = n[ni];
    if (ch === ' ') continue;
    let found = -1;
    for (let i = hi; i < h.length; i++) {
      if (h[i] === ch) {
        found = i;
        break;
      }
    }
    if (found < 0) return null;
    const before = found > 0 ? h[found - 1] : ' ';
    const boundary = found === 0 || before === ' ' || before === '_' || before === '-' || before === '/';
    if (found === prev + 1) score += 8;
    else if (boundary) score += 12;
    else score += 1;
    score -= Math.min(found - hi, 6);
    hits.push(found);
    prev = found;
    hi = found + 1;
  }
  // Shorter haystacks win ties: "Pan" beats "Expand" for "pan".
  score -= Math.min(h.length / 12, 6);
  return { score, hits };
}

/** Score one item; the label is worth more than the group or the keywords. */
function scoreItem(item: PaletteItem, q: string): number | null {
  if (!q) return 0;
  const label = fuzzyScore(item.label, q);
  const group = fuzzyScore(`${item.group} ${item.label}`, q);
  const keys = item.keywords ? fuzzyScore(item.keywords, q) : null;
  const best = Math.max(
    label ? label.score + 20 : Number.NEGATIVE_INFINITY,
    group ? group.score : Number.NEGATIVE_INFINITY,
    keys ? keys.score - 4 : Number.NEGATIVE_INFINITY,
  );
  return Number.isFinite(best) ? best : null;
}

/** Exported for tests and for the Library's own search box. */
export function filterPalette(items: PaletteItem[], q: string, limit = 60): PaletteItem[] {
  const query = q.trim();
  if (!query) return items.slice(0, limit);
  const scored: Array<{ item: PaletteItem; score: number }> = [];
  for (const item of items) {
    const s = scoreItem(item, query);
    if (s !== null) scored.push({ item, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}

/* ------------------------------------------------------------------ */
/* the component                                                      */
/* ------------------------------------------------------------------ */

export interface PaletteProps {
  open: boolean;
  onClose: () => void;
  items: PaletteItem[];
  placeholder?: string;
  /** Shown when the query matches nothing. */
  empty?: ReactNode;
}

export function Palette({ open, onClose, items, placeholder, empty }: PaletteProps) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => filterPalette(items, q), [items, q]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setCursor(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => setCursor(0), [q]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('.mg-palette-item.cur')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor, matches]);

  if (!open) return null;

  const runAt = (i: number) => {
    const c = matches[i];
    if (!c) return;
    onClose();
    // Run after the close so a command that opens another overlay is not
    // immediately closed by this one's teardown.
    window.setTimeout(() => c.run(), 0);
  };

  let lastGroup: string | null = null;

  return (
    <div
      className="mg-scrim top"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mg-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="mg-palette-input">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={q}
            placeholder={placeholder ?? 'Search…'}
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded
            aria-controls="mg-palette-list"
            aria-activedescendant={matches[cursor] ? `mg-pal-${matches[cursor].id}` : undefined}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, matches.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === 'Home') {
                e.preventDefault();
                setCursor(0);
              } else if (e.key === 'End') {
                e.preventDefault();
                setCursor(Math.max(0, matches.length - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                runAt(cursor);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <Kbd>esc</Kbd>
        </div>

        <div className="mg-palette-list" id="mg-palette-list" role="listbox" ref={listRef}>
          {matches.length === 0 && (
            <div className="mg-palette-empty">{empty ?? <>Nothing matches “{q}”.</>}</div>
          )}
          {matches.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {head && <div className="mg-palette-group">{head}</div>}
                <button
                  type="button"
                  id={`mg-pal-${c.id}`}
                  role="option"
                  aria-selected={i === cursor}
                  className={`mg-palette-item${i === cursor ? ' cur' : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => runAt(i)}
                >
                  {c.swatch !== undefined ? (
                    <span className="mg-palette-sw" style={{ background: c.swatch }} aria-hidden />
                  ) : (
                    <Icon name={c.icon ?? 'caretRight'} size={14} />
                  )}
                  <span className="main">{c.label}</span>
                  {c.detail && <span className="detail mono">{c.detail}</span>}
                </button>
              </div>
            );
          })}
        </div>

        <div className="mg-palette-foot">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>⏎</Kbd> run
          </span>
          <span className="mg-palette-count mono">
            {matches.length} of {items.length}
          </span>
        </div>
      </div>
    </div>
  );
}
