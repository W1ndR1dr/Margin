/**
 * Ask Margin — the conversation state.
 *
 * Deliberately thin: the drawer renders turns, the transport answers them, and
 * nothing here knows how the answer is produced. A turn keeps its own
 * disclosure lines so scrolling back always shows what was sent for THAT
 * question, not for the latest one.
 */
import { create } from 'zustand';

import { useAppStore } from '../../store/useAppStore';
import {
  askMargin,
  buildAskContext,
  disclosureLines,
  isAskStubbed,
  type AskAnswer,
  type AskContext,
  type ContextSources,
} from './transport';

export interface AskTurn {
  id: number;
  question: string;
  /** null while in flight. */
  answer: AskAnswer | null;
  error: string | null;
  /** Exactly what left the machine for this turn. Never omitted. */
  disclosure: string[];
  at: number;
}

interface AskState {
  turns: AskTurn[];
  busy: boolean;
  draft: string;
  set: (patch: Partial<AskState>) => void;
}

export const useAskStore = create<AskState>((set) => ({
  turns: [],
  busy: false,
  draft: '',
  set: (patch) => set(patch),
}));

let seq = 0;
let inflight: AbortController | null = null;

export function askIsStubbed(): boolean {
  return isAskStubbed();
}

/** Clear the conversation (new study, or the user asked). */
export function resetAsk(): void {
  inflight?.abort();
  inflight = null;
  useAskStore.getState().set({ turns: [], busy: false, draft: '' });
}

/**
 * Send a question. `sources` is gathered by the drawer from the live stores;
 * passing it in rather than reading them here keeps this module free of the
 * findings/structure imports and makes it testable.
 */
export async function ask(question: string, sources: ContextSources): Promise<void> {
  const q = question.trim();
  if (!q) return;
  const store = useAskStore.getState();
  if (store.busy) return;

  const ctx: AskContext = buildAskContext(q, sources);
  const turn: AskTurn = {
    id: ++seq,
    question: q,
    answer: null,
    error: null,
    disclosure: disclosureLines(ctx),
    at: Date.now(),
  };
  store.set({ turns: [...store.turns, turn], busy: true, draft: '' });

  inflight?.abort();
  inflight = new AbortController();

  try {
    const answer = await askMargin(ctx, inflight.signal);
    patch(turn.id, { answer });
  } catch (e) {
    patch(turn.id, { error: (e as Error)?.message ?? String(e) });
  } finally {
    inflight = null;
    useAskStore.getState().set({ busy: false });
  }
}

function patch(id: number, p: Partial<AskTurn>): void {
  const s = useAskStore.getState();
  s.set({ turns: s.turns.map((t) => (t.id === id ? { ...t, ...p } : t)) });
}

// A conversation is about one study.
useAppStore.subscribe((s, prev) => {
  if (s.activeSeries?.series_uid !== prev.activeSeries?.series_uid) resetAsk();
});
