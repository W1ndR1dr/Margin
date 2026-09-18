/**
 * Ask Margin — the 460 px drawer (UI-OVERHAUL.md §3).
 *
 * "user bubbles right, answers left with evidence tiles, criterion line with
 *  source, action buttons, disclosure box, suggestion chips, input at bottom."
 *
 * The disclosure box is not optional and not collapsible-by-default: the whole
 * privacy promise of this product is that the user can see, for every single
 * question, exactly what left the machine. It is rendered from the turn's own
 * stored payload, so scrolling back shows what was sent *then*.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button, Chip, Drawer, Icon, MarginMark, Tile, TileRow } from '../../ui';
import { useAppStore } from '../../store/useAppStore';
import { useStructureStore } from '../../labels/structureStore';
import { deriveFindings } from '../../findings';
import { inferSequenceKind, normaliseModality, SEQUENCE_LABEL } from '../../viewer/modality';
import { useCarotidStore } from '../carotid';
import { useAirwayStore } from '../airway';
import { ask, askIsStubbed, resetAsk, useAskStore, type AskTurn } from './askStore';
import type { AskAction } from './transport';
import './ask.css';

const SEVERITY_TONE = {
  ok: 'ok',
  caution: 'caution',
  danger: 'danger',
  info: 'info',
} as const;

function Disclosure({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={`ask-disc${open ? ' open' : ''}`}>
      <button type="button" className="ask-disc-head" onClick={() => setOpen((v) => !v)}>
        <Icon name="shieldCheck" size={13} weight="fill" />
        <span>Sent to Claude</span>
        <Icon name={open ? 'caretDown' : 'caretRight'} size={12} />
      </button>
      {open && (
        <ul className="ask-disc-body">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Turn({ turn, onAction }: { turn: AskTurn; onAction: (a: AskAction) => void }) {
  const a = turn.answer;
  return (
    <div className="ask-turn">
      <div className="ask-q">{turn.question}</div>

      {!a && !turn.error && (
        <div className="ask-thinking">
          <MarginMark size={17} progress={null} />
          <span>Working…</span>
        </div>
      )}

      {turn.error && (
        <div className="ask-a err">
          <Icon name="warningCircle" size={15} />
          {turn.error}
        </div>
      )}

      {a && (
        <div className="ask-a">
          {a.paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}

          {a.tiles.length > 0 && (
            <TileRow className="ask-tiles">
              {a.tiles.map((t, i) => (
                <Tile
                  key={i}
                  size="sm"
                  value={t.value}
                  unit={t.unit}
                  label={t.label}
                  severity={t.severity ? SEVERITY_TONE[t.severity] : undefined}
                />
              ))}
            </TileRow>
          )}

          {a.criterion && (
            <div className="ask-crit">
              <Icon name="bracket" size={13} />
              <span className="t">{a.criterion.text}</span>
              <span className="s">{a.criterion.source}</span>
            </div>
          )}

          {a.actions.length > 0 && (
            <div className="ask-actions">
              {a.actions.map((act, i) => (
                <Button key={i} size="sm" onClick={() => onAction(act)}>
                  {act.label}
                </Button>
              ))}
            </div>
          )}

          <Disclosure lines={turn.disclosure} />

          {a.suggestions.length > 0 && (
            <div className="ask-sugg">
              {a.suggestions.map((s) => (
                <Chip key={s} size="sm" onClick={() => useAskStore.getState().set({ draft: s })}>
                  {s}
                </Chip>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AskDrawer() {
  const open = useAppStore((s) => s.askOpen);
  const set = useAppStore((s) => s.set);
  const series = useAppStore((s) => s.activeSeries);
  const measurements = useAppStore((s) => s.measurements);
  const structures = useStructureStore((s) => s.items);
  const carotid = useCarotidStore((s) => s.result);
  const airwayResult = useAirwayStore((s) => s.result);
  const airwayGlottis = useAirwayStore((s) => s.glottisSlice);

  const turns = useAskStore((s) => s.turns);
  const busy = useAskStore((s) => s.busy);
  const draft = useAskStore((s) => s.draft);
  const setAsk = useAskStore((s) => s.set);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const modality = normaliseModality(series?.modality);
  const sequenceKind = series ? inferSequenceKind(series) : null;

  const findings = useMemo(
    () =>
      deriveFindings({
        modality: series?.modality ?? null,
        sequenceKind,
        carotid,
        airway: airwayResult,
        airwayGlottisMarked: airwayGlottis !== null,
        structures,
        measurements,
      }),
    [series, sequenceKind, carotid, airwayResult, airwayGlottis, structures, measurements],
  );

  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, open]);

  const send = () => {
    const q = draft.trim();
    if (!q || busy) return;
    void ask(q, {
      modality: modality === 'OT' ? null : modality,
      sequence: sequenceKind ? SEQUENCE_LABEL[sequenceKind] : null,
      structureNames: structures.map((s) => s.name),
      findings,
      measurements: measurements.map((m) => ({
        toolName: m.toolName,
        value: m.value,
        extra: m.extra,
      })),
    });
  };

  const onAction = (a: AskAction) => {
    if (a.kind === 'open-findings') {
      set({ askOpen: false, panelOpen: true, panelTab: 'findings' });
    } else if (a.kind === 'add-to-report') {
      set({ panelOpen: true, panelTab: 'report' });
    }
  };

  if (!open) return null;

  const stubbed = askIsStubbed();

  return (
    <Drawer
      open={open}
      onClose={() => set({ askOpen: false })}
      title={
        <>
          <MarginMark size={15} />
          Ask Margin
        </>
      }
      sub={
        stubbed
          ? 'Not connected yet — answers come from a local stub. Nothing leaves this machine.'
          : 'Structure names and measurements only. Never pixels or identifiers.'
      }
      actions={
        turns.length > 0 ? (
          <Button tone="ghost" size="sm" icon="trash" iconOnly aria-label="Clear conversation" onClick={resetAsk} />
        ) : undefined
      }
      footer={
        <div className="ask-input">
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            placeholder="Ask about this study…"
            spellCheck={false}
            onChange={(e) => setAsk({ draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <Button
            tone="primary"
            icon="send"
            iconOnly
            aria-label="Send"
            disabled={!draft.trim()}
            busy={busy}
            onClick={send}
          />
        </div>
      }
    >
      <div className="ask-scroll" ref={scrollRef}>
        {turns.length === 0 && (
          <div className="ask-empty">
            <MarginMark size={30} />
            <h3>Ask about what is on screen</h3>
            <p>
              Margin answers from the structures and measurements it already holds. Images and
              identifiers never leave this machine — every answer says exactly what was sent.
            </p>
            <div className="ask-sugg">
              {[
                'How much carotid contact is there?',
                'Is the airway narrowed?',
                'Summarise the findings',
                'What structures are loaded?',
              ].map((s) => (
                <Chip key={s} size="sm" onClick={() => setAsk({ draft: s })}>
                  {s}
                </Chip>
              ))}
            </div>
          </div>
        )}
        {turns.map((t) => (
          <Turn key={t.id} turn={t} onAction={onAction} />
        ))}
      </div>
    </Drawer>
  );
}
