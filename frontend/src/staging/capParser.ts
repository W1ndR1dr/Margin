/**
 * CAP synoptic pathology report parser.
 *
 * Pasted text in, staging descriptors out. Everything it produces is tagged
 * `source: 'pathology'` and `contextPathologic: true`, so `stage()` computes a
 * pTNM alongside the cTNM and flags any descriptor the imaging disagreed with.
 *
 * Deliberately tolerant: CAP protocol wording changes between versions and
 * between laboratories, so the matchers key off the distinctive noun phrase
 * ("Depth of Invasion", "Extranodal Extension") rather than the exact label.
 * Every line no matcher claimed comes back in `unparsed` — nothing is silently
 * dropped, because a missed line is a missed T category.
 *
 * rule:parser.cap. Pure: no network, no DOM. The report never leaves the box.
 */

import type {
  NodesInput,
  Observation,
  PrimaryInput,
  Site,
  StagingInput,
} from './types';

/* ------------------------------------------------------------------ */
/* result shape                                                        */
/* ------------------------------------------------------------------ */

export interface ParsedField {
  /** Dotted path into `StagingInput`, e.g. `primary.depth_of_invasion_mm`. */
  field: string;
  value: string | number | boolean;
  /** The source line, trimmed. */
  line: string;
}

export interface CapParseResult {
  /** Best guess at the AJCC chapter, from histologic type / specimen / site lines. */
  site?: Site;
  /** The text that decided `site`. */
  siteEvidence?: string;
  /** Ready to hand to `stage()`. */
  input: StagingInput;
  fields: ParsedField[];
  /** Non-blank lines no matcher claimed, in order. */
  unparsed: string[];
  /** A pTNM the report itself states, for comparison with the computed one. */
  reportedStage?: string;
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const PATH: Observation<never>['source'] = 'pathology';

function obsNum(value: number): Observation<number> {
  return { value, source: PATH };
}

function obsBool(value: boolean, note?: string): Observation<boolean> {
  return note ? { value, source: PATH, note } : { value, source: PATH };
}

/** CAP writes negatives many ways; treat anything explicitly negative as false. */
const NEGATIVE = /\b(not identified|not present|absent|none identified|negative|no\b|cannot be (determined|assessed)|indeterminate)\b/i;
const POSITIVE = /\b(present|identified|positive|detected|yes)\b/i;

/**
 * Tri-state reading of a CAP answer. `undefined` when the answer says the
 * finding could not be assessed, so the field is simply not set.
 */
function presence(answer: string): boolean | undefined {
  const a = answer.trim();
  if (a === '') return undefined;
  if (/cannot be (determined|assessed)|indeterminate|not applicable|not submitted/i.test(a)) {
    return undefined;
  }
  if (NEGATIVE.test(a)) return false;
  if (POSITIVE.test(a)) return true;
  return undefined;
}

function toCm(value: number, unit: string): number {
  return /^mm/i.test(unit) ? value / 10 : value;
}

function toMm(value: number, unit: string): number {
  return /^cm/i.test(unit) ? value * 10 : value;
}

/** Strip CAP bullet decoration and collapse runs of whitespace. */
function normalise(line: string): string {
  return line
    .replace(/^[\s ]*[+\-*#>]{1,3}\s*/, '')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SEPARATOR = /^[-=_*#\s.]+$/;

/* ------------------------------------------------------------------ */
/* site detection                                                      */
/* ------------------------------------------------------------------ */

interface SiteHint {
  pattern: RegExp;
  site: Site;
}

/** Ordered: the first pattern that matches the specimen / site / histology wins. */
const SITE_HINTS: SiteHint[] = [
  { pattern: /mucosal melanoma|melanoma of the (nasal|oral|sinonasal|mucosa)/i, site: 'mucosal_melanoma_hn' },
  { pattern: /anaplastic (thyroid )?carcinoma|undifferentiated thyroid/i, site: 'thyroid_anaplastic' },
  { pattern: /medullary (thyroid )?carcinoma/i, site: 'thyroid_medullary' },
  { pattern: /papillary (thyroid )?carcinoma|follicular (thyroid )?carcinoma|oncocytic carcinoma|h(u|ü)rthle|thyroidectomy|thyroid lobectomy|thyroid gland/i, site: 'thyroid_differentiated' },
  { pattern: /parotid|submandibular gland|sublingual gland|salivary/i, site: 'major_salivary' },
  { pattern: /nasopharyn/i, site: 'nasopharynx' },
  { pattern: /hypopharyn|pyriform|piriform|postcricoid|post-cricoid/i, site: 'hypopharynx' },
  { pattern: /supraglott|epiglott|false cord|aryepiglottic/i, site: 'larynx_supraglottic' },
  { pattern: /subglott/i, site: 'larynx_subglottic' },
  { pattern: /glottic|vocal cord|true cord|laryngectomy|larynx/i, site: 'larynx_glottic' },
  { pattern: /oropharyn|tonsil|base of tongue|tongue base|soft palate/i, site: 'oropharynx_p16neg' },
  { pattern: /nasal cavity|ethmoid|maxillary sinus|paranasal|sinonasal/i, site: 'nasal_cavity_paranasal' },
  { pattern: /skin of|cutaneous|scalp|auricle|external ear|helix|preauricular skin|temple/i, site: 'cutaneous_scc_hn' },
  { pattern: /oral tongue|floor of mouth|buccal|alveolar ridge|retromolar|hard palate|gingiva|oral cavity|\blip\b|mandible|maxilla/i, site: 'oral_cavity' },
];

/* ------------------------------------------------------------------ */
/* the parser                                                          */
/* ------------------------------------------------------------------ */

export function parseCapReport(text: string): CapParseResult {
  const primary: PrimaryInput = {};
  const nodes: NodesInput = {};
  const input: StagingInput = { primary, nodes, patient: {}, contextPathologic: true };
  const fields: ParsedField[] = [];
  const unparsed: string[] = [];
  let siteEvidence: string | undefined;
  let site: Site | undefined;
  let reportedStage: string | undefined;

  const record = (field: string, value: string | number | boolean, line: string): void => {
    fields.push({ field, value, line });
  };

  /**
   * Site candidates by precedence: an explicit "Tumor Site" line beats the
   * histologic type, which beats the specimen / procedure line (a laryngectomy
   * specimen says nothing about which laryngeal subsite the tumour sits in).
   */
  const candidates: Array<{ text: string; line: string } | undefined> = [
    undefined,
    undefined,
    undefined,
  ];
  let histologyText = '';

  const considerSite = (text: string, line: string, precedence: 0 | 1 | 2): void => {
    if (!candidates[precedence]) candidates[precedence] = { text, line };
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalise(rawLine);
    if (line === '' || SEPARATOR.test(line)) continue;
    let claimed = false;

    /* -- stage stated by the report ------------------------------- */
    const stageMatch = line.match(
      /(?:pathologic|path\.?)\s*stage\s*(?:classification)?[^:]*:\s*(.+)$/i,
    );
    if (!claimed && stageMatch) {
      reportedStage = stageMatch[1].trim();
      record('reportedStage', reportedStage, line);
      claimed = true;
    }
    if (!claimed && /^\s*(p|yp)T[0-4isX]/i.test(line) && /[,;]\s*(p|c)N/i.test(line)) {
      reportedStage = line;
      record('reportedStage', line, line);
      claimed = true;
    }

    /* -- histologic type, specimen, site -------------------------- */
    const typeMatch = line.match(
      /^(histologic type|histological type|tumou?r type|diagnosis)\s*[^:]*:\s*(.+)$/i,
    );
    if (!claimed && typeMatch) {
      const value = typeMatch[2].trim();
      if (input.patient) input.patient.histology = value;
      histologyText = `${histologyText} ${value}`.trim();
      considerSite(value, line, 1);
      record('patient.histology', value, line);
      claimed = true;
    }
    const siteMatch = line.match(
      /^(tumou?r site|primary (tumou?r )?site|specimen|procedure|site|specimen\(s\))\s*[^:]*:\s*(.+)$/i,
    );
    if (!claimed && siteMatch) {
      const value = (siteMatch[3] ?? '').trim();
      const explicitSiteLine = /^(tumou?r site|primary)/i.test(siteMatch[1]);
      considerSite(value, line, explicitSiteLine ? 0 : 2);
      record('siteHint', value, line);
      claimed = true;
    }

    /* -- node metastasis size (before the generic size matcher) ---- */
    const depositMatch = line.match(
      /(?:size of (?:the )?largest (?:metastatic (?:deposit|focus)|nodal metastasis|tumou?r deposit)|largest metastatic (?:deposit|focus))[^:]*:\s*(?:greatest dimension[^:]*:\s*)?([\d.]+)\s*(cm|mm)/i,
    );
    if (!claimed && depositMatch) {
      const cm = toCm(Number(depositMatch[1]), depositMatch[2]);
      nodes.largest_metastasis_cm = obsNum(cm);
      record('nodes.largest_metastasis_cm', cm, line);
      claimed = true;
    }

    /* -- extranodal extension ------------------------------------- */
    if (!claimed && /extranodal extension|extracapsular (extension|spread)/i.test(line)) {
      const answer = line.split(':').slice(1).join(':');
      const state = presence(answer);
      if (state !== undefined) {
        nodes.ene_present = obsBool(state, answer.trim() || undefined);
        record('nodes.ene_present', state, line);
      }
      const extent = answer.match(/([\d.]+)\s*mm/i);
      if (extent) {
        nodes.ene_extent_mm = obsNum(Number(extent[1]));
        record('nodes.ene_extent_mm', Number(extent[1]), line);
      } else if (/enema|greater than 2\s*mm|>\s*2\s*mm/i.test(answer)) {
        nodes.ene_extent_mm = obsNum(2.1);
        record('nodes.ene_extent_mm', 2.1, line);
      } else if (/enemi|less than or equal to 2\s*mm|<=?\s*2\s*mm|≤\s*2\s*mm/i.test(answer)) {
        nodes.ene_extent_mm = obsNum(2);
        record('nodes.ene_extent_mm', 2, line);
      }
      claimed = true;
    }

    /* -- node counts ---------------------------------------------- */
    const examinedMatch = line.match(
      /number of (?:lymph )?nodes? (?:examined|evaluated)[^:]*:\s*(\d+)/i,
    );
    if (!claimed && examinedMatch) {
      nodes.count_examined = obsNum(Number(examinedMatch[1]));
      record('nodes.count_examined', Number(examinedMatch[1]), line);
      claimed = true;
    }
    const involvedMatch = line.match(
      /number of (?:lymph )?nodes? (?:involved|with (?:tumou?r|metasta(?:sis|ses))|positive)[^:]*:\s*(\d+)/i,
    );
    if (!claimed && involvedMatch) {
      nodes.count_positive = obsNum(Number(involvedMatch[1]));
      record('nodes.count_positive', Number(involvedMatch[1]), line);
      claimed = true;
    }
    // "Level II: 2/18" or "Right Level IIa: 1 of 22"
    const levelMatch = line.match(
      /level\s+([IVX]+[ab]?)\s*:?\s*(\d+)\s*(?:\/|of)\s*(\d+)/i,
    );
    if (!claimed && levelMatch) {
      record(`nodes.level.${levelMatch[1]}`, `${levelMatch[2]}/${levelMatch[3]}`, line);
      if (/^(VI|VII|6|7)$/i.test(levelMatch[1]) && Number(levelMatch[2]) > 0) {
        nodes.central_compartment_nodes = obsBool(true, `level ${levelMatch[1]}`);
      } else if (Number(levelMatch[2]) > 0) {
        nodes.lateral_neck_nodes = obsBool(true, `level ${levelMatch[1]}`);
      }
      claimed = true;
    }

    /* -- laterality ------------------------------------------------ */
    const lateralityMatch = line.match(/^laterality[^:]*:\s*(.+)$/i);
    if (!claimed && lateralityMatch) {
      const value = lateralityMatch[1].trim();
      if (/bilateral/i.test(value)) nodes.laterality = 'bilateral';
      else if (/midline|central/i.test(value)) nodes.laterality = 'midline';
      else nodes.laterality = 'ipsilateral';
      record('nodes.laterality', nodes.laterality, line);
      claimed = true;
    }

    /* -- depth of invasion ---------------------------------------- */
    const doiMatch =
      line.match(/depth of invasion[^:]*:\s*(?:at least\s*)?([\d.]+)\s*(mm|cm)\b/i) ??
      line.match(/depth of invasion\s*\((millimet|centimet)[a-z]*\)[^:]*:\s*([\d.]+)/i);
    if (!claimed && doiMatch) {
      const mm =
        doiMatch.length === 3 && /^(mm|cm)$/i.test(doiMatch[2])
          ? toMm(Number(doiMatch[1]), doiMatch[2])
          : toMm(Number(doiMatch[2]), /^milli/i.test(doiMatch[1]) ? 'mm' : 'cm');
      primary.depth_of_invasion_mm = obsNum(mm);
      record('primary.depth_of_invasion_mm', mm, line);
      claimed = true;
    }

    /* -- tumour thickness (cutaneous) ------------------------------ */
    const thicknessMatch = line.match(/tumou?r thickness[^:]*:\s*([\d.]+)\s*(mm|cm)/i);
    if (!claimed && thicknessMatch) {
      const mm = toMm(Number(thicknessMatch[1]), thicknessMatch[2]);
      primary.dermal_invasion_depth_mm = obsNum(mm);
      record('primary.dermal_invasion_depth_mm', mm, line);
      claimed = true;
    }

    /* -- tumour size ----------------------------------------------- */
    if (!claimed && !/node|metasta/i.test(line)) {
      const withUnit = line.match(
        /(?:greatest dimension|tumou?r size|greatest tumou?r dimension)[^:]*:\s*(?:greatest dimension[^:]*:\s*)?([\d.]+)\s*(cm|mm)\b/i,
      );
      const unitInLabel = line.match(
        /(?:greatest dimension|tumou?r size)\s*\((centimet|millimet)[a-z]*\)[^:]*:\s*([\d.]+)/i,
      );
      if (withUnit) {
        const cm = toCm(Number(withUnit[1]), withUnit[2]);
        primary.size_cm = obsNum(cm);
        record('primary.size_cm', cm, line);
        claimed = true;
      } else if (unitInLabel) {
        const cm = toCm(Number(unitInLabel[2]), /^centi/i.test(unitInLabel[1]) ? 'cm' : 'mm');
        primary.size_cm = obsNum(cm);
        record('primary.size_cm', cm, line);
        claimed = true;
      }
    }

    /* -- perineural and lymphovascular invasion -------------------- */
    if (!claimed && /perineural invasion/i.test(line)) {
      const answer = line.split(':').slice(1).join(':');
      const state = presence(answer);
      if (state !== undefined) {
        primary.perineural_invasion = obsBool(state, answer.trim() || undefined);
        record('primary.perineural_invasion', state, line);
      }
      const calibre = answer.match(/([\d.]+)\s*mm(?:\s*(?:in\s*)?(?:calibre|caliber|diameter))?/i);
      if (calibre) {
        primary.perineural_nerve_calibre_mm = obsNum(Number(calibre[1]));
        record('primary.perineural_nerve_calibre_mm', Number(calibre[1]), line);
      }
      if (/named nerve|facial nerve|trigeminal|infraorbital|auriculotemporal|V2|V3/i.test(answer)) {
        primary.named_nerve_invasion = obsBool(true, answer.trim());
        record('primary.named_nerve_invasion', true, line);
      }
      claimed = true;
    }
    if (!claimed && /(lymphovascular|lymph-vascular|angiolymphatic|vascular) invasion/i.test(line)) {
      const answer = line.split(':').slice(1).join(':');
      const state = presence(answer);
      if (state !== undefined) record('pathology.lymphovascular_invasion', state, line);
      claimed = true;
    }

    /* -- margins ---------------------------------------------------- */
    if (!claimed && /margin/i.test(line)) {
      const distance = line.match(/([\d.]+)\s*(mm|cm)/i);
      if (/distance|closest|nearest/i.test(line) && distance) {
        const mm = toMm(Number(distance[1]), distance[2]);
        record('pathology.closest_margin_mm', mm, line);
        claimed = true;
      } else {
        const answer = line.split(':').slice(1).join(':');
        if (answer.trim() !== '') {
          const involved = /\binvolved\b/i.test(answer) && !/uninvolved|not involved/i.test(answer);
          record('pathology.margins_involved', involved, line);
          claimed = true;
        }
      }
    }

    /* -- bone invasion --------------------------------------------- */
    if (!claimed && /bone invasion|invasion of bone|mandibular invasion|maxillary invasion/i.test(line)) {
      const answer = line.split(':').slice(1).join(':');
      const state = presence(answer);
      if (state !== undefined) {
        if (/medullary|marrow/i.test(answer)) {
          primary.medullary_bone_invasion = obsBool(state, answer.trim());
          primary.cortical_bone_invasion = obsBool(state, answer.trim());
          record('primary.medullary_bone_invasion', state, line);
        } else if (/superficial|tooth socket/i.test(answer)) {
          primary.gingival_superficial_bone_erosion = obsBool(state, answer.trim());
          record('primary.gingival_superficial_bone_erosion', state, line);
        } else {
          primary.cortical_bone_invasion = obsBool(state, answer.trim() || undefined);
          record('primary.cortical_bone_invasion', state, line);
        }
      }
      claimed = true;
    }

    /* -- extrathyroidal extension ---------------------------------- */
    if (!claimed && /extrathyroidal extension/i.test(line)) {
      const answer = line.split(':').slice(1).join(':');
      const state = presence(answer);
      if (state === true) {
        if (/prevertebral|carotid|mediastinal/i.test(answer)) {
          primary.prevertebral_fascia_invasion = obsBool(true, answer.trim());
          record('primary.prevertebral_fascia_invasion', true, line);
        } else if (/larynx|trachea|o?esophagus|recurrent laryngeal|subcutaneous/i.test(answer)) {
          primary.larynx_trachea_rln_invasion = obsBool(true, answer.trim());
          record('primary.larynx_trachea_rln_invasion', true, line);
        } else if (/strap/i.test(answer)) {
          primary.strap_muscle_invasion = obsBool(true, answer.trim());
          record('primary.strap_muscle_invasion', true, line);
        } else if (/microscopic/i.test(answer)) {
          record('pathology.microscopic_ete', true, line);
        } else {
          record('pathology.extrathyroidal_extension', answer.trim(), line);
        }
      } else if (state === false) {
        primary.strap_muscle_invasion = obsBool(false, answer.trim());
        record('primary.strap_muscle_invasion', false, line);
      }
      claimed = true;
    }

    /* -- extraparenchymal extension (salivary) --------------------- */
    if (!claimed && /extraparenchymal extension/i.test(line)) {
      const answer = line.split(':').slice(1).join(':');
      const state = presence(answer);
      if (state !== undefined) {
        primary.extraparenchymal_extension = obsBool(state, answer.trim() || undefined);
        record('primary.extraparenchymal_extension', state, line);
      }
      claimed = true;
    }

    /* -- p16 / HPV / EBER ------------------------------------------ */
    if (!claimed && /\bp16\b/i.test(line)) {
      const answer = line.split(':').slice(1).join(':');
      const state = presence(answer);
      if (state !== undefined && input.patient) {
        input.patient.p16 = state ? 'positive' : 'negative';
        record('patient.p16', input.patient.p16, line);
      }
      claimed = true;
    }
    if (!claimed && /\bhpv\b|human papillomavirus/i.test(line)) {
      const answer = line.split(':').slice(1).join(':');
      const state = presence(answer);
      if (state !== undefined && input.patient) {
        input.patient.hpv = state ? 'positive' : 'negative';
        record('patient.hpv', input.patient.hpv, line);
      }
      claimed = true;
    }
    if (!claimed && /\beber\b|epstein[- ]barr/i.test(line)) {
      const answer = line.split(':').slice(1).join(':');
      const state = presence(answer);
      if (state !== undefined && input.patient) {
        input.patient.ebv = state ? 'positive' : 'negative';
        record('patient.ebv', input.patient.ebv, line);
      }
      claimed = true;
    }

    /* -- distant metastasis ---------------------------------------- */
    if (!claimed && /distant metastas/i.test(line)) {
      const answer = line.split(':').slice(1).join(':');
      const state = presence(answer);
      if (state !== undefined) {
        input.metastasis = { m1: obsBool(state, answer.trim() || undefined) };
        record('metastasis.m1', state, line);
      }
      claimed = true;
    }

    if (!claimed) unparsed.push(line);
  }

  // Resolve the site: best-precedence candidate that matches a hint.
  for (const candidate of candidates) {
    if (site || !candidate) continue;
    for (const hint of SITE_HINTS) {
      if (hint.pattern.test(candidate.text)) {
        site = hint.site;
        siteEvidence = candidate.line;
        break;
      }
    }
  }

  // Thyroid histology decides which of the three thyroid chapters applies, and
  // a melanoma diagnosis overrides the anatomical site entirely.
  if (site && site.startsWith('thyroid')) {
    if (/anaplastic|undifferentiated/i.test(histologyText)) site = 'thyroid_anaplastic';
    else if (/medullary/i.test(histologyText)) site = 'thyroid_medullary';
    else site = 'thyroid_differentiated';
  }
  if (/\bmelanoma\b/i.test(histologyText)) {
    site = 'mucosal_melanoma_hn';
    if (/\bskin of|cutaneous/i.test(candidates[0]?.text ?? '')) site = undefined;
  }

  // A p16 result narrows the oropharyngeal chapter.
  if (site === 'oropharynx_p16neg' && input.patient?.p16 === 'positive') {
    site = 'oropharynx_p16pos';
  }

  // An empty neck dissection still tells us the neck is N0.
  if (nodes.count_examined !== undefined && nodes.count_positive === undefined) {
    nodes.count_positive = obsNum(0);
    fields.push({
      field: 'nodes.count_positive',
      value: 0,
      line: 'inferred: nodes examined with no involved count reported',
    });
  }

  return { site, siteEvidence, input, fields, unparsed, reportedStage };
}

export default parseCapReport;
