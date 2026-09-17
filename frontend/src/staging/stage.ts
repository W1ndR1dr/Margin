/**
 * `stage()` — the entry point. Runs one site's T, N, M and stage-group rules for
 * the clinical classification, again for the pathologic classification when
 * pathology is present, and reports the trace, the imaging/pathology conflicts
 * and the caveats that matter at the bedside.
 */

import { rulesFor } from './rules';
import { flattenNodes, observations, say, stageM } from './rules/common';
import { RULE_TABLE, sourcesFor } from './rules/ruleTable';
import type {
  Classification,
  Conflict,
  Observation,
  Observed,
  Site,
  StageResult,
  StagingContext,
  StagingInput,
} from './types';

/* ------------------------------------------------------------------ */
/* conflicts                                                           */
/* ------------------------------------------------------------------ */

function isObservation(v: unknown): v is Observation<unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    'value' in (v as Record<string, unknown>) &&
    'source' in (v as Record<string, unknown>)
  );
}

function asObserved(v: unknown): Observation<unknown>[] | undefined {
  if (isObservation(v)) return [v];
  if (Array.isArray(v) && v.length > 0 && v.every(isObservation)) {
    return v as Observation<unknown>[];
  }
  return undefined;
}

function describe(o: Observation<unknown>): string {
  const base =
    typeof o.value === 'boolean' ? (o.value ? 'present' : 'absent') : String(o.value);
  return o.note ? `${base} (${o.source}, ${o.note})` : `${base} (${o.source})`;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
}

function collectConflicts(record: object | undefined, prefix: string, out: Conflict[]): void {
  if (!record) return;
  for (const [key, raw] of Object.entries(record)) {
    const list = asObserved(raw);
    if (!list || list.length < 2) continue;
    const path = list.find((o) => o.source === 'pathology');
    const clin = list.find((o) => o.source !== 'pathology');
    if (!path || !clin) continue;
    if (sameValue(path.value, clin.value)) continue;
    out.push({
      field: `${prefix}${key}`,
      imaging: describe(clin),
      pathology: describe(path),
      note:
        `${clin.source} and pathology disagree. The clinical classification uses the ` +
        `${clin.source} value and the pathologic classification uses the pathology value.`,
    });
  }
}

/** Every imaging/exam vs pathology disagreement in the input. */
export function findConflicts(input: StagingInput): Conflict[] {
  const out: Conflict[] = [];
  collectConflicts(input.primary, 'primary.', out);
  collectConflicts(input.nodes, 'nodes.', out);
  collectConflicts(input.metastasis, 'metastasis.', out);
  (input.nodes?.nodes ?? []).forEach((node, i) => {
    collectConflicts(node, `nodes.nodes[${i}].`, out);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* warnings                                                            */
/* ------------------------------------------------------------------ */

function sourcesOf<T>(o: Observed<T> | undefined): Set<string> {
  return new Set(observations(o).map((obs) => obs.source));
}

/** Caveats that apply whatever the site. */
export function generalWarnings(input: StagingInput, site: Site): string[] {
  const out: string[] = [];

  const doiSources = sourcesOf(input.primary?.depth_of_invasion_mm);
  if (doiSources.has('imaging') && !doiSources.has('pathology')) {
    out.push(
      'Depth of invasion was taken from imaging: imaging DOI overestimates histologic DOI, so ' +
        'the clinical T may be higher than the pathologic T.',
    );
  }

  // Radiologic ENE is not clinical ENE (AJCC 8 is explicit about this).
  const eneSources = new Set<string>();
  for (const node of input.nodes?.nodes ?? []) {
    for (const s of sourcesOf(node.ene_clinical)) eneSources.add(s);
    for (const s of sourcesOf(node.ene_pathologic)) eneSources.add(s);
  }
  for (const s of sourcesOf(input.nodes?.ene_present)) eneSources.add(s);
  if (eneSources.has('imaging') && !eneSources.has('exam') && !eneSources.has('pathology')) {
    out.push(
      'Extranodal extension is recorded from imaging only: radiologic ENE is not cENE unless there ' +
        'are unequivocal clinical signs (skin invasion, muscle infiltration, dense tethering, nerve ' +
        'invasion with dysfunction). If in doubt, AJCC 8 says assign ENE(-).',
    );
  }

  // Which of the rules used here still need checking against the manual.
  const ids = rulesFor(site).ruleIds;
  const toVerify = RULE_TABLE.filter(
    (r) => ids.includes(r.id) && r.confidence === 'verify',
  ).map((r) => r.id);
  if (toVerify.length > 0) {
    out.push(
      `Rules applied here that are marked 'verify' in the rule table: ${toVerify.join(', ')}. ` +
        'See staging/README.md before relying on them.',
    );
  }

  const nodesKnown = flattenNodes(input, 'clinical').assessed;
  if (!nodesKnown) {
    out.push('No nodal information supplied, so the N category is NX and no stage group is assigned.');
  }
  if (!input.metastasis?.m1) {
    out.push('No distant-metastasis descriptor supplied; M0 was assumed.');
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* one classification                                                  */
/* ------------------------------------------------------------------ */

function classify(site: Site, input: StagingInput, context: StagingContext): Classification {
  const rules = rulesFor(site);
  const t = rules.stageT(input, context);
  const n = rules.stageN(input, context);
  const m = stageM(input, context);
  const g = rules.stageGroup(t.category, n.category, m.category, input.patient, context);
  const header = say(
    context === 'pathologic' ? 'Pathologic classification' : 'Clinical classification',
    `${rules.label} (AJCC 8)`,
  );
  return {
    T: t.category,
    N: n.category,
    M: m.category,
    group: g.group,
    trace: [header, ...t.trace, ...n.trace, ...m.trace, ...g.trace],
  };
}

/* ------------------------------------------------------------------ */
/* stage()                                                             */
/* ------------------------------------------------------------------ */

/** The p16 counterpart chapter, for an oropharyngeal primary with no p16 result. */
function p16Counterpart(site: Site): Site | undefined {
  if (site === 'oropharynx_p16pos') return 'oropharynx_p16neg';
  if (site === 'oropharynx_p16neg') return 'oropharynx_p16pos';
  return undefined;
}

export function stage(site: Site, input: StagingInput): StageResult {
  const rules = rulesFor(site);
  const clinical = classify(site, input, 'clinical');
  const pathologic = input.contextPathologic ? classify(site, input, 'pathologic') : undefined;

  const warnings = [
    ...(rules.warnings ? rules.warnings(input) : []),
    ...generalWarnings(input, site),
  ];

  let alternate: StageResult['alternate'];
  const counterpart = p16Counterpart(site);
  const p16 = input.patient?.p16;
  if (counterpart && (!p16 || p16 === 'unknown')) {
    const altRules = rulesFor(counterpart);
    alternate = {
      site: counterpart,
      label: altRules.label,
      clinical: classify(counterpart, input, 'clinical'),
      pathologic: input.contextPathologic ? classify(counterpart, input, 'pathologic') : undefined,
    };
    warnings.push(
      `Both oropharyngeal chapters were computed because p16 is unknown: ${rules.label} gives ` +
        `${clinical.T} ${clinical.N} ${clinical.M}, stage ${clinical.group}; ${altRules.label} gives ` +
        `${alternate.clinical.T} ${alternate.clinical.N} ${alternate.clinical.M}, stage ` +
        `${alternate.clinical.group}.`,
    );
  }

  return {
    site,
    clinical,
    pathologic,
    conflicts: findConflicts(input),
    warnings: Array.from(new Set(warnings)),
    sources: sourcesFor(rules.ruleIds),
    alternate,
  };
}

export default stage;
