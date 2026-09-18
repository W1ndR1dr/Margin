/**
 * Ask Margin — the transport.
 *
 * Everything that would ever leave this machine goes through `askMargin`, and
 * nothing else in the app may call out. That is the whole point of keeping it
 * in one function: the "Sent to Claude" disclosure box under every answer
 * (UI-OVERHAUL.md §2, never omitted) is built from the SAME `AskContext`
 * object that the transport receives, so the box cannot drift from the truth.
 *
 * Today it is a local stub that answers "Ask Margin is not connected yet".
 * When the Agent SDK backend lands (ROADMAP.md item 17) only `send()` below
 * changes: the request shape, the disclosure and the whole drawer stay put.
 *
 * Hard rule, enforced by construction: `AskContext` has no field that can
 * carry pixels, a patient name, an MRN, a UID or a date. It carries structure
 * names, derived numbers and the question. If a future field would break that,
 * it does not belong in this type.
 */
import type { Finding } from '../../findings';

/* ------------------------------------------------------------------ */
/* what may leave the machine                                          */
/* ------------------------------------------------------------------ */

/** One measured number, named. No identifiers, ever. */
export interface AskFact {
  label: string;
  value: string;
  unit?: string;
}

export interface AskContext {
  /** The question, verbatim. */
  question: string;
  /** 'CT' / 'MR' — the kind of scan, not which scan. */
  modality: string | null;
  /** e.g. 'T1 +C'. Null for CT. */
  sequence: string | null;
  /** Structure names that are loaded, e.g. 'common_carotid_artery_right'. */
  structures: string[];
  /** Derived numbers already on screen. */
  facts: AskFact[];
  /** Findings, as their statement text plus severity. No coordinates. */
  findings: Array<{ title: string; statement: string; severity: string }>;
}

/**
 * Exactly what the disclosure box prints. Derived from the context, never
 * hand-written at the call site, so the box is always the real payload.
 */
export function disclosureLines(ctx: AskContext): string[] {
  const lines: string[] = [];
  lines.push(`Your question: “${ctx.question}”`);
  if (ctx.modality) {
    lines.push(`Scan type: ${ctx.modality}${ctx.sequence ? ` · ${ctx.sequence}` : ''}`);
  }
  if (ctx.structures.length) {
    const shown = ctx.structures.slice(0, 8).join(', ');
    lines.push(
      `Structure names (${ctx.structures.length}): ${shown}${
        ctx.structures.length > 8 ? `, +${ctx.structures.length - 8} more` : ''
      }`,
    );
  }
  if (ctx.facts.length) {
    lines.push(
      `Measurements (${ctx.facts.length}): ${ctx.facts
        .slice(0, 6)
        .map((f) => `${f.label} ${f.value}${f.unit ?? ''}`)
        .join(' · ')}`,
    );
  }
  if (ctx.findings.length) lines.push(`Findings already on screen: ${ctx.findings.length} statements`);
  lines.push('Not sent: images, patient name, MRN, dates, UIDs, file paths.');
  return lines;
}

/* ------------------------------------------------------------------ */
/* what comes back                                                     */
/* ------------------------------------------------------------------ */

export interface AskTile {
  value: string;
  unit?: string;
  label: string;
  severity?: 'ok' | 'caution' | 'danger' | 'info';
}

/** The rule the answer applied, and where the rule comes from. */
export interface AskCriterion {
  text: string;
  source: string;
}

export type AskActionKind = 'add-to-report' | 'step-slices' | 'open-findings' | 'run-tool';

export interface AskAction {
  kind: AskActionKind;
  label: string;
  /** Free-form payload the drawer interprets (a tool id, a finding id, …). */
  arg?: string;
}

export interface AskAnswer {
  /** Paragraphs. Rendered as-is; the transport does no markdown. */
  paragraphs: string[];
  tiles: AskTile[];
  criterion: AskCriterion | null;
  actions: AskAction[];
  /** Follow-up chips under the answer. */
  suggestions: string[];
  /** True when this came from the stub rather than a real model. */
  stub: boolean;
}

/* ------------------------------------------------------------------ */
/* the single call site                                                */
/* ------------------------------------------------------------------ */

export type AskTransport = (ctx: AskContext, signal?: AbortSignal) => Promise<AskAnswer>;

/**
 * The stub. Deliberately useful rather than a dead end: it says plainly that
 * the model is not wired up, and then shows the numbers Margin already holds,
 * so the drawer's evidence-tile layout is exercised with real data and the
 * user still gets something out of asking.
 */
const stubTransport: AskTransport = async (ctx) => {
  const tiles: AskTile[] = ctx.facts.slice(0, 4).map((f) => ({
    value: f.value,
    unit: f.unit,
    label: f.label,
  }));

  const paragraphs = [
    'Ask Margin is not connected yet. The conversation layer (Claude Agent SDK driving Margin’s own tools) is on the roadmap; nothing has been sent anywhere.',
  ];

  if (ctx.facts.length) {
    paragraphs.push(
      `What Margin already measured on this study is below. Every one of these numbers came from a tool you ran locally — click a finding in the right panel to jump to the slice it came from.`,
    );
  } else {
    paragraphs.push(
      'Nothing has been measured on this study yet. Run the carotid or airway tool, or segment anatomy, and those numbers will appear here.',
    );
  }

  return {
    paragraphs,
    tiles,
    criterion: null,
    actions: ctx.findings.length ? [{ kind: 'open-findings', label: 'Open Findings' }] : [],
    suggestions: [
      'How much carotid contact is there?',
      'Is the airway narrowed?',
      'What structures are loaded?',
      'Summarise the findings',
    ],
    stub: true,
  };
};

let transport: AskTransport = stubTransport;

/** Swap the transport (the Agent SDK backend, or a test double). */
export function setAskTransport(next: AskTransport | null): void {
  transport = next ?? stubTransport;
}

/** True while the stub is in place — the drawer says so in its header. */
export function isAskStubbed(): boolean {
  return transport === stubTransport;
}

/** The one function that talks to the outside world. */
export function askMargin(ctx: AskContext, signal?: AbortSignal): Promise<AskAnswer> {
  return transport(ctx, signal);
}

/* ------------------------------------------------------------------ */
/* context assembly                                                    */
/* ------------------------------------------------------------------ */

export interface ContextSources {
  modality: string | null;
  sequence: string | null;
  structureNames: string[];
  findings: Finding[];
  measurements: Array<{ toolName: string; value: string; extra: string }>;
}

/**
 * Build the payload from what is on screen. Kept here, next to the type, so
 * there is exactly one place where a new field could sneak in — and one place
 * to audit that nothing identifying does.
 */
export function buildAskContext(question: string, src: ContextSources): AskContext {
  const facts: AskFact[] = [];

  for (const f of src.findings) {
    for (const m of f.metrics) {
      facts.push({ label: `${f.title} — ${m.label}`, value: m.value, unit: m.unit });
    }
  }
  for (const m of src.measurements) {
    facts.push({ label: m.toolName, value: m.value, unit: undefined });
  }

  return {
    question,
    modality: src.modality,
    sequence: src.sequence,
    structures: src.structureNames,
    facts: facts.slice(0, 40),
    findings: src.findings.map((f) => ({
      title: f.title,
      statement: f.statement.map((p) => p.text).join(''),
      severity: f.severity,
    })),
  };
}
