# Staging engine — AJCC 8 head & neck

Pure TypeScript implementation of the AJCC Cancer Staging Manual, 8th edition,
head & neck TNM, with a rule trace, imaging-vs-pathology conflict detection, and
a local parser for CAP synoptic pathology reports. No React, no Cornerstone, no
DOM, no network — the UI wires it in separately and only ever hands it numbers
and flags. Pasted pathology never leaves the machine.

```ts
import { stage, parseCapReport } from '@/staging';

const parsed = parseCapReport(clipboardText);        // pathology, tagged 'pathology'
const result = stage(parsed.site ?? 'oral_cavity', {
  ...parsed.input,
  primary: { ...parsed.input.primary, cortical_bone_invasion: { value: true, source: 'imaging' } },
});

result.clinical;    // { T: 'T4a', N: 'NX', M: 'M0', group: 'unknown', trace: [...] }
result.pathologic;  // { T: 'T2',  N: 'N2b', M: 'M0', group: 'IVA', trace: [...] }
result.conflicts;   // [{ field: 'primary.cortical_bone_invasion', imaging: 'present (imaging)', ... }]
result.warnings;    // ["Depth of invasion was taken from imaging: ...", ...]
```

## Files

| file | contents |
| --- | --- |
| `types.ts` | `Site`, `Observation`/`Observed`, `PrimaryInput`, `NodeRecord`/`NodesInput`, `PatientInput`, `StagingInput`, `TCategory`/`NCategory`/`StageGroup`, `StageResult`, `SiteRules` |
| `stage.ts` | `stage(site, input)`, `findConflicts`, `generalWarnings` |
| `capParser.ts` | `parseCapReport(text)` — CAP synoptic text to pathology descriptors |
| `rules/common.ts` | observation resolution, trace sentences, `commonN`, `p16OropharynxN`, `nasopharynxN`, `thyroidN`, `mucosalMelanomaN`, `standardHnStageGroup` |
| `rules/ruleTable.ts` | `RULE_TABLE` — every rule with its source and confidence marker |
| `rules/<site>.ts` | one file per AJCC chapter: `stageT`, `stageN`, `stageGroup`, optional `warnings` |
| `rules/index.ts` | `SITE_RULES`, `rulesFor(site)` |
| `index.ts` | barrel re-export |
| `staging.test.ts` | vitest suite (99 cases) |

```powershell
cd C:\Users\o948145\hnrad\frontend
npx vitest run src/staging
```

## The input model: provenance is a first-class field

Every descriptor carries where it came from:

```ts
{ value: 6, source: 'imaging' }                    // one observation
[{ value: 9, source: 'imaging' },                  // two, which is how conflicts surface
 { value: 6, source: 'pathology' }]
```

- A **clinical** classification reads `exam`, `imaging`, `clinical` in that order
  and **never reads a pathology-sourced observation**. cTNM is what was known
  before treatment, so a pasted CAP report on its own correctly yields `cTX cNX`.
- A **pathologic** classification reads `pathology`, then falls back to
  `exam`, `imaging`, `clinical` for what a specimen cannot show — carotid
  encasement, skull base invasion, distant metastasis.
- A node is only visible to a classification if at least one of its descriptors
  resolves in that context, so a node known only from the neck dissection cannot
  leak into cN.
- `contextPathologic: true` asks `stage()` for the pathologic classification as
  well. `parseCapReport` sets it.

Every category decision appends a sentence naming the driving value and its
provenance:

```
Clinical classification: Lip and oral cavity (AJCC 8)
cT4a: invasion through cortical bone (mandible or maxilla) (imaging)
cN2b: multiple ipsilateral nodes <= 6 cm, ENE(-) (largest 2.4 cm) (exam)
M0: no distant metastasis recorded
Stage IVA: T4a N2b M0 — T4a with N0-N1, or N2 with T1-T4a
```

## Rule sources

Everything is cross-checked against AJCC-published or AJCC-derived material;
none of it is behind a licence. Full citations are in `rules/ruleTable.ts`.

| key | source |
| --- | --- |
| `AJCC-P2P` | AJCC *Physician to Physician, 8th Edition, Head and Neck* (W.M. Lydiatt), American College of Surgeons — [PDF](https://www.facs.org/media/i2kn34ed/head-and-neck-8th-ed.pdf) |
| `AJCC-WEB` | AJCC *8th Edition Staging — Head & Neck Staging* webinar (D.M. Gress) — [PDF](https://www.facs.org/media/flipxyxh/8th-edition_headneck-staging.pdf) |
| `LYDIATT17` | Lydiatt WM et al. CA Cancer J Clin 2017;67:122-137 — [doi](https://doi.org/10.3322/caac.21389) |
| `TUTTLE17` | Tuttle RM, Haugen B, Perrier ND. Thyroid 2017 — [doi](https://doi.org/10.1089/thy.2017.0102) |
| `CALIFANO` | AJCC 8th ed. ch. 15 (cutaneous SCC of the head and neck), as reproduced with ACS permission on the AJCC-8/BWH staging card |
| `CAP` | [CAP cancer protocols](https://documents.cap.org/protocols/), head & neck — synoptic field names |
| `AJCC8` | AJCC Cancer Staging Manual, 8th ed. (Amin MB et al., Springer 2017) |

The p16+ oropharynx clinical and pathologic stage-grouping grids, the oral
cavity corrected T table, the ENE clinical/pathologic criteria and the
ENEmi/ENEma definitions were read directly off the two AJCC slide decks.

## Confidence markers — read this before trusting a category

`RULE_TABLE` marks each rule `'high'` or `'verify'`. `'verify'` means the rule
still runs, but it has not been confirmed word-for-word against the printed
manual, or published summaries disagree. `stage()` lists the `'verify'` rules it
applied in `warnings`, and `rulesToVerify()` returns them all.

| rule | why it is `'verify'` |
| --- | --- |
| `oral.T.grid` | **AJCC 8 printed the oral cavity T table three times.** The original printing — still reproduced by `AJCC-P2P` and by most online summaries — reads *T2: ≤ 2 cm with DOI > 5 and ≤ 10 mm, or > 2-4 cm with DOI ≤ 10 mm; T3: > 4 cm OR any tumour with DOI > 10 mm*. The corrected table (the "after correction" column of `AJCC-WEB`) is a clean size × DOI grid: *T3: > 2-4 cm with DOI > 10 mm, or > 4 cm with DOI ≤ 10 mm; T4a: > 4 cm with DOI > 10 mm*. This engine implements the **corrected** table and emits a warning naming both answers whenever they differ. It also warns about the one cell the corrected table reads literally as T2 (≤ 2 cm with DOI > 10 mm) but which is widely reported as T3. |
| `hypo.T` | AJCC 8 hypopharynx uses *fixation of hemilarynx* for T2/T3 where the 7th edition used *impaired vocal cord mobility*, and many public summaries still quote the 7th-edition wording. The engine uses `hemilarynx_fixation` and falls back to `vocal_cord_fixation`. |
| `sinus.maxillary.T`, `sinus.nasoethmoid.T` | Both sinonasal T tables were transcribed from the 8th edition but not re-checked against the printed chapter. The subsite split itself (maxillary sinus vs nasal cavity/ethmoid) is certain; the individual T3/T4a structure lists are the part to check. |
| `thy.group.medullary` | The medullary grouping in which *T1-T3 N1a = III* and *T1-T3 N1b = IVA* was not re-checked against the printed table. An N1 with no compartment recorded is mapped to the worse group (IVA) and says so in the trace. |
| `cut.T.pni` | The 0.1 mm nerve-calibre threshold and the "nerve deeper than the dermis" alternative are widely quoted but not re-checked word for word. |
| `cut.N` | Some AJCC-derived summaries present the cutaneous chapter as a single merged N1/N2/N3 table rather than the clinical/pathologic pair with a/b/c subdivisions. The engine uses the mucosal clinical/pathologic pair; the major category agrees in every case the tests cover, but the subcategory letter may not be what a registrar expects. |
| `mm.T` | At least one published summary places the lower cranial nerves, masticator space, carotid, prevertebral space and mediastinal structures in mucosal melanoma **T4a**. This engine places them in **T4b** and keeps T4a for deep soft tissue, cartilage, bone and overlying skin. |
| `unk.group` | Only the *T0 N1 = stage III* cell of the cervical-nodes chapter is confirmed by an AJCC worked example; IVA/IVB follow the standard grouping. |
| `parser.cap` | CAP protocol wording changes between versions and laboratories. Every line the parser could not interpret is returned in `unparsed` rather than dropped. |

## Warnings the engine raises

- **Imaging depth of invasion** — "imaging DOI overestimates histologic DOI",
  so the clinical T may sit above the pathologic T.
- **Missing p16 for an oropharyngeal primary** — AJCC requires p16 to choose the
  chapter, so both chapters are computed; the other one comes back in
  `result.alternate` and the difference is spelled out in a warning.
- **Missing age for differentiated thyroid** — no stage group is assigned at all,
  because the 55-year cut-off decides every row.
- **ENE from imaging only** — "radiologic ENE is not cENE unless there are
  unequivocal clinical signs". AJCC 8 is explicit: radiographic evidence alone is
  insufficient, and if in doubt assign ENE(−).
- **Missing sinonasal subsite**, **no nodal information**, **no M descriptor**,
  and the list of `'verify'` rules that were applied.

## Conflicts

`findConflicts` reports every descriptor observed both by imaging/exam and by
pathology with different values:

```ts
{
  field: 'primary.cortical_bone_invasion',
  imaging: 'present (imaging)',
  pathology: 'absent (pathology)',
  note: 'imaging and pathology disagree. The clinical classification uses the imaging value and the pathologic classification uses the pathology value.',
}
```

This is the case the tool exists for: imaging calls cortical mandible invasion
and stages cT4a, the specimen shows no bone involvement and stages pT2.

## The CAP parser

`parseCapReport(text)` matches the distinctive noun phrase rather than the exact
label, so it survives version drift. It reads: tumour site / specimen /
procedure, histologic type, tumour size (greatest dimension, cm or mm, unit in
the value or in the label), depth of invasion, tumour thickness, perineural
invasion (including nerve calibre and named nerves), lymphovascular invasion,
margin status and closest-margin distance, bone invasion (cortical vs medullary
vs superficial erosion), extrathyroidal extension (sorted into the T3b / T4a /
T4b buckets), extraparenchymal extension, number of nodes examined and involved,
per-level counts ("Level VI: 3/11"), size of the largest metastatic deposit,
extranodal extension with its ENEmi/ENEma extent, laterality, p16, HPV, EBER,
distant metastasis, and any pTNM the report states (returned as `reportedStage`
for comparison, never used as an input).

It infers the chapter from the tumour-site line first, the histologic type
second and the specimen/procedure line last — a "total laryngectomy" specimen
says nothing about which laryngeal subsite the tumour sits in. Thyroid histology
then picks between the differentiated, medullary and anaplastic chapters, and a
p16-positive result moves an oropharyngeal case to the HPV-mediated chapter.

Everything it produces is tagged `source: 'pathology'`, and every line it could
not interpret comes back in `unparsed`.

## Deliberately not implemented

- **Nothing outside AJCC 8 head & neck.** No 7th edition, no UICC variants, no
  AJCC 9 nasopharynx, no NCCN treatment logic, no risk stratification
  (ATA thyroid risk, BWH cutaneous classification), no prognostic nomograms.
- **No grade, no histology-specific rules** beyond choosing the thyroid chapter
  and the p16 chapter. `patient.histology` is carried but never staged on.
- **No `y` or `r` prefixes** — post-neoadjuvant (ypTNM) and recurrence (rTNM)
  classifications are not modelled.
- **No cutaneous melanoma, Merkel cell carcinoma, lymphoma, sarcoma, or
  parathyroid.** Mucosal melanoma of the head & neck is in; skin melanoma is a
  different chapter and the parser returns `site: undefined` for it rather than
  guessing.
- **No AJCC registry data items** (SSDIs, schema discriminators, site-specific
  factors).
- **No inference of descriptors from images.** Everything here is a descriptor
  in, category out. Whether the mandible cortex is breached is Margin's job
  elsewhere; this module only asks who said so.
- **Tis is only assigned when `in_situ` is set explicitly**, and the p16+
  oropharynx and nasopharynx chapters do not offer it, per AJCC.
- **`unknown_primary` does not choose a chapter for you.** It warns when p16 or
  EBER is missing or positive, but it will not silently restage the case in the
  oropharynx or nasopharynx chapter — AJCC is emphatic that the physician may
  not presume a primary site.

## Limitations worth saying out loud

- **A category is only as good as the descriptor.** `size_cm` from a scan is not
  the same measurement as `size_cm` from a specimen, and the engine will happily
  stage on either; that is what the provenance in the trace is for.
- **Aggregate node counts are materialised into synthetic nodes** when a report
  gives "3 positive nodes, largest 2.4 cm" without per-node detail. Laterality
  then falls back to `nodes.laterality` or `'ipsilateral'`, which will under-call
  N2c when a contralateral node was not flagged.
- **Matted nodes** are not modelled; enter a matted mass as one node with its
  overall greatest dimension, which is what AJCC intends.
- **`M0` is assumed** when no metastasis descriptor is given, with a warning.
  AJCC uses cM0 clinically; there is no pM0.
- **Stage groups are prognostic groups only.** They say nothing about
  resectability, treatment, or this patient.
