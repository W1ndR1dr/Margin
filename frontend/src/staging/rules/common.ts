/**
 * Shared machinery for every site: observation resolution, trace sentences, the
 * regional-node tables that most head & neck chapters share, and the standard
 * head & neck stage grouping.
 *
 * Sources are listed in `ruleTable.ts`; rule ids appear here as `// rule:<id>`.
 */

import type {
  BoolObs,
  CategoryResult,
  GroupResult,
  MCategory,
  NCategory,
  NodeRecord,
  NodeSide,
  NumObs,
  Observation,
  Observed,
  Provenance,
  StagingContext,
  StagingInput,
  TCategory,
} from '../types';

/* ------------------------------------------------------------------ */
/* observation resolution                                              */
/* ------------------------------------------------------------------ */

/** Normalise `Observed<T>` to an array. `undefined` becomes `[]`. */
export function observations<T>(o: Observed<T> | undefined): Observation<T>[] {
  if (o === undefined) return [];
  return Array.isArray(o) ? o : [o];
}

/** Sources a clinical classification may read, most trusted first. */
export const CLINICAL_PRIORITY: readonly Provenance[] = ['exam', 'imaging', 'clinical'];

/** Sources a pathologic classification may read, most trusted first. */
export const PATHOLOGIC_PRIORITY: readonly Provenance[] = [
  'pathology',
  'exam',
  'imaging',
  'clinical',
];

/**
 * Pick the observation a given classification should use.
 *
 * A clinical classification never reads a pathology-sourced observation: cTNM
 * is what was known before treatment. A pathologic classification prefers
 * pathology and falls back to the clinical descriptors for anything the
 * specimen cannot show (carotid encasement, for instance).
 */
export function resolve<T>(
  o: Observed<T> | undefined,
  context: StagingContext,
): Observation<T> | undefined {
  const list = observations(o);
  if (list.length === 0) return undefined;
  const priority = context === 'pathologic' ? PATHOLOGIC_PRIORITY : CLINICAL_PRIORITY;
  for (const source of priority) {
    const hit = list.find((obs) => obs.source === source);
    if (hit) return hit;
  }
  return undefined;
}

/** Resolved number, or `undefined`. */
export function num(o: NumObs | undefined, context: StagingContext): Observation<number> | undefined {
  return resolve(o, context);
}

/** Resolved boolean that is `true`, or `undefined`. Absent and false both read as "not present". */
export function flag(
  o: BoolObs | undefined,
  context: StagingContext,
): Observation<boolean> | undefined {
  const hit = resolve(o, context);
  return hit && hit.value === true ? hit : undefined;
}

/** True when the descriptor was explicitly observed as `false`. */
export function negated(o: BoolObs | undefined, context: StagingContext): boolean {
  const hit = resolve(o, context);
  return hit !== undefined && hit.value === false;
}

/* ------------------------------------------------------------------ */
/* trace sentences                                                     */
/* ------------------------------------------------------------------ */

/**
 * One trace line: `"T4a: cortical mandible invasion (imaging)"`.
 * The provenance is always shown, because half the point of the trace is
 * letting the surgeon see which descriptor drove the category and who said it.
 */
export function say(category: string, reason: string, obs?: Observation<unknown>): string {
  if (!obs) return `${category}: ${reason}`;
  const note = obs.note ? `, ${obs.note}` : '';
  return `${category}: ${reason} (${obs.source}${note})`;
}

/** `"3.2 cm"` / `"6 mm"`, trimmed of trailing zeros. */
export function fmtNum(value: number, unit: string): string {
  const s = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
  return `${s} ${unit}`;
}

/** First descriptor in `candidates` that is present, with its trace phrase. */
export interface FlagHit {
  phrase: string;
  obs: Observation<boolean>;
}

/** Look through `[descriptor, phrase]` pairs and return the first that is true. */
export function firstFlag(
  pairs: Array<[BoolObs | undefined, string]>,
  context: StagingContext,
): FlagHit | undefined {
  for (const [obs, phrase] of pairs) {
    const hit = flag(obs, context);
    if (hit) return { phrase, obs: hit };
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* nodes                                                               */
/* ------------------------------------------------------------------ */

/** A node flattened to plain values for one classification context. */
export interface FlatNode {
  side: NodeSide;
  size_cm?: number;
  sizeSource?: Provenance;
  level?: string;
  ene: boolean;
  eneSource?: Provenance;
  eneExtentMm?: number;
  retropharyngeal: boolean;
  belowCricoid: boolean;
}

export interface FlatNodes {
  /** `false` when nothing at all is known about the neck -> NX. */
  assessed: boolean;
  nodes: FlatNode[];
  countPositive?: number;
  countExamined?: number;
  /** Any ENE among the nodes for this context. */
  anyEne: boolean;
  /** Provenance of the ENE that was used, for the trace. */
  eneSource?: Provenance;
  /** Largest node, cm. */
  maxSize?: number;
  maxSizeSource?: Provenance;
  ipsilateralCount: number;
  contralateralPresent: boolean;
  bilateralPresent: boolean;
  anyRetropharyngeal: boolean;
  anyBelowCricoid: boolean;
}

/**
 * Flatten `input.nodes` for one context. When only aggregate counts are
 * available (the usual CAP synoptic case) synthetic nodes are materialised from
 * `count_positive`, `largest_metastasis_cm`, `laterality` and `ene_present`, so
 * the same N tables work either way.
 */
export function flattenNodes(input: StagingInput, context: StagingContext): FlatNodes {
  const src = input.nodes;
  const empty: FlatNodes = {
    assessed: false,
    nodes: [],
    anyEne: false,
    ipsilateralCount: 0,
    contralateralPresent: false,
    bilateralPresent: false,
    anyRetropharyngeal: false,
    anyBelowCricoid: false,
  };
  if (!src) return empty;

  const countPositive = num(src.count_positive, context);
  const countExamined = num(src.count_examined, context);
  const largest = num(src.largest_metastasis_cm, context);
  const aggEne = resolve(src.ene_present, context);
  const aggEneExtent = num(src.ene_extent_mm, context);

  let records: NodeRecord[] = src.nodes ?? [];
  const haveList = src.nodes !== undefined;

  // No per-node list but a positive count: synthesise nodes so the size / ENE /
  // laterality tables can still run.
  if (!haveList && countPositive && countPositive.value > 0) {
    const side: NodeSide = src.laterality ?? 'ipsilateral';
    records = Array.from({ length: Math.max(1, Math.round(countPositive.value)) }, (_, i) => ({
      side,
      size_cm: i === 0 && largest ? { value: largest.value, source: largest.source } : undefined,
      ene_pathologic: aggEne ? { value: aggEne.value, source: aggEne.source } : undefined,
      ene_clinical: aggEne ? { value: aggEne.value, source: aggEne.source } : undefined,
      ene_extent_mm: aggEneExtent
        ? { value: aggEneExtent.value, source: aggEneExtent.source }
        : undefined,
    }));
  }

  const aggregatesKnown =
    countPositive !== undefined ||
    countExamined !== undefined ||
    largest !== undefined ||
    aggEne !== undefined;
  if (!haveList && !aggregatesKnown && records.length === 0) return empty;

  /**
   * A node is only visible to a classification if at least one of its
   * descriptors resolves in that context: a node known solely from the
   * resection specimen must not leak into the clinical classification.
   */
  const visible = (r: NodeRecord): boolean =>
    resolve(r.size_cm, context) !== undefined ||
    resolve(r.level, context) !== undefined ||
    resolve(r.ene_clinical, context) !== undefined ||
    resolve(r.ene_pathologic, context) !== undefined ||
    resolve(r.ene_extent_mm, context) !== undefined ||
    resolve(r.retropharyngeal, context) !== undefined ||
    resolve(r.midline, context) !== undefined ||
    resolve(r.below_cricoid, context) !== undefined;

  const visibleRecords = records.filter(visible);
  const assessed =
    aggregatesKnown || visibleRecords.length > 0 || (haveList && records.length === 0);
  if (!assessed) return empty;
  records = visibleRecords;

  const nodes: FlatNode[] = records.map((r) => {
    const size = num(r.size_cm, context);
    const level = resolve(r.level, context);
    // Clinical ENE must be clinically overt; pathologic staging accepts either,
    // with the histologic finding preferred.
    const eneObs =
      context === 'pathologic'
        ? (resolve(r.ene_pathologic, context) ?? resolve(r.ene_clinical, context))
        : resolve(r.ene_clinical, context);
    const extent = num(r.ene_extent_mm, context);
    return {
      side: r.side ?? src.laterality ?? 'ipsilateral',
      size_cm: size?.value,
      sizeSource: size?.source,
      level: level?.value,
      ene: eneObs?.value === true,
      eneSource: eneObs?.value === true ? eneObs.source : undefined,
      eneExtentMm: extent?.value,
      retropharyngeal: resolve(r.retropharyngeal, context)?.value === true,
      belowCricoid: resolve(r.below_cricoid, context)?.value === true,
    };
  });

  const sizes = nodes.map((n) => n.size_cm).filter((s): s is number => typeof s === 'number');
  const biggest = nodes
    .filter((n) => typeof n.size_cm === 'number')
    .sort((a, b) => (b.size_cm ?? 0) - (a.size_cm ?? 0))[0];
  const eneNode = nodes.find((n) => n.ene);

  return {
    assessed: true,
    nodes,
    countPositive: countPositive?.value ?? (haveList ? nodes.length : undefined),
    countExamined: countExamined?.value,
    anyEne: nodes.some((n) => n.ene),
    eneSource: eneNode?.eneSource,
    maxSize: sizes.length ? Math.max(...sizes) : largest?.value,
    maxSizeSource: biggest?.sizeSource ?? largest?.source,
    ipsilateralCount: nodes.filter((n) => n.side === 'ipsilateral' || n.side === 'midline').length,
    contralateralPresent: nodes.some((n) => n.side === 'contralateral'),
    bilateralPresent: nodes.some((n) => n.side === 'bilateral'),
    anyRetropharyngeal: nodes.some((n) => n.retropharyngeal),
    anyBelowCricoid: nodes.some((n) => n.belowCricoid),
  };
}

/** ENEmi (<= 2 mm) / ENEma (> 2 mm) label for the trace. Both are ENE(+) for pN. */
export function eneLabel(extentMm?: number): string {
  if (typeof extentMm !== 'number') return 'ENE(+)';
  return extentMm <= 2 ? `ENEmi (${fmtNum(extentMm, 'mm')})` : `ENEma (${fmtNum(extentMm, 'mm')})`;
}

function sizePhrase(f: FlatNodes): string {
  return typeof f.maxSize === 'number' ? fmtNum(f.maxSize, 'cm') : 'size not recorded';
}

function sourceObs(source?: Provenance): Observation<unknown> | undefined {
  return source ? { value: true, source } : undefined;
}

/* ------------------------------------------------------------------ */
/* the shared N table                                                  */
/* ------------------------------------------------------------------ */

/**
 * The regional-node table shared by oral cavity, p16- oropharynx, hypopharynx,
 * larynx, nasal cavity / paranasal sinus, major salivary gland, cutaneous SCC
 * and the cervical-nodes (unknown primary) chapter.
 *
 * rule:common.N.clinical, rule:common.N.pathologic
 */
export function commonN(input: StagingInput, context: StagingContext): CategoryResult<NCategory> {
  const f = flattenNodes(input, context);
  const label = context === 'pathologic' ? 'pN' : 'cN';
  if (!f.assessed) {
    return { category: 'NX', trace: [say(`${label}X`, 'regional nodes not assessed')] };
  }
  const positive = f.nodes.length > 0 || (f.countPositive ?? 0) > 0;
  if (!positive) {
    const examined =
      typeof f.countExamined === 'number' ? `, ${f.countExamined} nodes examined` : '';
    return { category: 'N0', trace: [say(`${label}0`, `no regional node metastasis${examined}`)] };
  }

  const trace: string[] = [];
  const single = f.nodes.length === 1;
  const size = f.maxSize;
  const sizeObs = sourceObs(f.maxSizeSource);
  const eneObs = sourceObs(f.eneSource);

  if (context === 'clinical') {
    // Any clinically overt ENE is cN3b, whatever the size or number.
    if (f.anyEne) {
      trace.push(say(`${label}3b`, 'clinically overt extranodal extension', eneObs));
      return { category: 'N3b', trace };
    }
    if (typeof size === 'number' && size > 6) {
      trace.push(say(`${label}3a`, `node ${fmtNum(size, 'cm')} (> 6 cm), ENE(-)`, sizeObs));
      return { category: 'N3a', trace };
    }
    if (f.bilateralPresent || f.contralateralPresent) {
      trace.push(
        say(`${label}2c`, `bilateral or contralateral node(s) <= 6 cm, ENE(-) (${sizePhrase(f)})`, sizeObs),
      );
      return { category: 'N2c', trace };
    }
    if (!single) {
      trace.push(
        say(`${label}2b`, `multiple ipsilateral nodes <= 6 cm, ENE(-) (largest ${sizePhrase(f)})`, sizeObs),
      );
      return { category: 'N2b', trace };
    }
    if (typeof size === 'number' && size > 3) {
      trace.push(
        say(`${label}2a`, `single ipsilateral node ${fmtNum(size, 'cm')} (> 3 cm, <= 6 cm), ENE(-)`, sizeObs),
      );
      return { category: 'N2a', trace };
    }
    trace.push(say(`${label}1`, `single ipsilateral node ${sizePhrase(f)} (<= 3 cm), ENE(-)`, sizeObs));
    return { category: 'N1', trace };
  }

  // Pathologic. ENE(+) — whether ENEmi or ENEma — moves the category up.
  if (f.anyEne) {
    const ene = eneLabel(f.nodes.find((n) => n.ene)?.eneExtentMm);
    if (single && f.contralateralPresent) {
      trace.push(say(`${label}3b`, `single contralateral node with ${ene}`, eneObs));
      return { category: 'N3b', trace };
    }
    if (single && typeof size === 'number' && size <= 3) {
      trace.push(
        say(`${label}2a`, `single ipsilateral node ${fmtNum(size, 'cm')} (<= 3 cm) with ${ene}`, eneObs),
      );
      return { category: 'N2a', trace };
    }
    if (single) {
      trace.push(
        say(
          `${label}3b`,
          `single ipsilateral node ${sizePhrase(f)} (> 3 cm) with ${ene}`,
          eneObs,
        ),
      );
      return { category: 'N3b', trace };
    }
    trace.push(say(`${label}3b`, `multiple nodes, at least one with ${ene}`, eneObs));
    return { category: 'N3b', trace };
  }
  if (typeof size === 'number' && size > 6) {
    trace.push(say(`${label}3a`, `node ${fmtNum(size, 'cm')} (> 6 cm), ENE(-)`, sizeObs));
    return { category: 'N3a', trace };
  }
  if (f.bilateralPresent || f.contralateralPresent) {
    trace.push(
      say(`${label}2c`, `bilateral or contralateral node(s) <= 6 cm, ENE(-) (${sizePhrase(f)})`, sizeObs),
    );
    return { category: 'N2c', trace };
  }
  if (!single) {
    trace.push(
      say(`${label}2b`, `multiple ipsilateral nodes <= 6 cm, ENE(-) (largest ${sizePhrase(f)})`, sizeObs),
    );
    return { category: 'N2b', trace };
  }
  if (typeof size === 'number' && size > 3) {
    trace.push(
      say(`${label}2a`, `single ipsilateral node ${fmtNum(size, 'cm')} (> 3 cm, <= 6 cm), ENE(-)`, sizeObs),
    );
    return { category: 'N2a', trace };
  }
  trace.push(say(`${label}1`, `single ipsilateral node ${sizePhrase(f)} (<= 3 cm), ENE(-)`, sizeObs));
  return { category: 'N1', trace };
}

/* ------------------------------------------------------------------ */
/* p16+ oropharynx N                                                   */
/* ------------------------------------------------------------------ */

/**
 * HPV-mediated (p16+) oropharynx. ENE is NOT part of this N category.
 * Clinical: N1 ipsilateral <= 6 cm, N2 contralateral or bilateral <= 6 cm,
 * N3 > 6 cm. Pathologic: pN1 <= 4 positive nodes, pN2 > 4.
 *
 * rule:op16.N.clinical, rule:op16.N.pathologic
 */
export function p16OropharynxN(
  input: StagingInput,
  context: StagingContext,
): CategoryResult<NCategory> {
  const f = flattenNodes(input, context);
  const label = context === 'pathologic' ? 'pN' : 'cN';
  if (!f.assessed) {
    return { category: 'NX', trace: [say(`${label}X`, 'regional nodes not assessed')] };
  }
  const count = f.countPositive ?? f.nodes.length;
  if (count === 0) {
    const examined =
      typeof f.countExamined === 'number' ? `, ${f.countExamined} nodes examined` : '';
    return { category: 'N0', trace: [say(`${label}0`, `no regional node metastasis${examined}`)] };
  }

  if (context === 'pathologic') {
    const obs = sourceObs(resolve(input.nodes?.count_positive, context)?.source ?? 'pathology');
    if (count > 4) {
      return {
        category: 'N2',
        trace: [say('pN2', `${count} positive nodes (> 4); ENE is not used in this chapter`, obs)],
      };
    }
    return {
      category: 'N1',
      trace: [say('pN1', `${count} positive node(s) (<= 4); ENE is not used in this chapter`, obs)],
    };
  }

  const sizeObs = sourceObs(f.maxSizeSource);
  if (typeof f.maxSize === 'number' && f.maxSize > 6) {
    return {
      category: 'N3',
      trace: [say('cN3', `node ${fmtNum(f.maxSize, 'cm')} (> 6 cm)`, sizeObs)],
    };
  }
  if (f.bilateralPresent || f.contralateralPresent) {
    return {
      category: 'N2',
      trace: [
        say('cN2', `contralateral or bilateral node(s) <= 6 cm (${sizePhrase(f)})`, sizeObs),
      ],
    };
  }
  return {
    category: 'N1',
    trace: [say('cN1', `unilateral (ipsilateral) node(s) <= 6 cm (${sizePhrase(f)})`, sizeObs)],
  };
}

/* ------------------------------------------------------------------ */
/* nasopharynx N                                                       */
/* ------------------------------------------------------------------ */

/**
 * Nasopharynx. ENE is not part of this N category.
 * N1 unilateral cervical and/or uni- or bilateral retropharyngeal, <= 6 cm,
 * above the caudal border of the cricoid. N2 bilateral cervical, <= 6 cm, above
 * the cricoid. N3 > 6 cm and/or any extension below the caudal border of cricoid.
 *
 * rule:npx.N
 */
export function nasopharynxN(
  input: StagingInput,
  context: StagingContext,
): CategoryResult<NCategory> {
  const f = flattenNodes(input, context);
  const label = context === 'pathologic' ? 'pN' : 'cN';
  if (!f.assessed) {
    return { category: 'NX', trace: [say(`${label}X`, 'regional nodes not assessed')] };
  }
  if (f.nodes.length === 0 && (f.countPositive ?? 0) === 0) {
    return { category: 'N0', trace: [say(`${label}0`, 'no regional node metastasis')] };
  }
  const sizeObs = sourceObs(f.maxSizeSource);
  if (typeof f.maxSize === 'number' && f.maxSize > 6) {
    return {
      category: 'N3',
      trace: [say(`${label}3`, `cervical node ${fmtNum(f.maxSize, 'cm')} (> 6 cm)`, sizeObs)],
    };
  }
  if (f.anyBelowCricoid) {
    return {
      category: 'N3',
      trace: [say(`${label}3`, 'nodal extension below the caudal border of the cricoid', sizeObs)],
    };
  }
  const cervical = f.nodes.filter((n) => !n.retropharyngeal);
  const bilateralCervical =
    cervical.some((n) => n.side === 'bilateral') ||
    (cervical.some((n) => n.side === 'ipsilateral' || n.side === 'midline') &&
      cervical.some((n) => n.side === 'contralateral'));
  if (bilateralCervical) {
    return {
      category: 'N2',
      trace: [
        say(
          `${label}2`,
          `bilateral cervical node(s) <= 6 cm above the cricoid (${sizePhrase(f)})`,
          sizeObs,
        ),
      ],
    };
  }
  const why = f.anyRetropharyngeal
    ? 'retropharyngeal node(s) <= 6 cm above the cricoid'
    : `unilateral cervical node(s) <= 6 cm above the cricoid (${sizePhrase(f)})`;
  return { category: 'N1', trace: [say(`${label}1`, why, sizeObs)] };
}

/* ------------------------------------------------------------------ */
/* thyroid N                                                           */
/* ------------------------------------------------------------------ */

/**
 * Thyroid. N1a level VI or VII (pretracheal, paratracheal, prelaryngeal /
 * Delphian, upper mediastinal), unilateral or bilateral. N1b unilateral,
 * bilateral or contralateral lateral neck (levels I-V) or retropharyngeal.
 *
 * rule:thy.N
 */
export function thyroidN(input: StagingInput, context: StagingContext): CategoryResult<NCategory> {
  const f = flattenNodes(input, context);
  const label = context === 'pathologic' ? 'pN' : 'cN';
  const central = flag(input.nodes?.central_compartment_nodes, context);
  const lateral = flag(input.nodes?.lateral_neck_nodes, context);
  if (!f.assessed && !central && !lateral) {
    return { category: 'NX', trace: [say(`${label}X`, 'regional nodes not assessed')] };
  }
  const levels = f.nodes.map((n) => (n.level ?? '').toUpperCase());
  const CENTRAL = /^(VI|VII|6|7)/;
  const LATERAL = /^(I|II|III|IV|V|RP)\b|^(I|II|III|IV|V)[AB]?$/;
  const hasLateral =
    Boolean(lateral) ||
    f.anyRetropharyngeal ||
    levels.some((l) => l !== '' && !CENTRAL.test(l) && LATERAL.test(l));
  const hasCentral = Boolean(central) || levels.some((l) => CENTRAL.test(l));
  const positive = f.nodes.length > 0 || (f.countPositive ?? 0) > 0 || hasCentral || hasLateral;
  if (!positive) {
    return { category: 'N0', trace: [say(`${label}0`, 'no regional node metastasis')] };
  }
  if (hasLateral) {
    const obs = lateral ?? sourceObs(f.maxSizeSource);
    return {
      category: 'N1b',
      trace: [
        say(`${label}1b`, 'metastasis to lateral neck (levels I-V) or retropharyngeal nodes', obs),
      ],
    };
  }
  if (hasCentral) {
    const obs = central ?? sourceObs(f.maxSizeSource);
    return {
      category: 'N1a',
      trace: [say(`${label}1a`, 'metastasis to level VI or VII (central compartment)', obs)],
    };
  }
  return {
    category: 'N1',
    trace: [say(`${label}1`, 'regional node metastasis, compartment not specified')],
  };
}

/* ------------------------------------------------------------------ */
/* mucosal melanoma N                                                  */
/* ------------------------------------------------------------------ */

/** Mucosal melanoma of the head & neck: N0 / N1 only. rule:mm.N */
export function mucosalMelanomaN(
  input: StagingInput,
  context: StagingContext,
): CategoryResult<NCategory> {
  const f = flattenNodes(input, context);
  const label = context === 'pathologic' ? 'pN' : 'cN';
  if (!f.assessed) {
    return { category: 'NX', trace: [say(`${label}X`, 'regional nodes not assessed')] };
  }
  if (f.nodes.length === 0 && (f.countPositive ?? 0) === 0) {
    return { category: 'N0', trace: [say(`${label}0`, 'no regional node metastasis')] };
  }
  return {
    category: 'N1',
    trace: [
      say(
        `${label}1`,
        `regional node metastasis present (${sizePhrase(f)}); size and ENE are not used in this chapter`,
        sourceObs(f.maxSizeSource),
      ),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* M                                                                   */
/* ------------------------------------------------------------------ */

export function stageM(input: StagingInput, context: StagingContext): CategoryResult<MCategory> {
  const m1 = flag(input.metastasis?.m1, context);
  if (m1) return { category: 'M1', trace: [say('M1', 'distant metastasis', m1)] };
  return { category: 'M0', trace: [say('M0', 'no distant metastasis recorded')] };
}

/* ------------------------------------------------------------------ */
/* stage grouping                                                      */
/* ------------------------------------------------------------------ */

const T_RANK: Record<TCategory, number> = {
  TX: -1,
  T0: 0,
  Tis: 0,
  T1: 1,
  T1a: 1,
  T1b: 1,
  T2: 2,
  T3: 3,
  T3a: 3,
  T3b: 3,
  T4: 4,
  T4a: 4,
  T4b: 5,
};

const N_RANK: Record<NCategory, number> = {
  NX: -1,
  N0: 0,
  N1: 1,
  N1a: 1,
  N1b: 1,
  N2: 2,
  N2a: 2,
  N2b: 2,
  N2c: 2,
  N3: 3,
  N3a: 3,
  N3b: 3,
};

export function tRank(t: TCategory): number {
  return T_RANK[t];
}

export function nRank(n: NCategory): number {
  return N_RANK[n];
}

/**
 * The stage grouping shared by oral cavity, p16- oropharynx, hypopharynx,
 * larynx, nasal cavity / paranasal sinus and major salivary gland.
 *
 *   0    Tis N0 M0
 *   I    T1 N0 M0
 *   II   T2 N0 M0
 *   III  T3 N0 M0; T1-T3 N1 M0
 *   IVA  T4a N0-N1 M0; T1-T4a N2 M0
 *   IVB  T4b any N M0; any T N3 M0
 *   IVC  any T any N M1
 *
 * rule:common.group.standard
 */
export function standardHnStageGroup(
  T: TCategory,
  N: NCategory,
  M: MCategory,
): GroupResult {
  const trace: string[] = [];
  if (M === 'M1') {
    trace.push(say('Stage IVC', `${T} ${N} M1 — distant metastasis`));
    return { group: 'IVC', trace };
  }
  if (T === 'TX' || N === 'NX') {
    trace.push(say('Stage unknown', `${T} ${N} ${M} — a category could not be assigned`));
    return { group: 'unknown', trace };
  }
  const t = tRank(T);
  const n = nRank(N);
  if (T === 'T4b' || n === 3) {
    trace.push(say('Stage IVB', `${T} ${N} M0 — T4b or N3`));
    return { group: 'IVB', trace };
  }
  if (T === 'T4a' || n === 2) {
    trace.push(say('Stage IVA', `${T} ${N} M0 — T4a with N0-N1, or N2 with T1-T4a`));
    return { group: 'IVA', trace };
  }
  if (n === 1 || t === 3) {
    trace.push(say('Stage III', `${T} ${N} M0 — T3 N0, or N1 with T1-T3`));
    return { group: 'III', trace };
  }
  if (t === 2) {
    trace.push(say('Stage II', `${T} N0 M0`));
    return { group: 'II', trace };
  }
  if (T === 'Tis') {
    trace.push(say('Stage 0', 'Tis N0 M0 — carcinoma in situ'));
    return { group: '0', trace };
  }
  trace.push(say('Stage I', `${T} N0 M0`));
  return { group: 'I', trace };
}

/** Convenience for sites that have no size-based T at all. */
export function unknownSizeTrace(label: string): string {
  return say(label, 'no primary-tumour descriptors supplied');
}
