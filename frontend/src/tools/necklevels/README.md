# Neck level mapper

Pure TypeScript implementation of TOOLS-SPEC.md section 3 (Robbins 2008 / AJCC
radiologic neck levels). No React, no Cornerstone, no DOM — the UI wires it in
separately and only ever hands it numbers.

```ts
import { classifyNode, tallyLevels, neckDissectionSuggestion, levelBands } from '@/tools/necklevels';

const result = classifyNode([-30, 8, 110], landmarks);
// { level: 'IIa', side: 'right', confidence: 'boundary', marginMm: 0.85, reasons: [...] }
```

## Files

| file | contents |
| --- | --- |
| `types.ts` | `Point3`, `SideLandmarks`, `Landmarks`, `NeckLevel`, `Side`, `LevelResult` |
| `classify.ts` | `classifyNode`, `classifyNodes`, and the polyline / midline helpers |
| `tally.ts` | `tallyLevels`, `sideSuggestion`, `neckDissectionSuggestion`, `neckDissectionSummary` |
| `bands.ts` | `levelBands`, `bandAtZ` — translucent band geometry for the sagittal / coronal views |
| `fixtures.ts` | `SYNTHETIC_LANDMARKS` — a plausible synthetic neck for tests and demos |
| `index.ts` | barrel re-export |
| `classify.test.ts` | vitest suite |

## Coordinate conventions

Everything is DICOM LPS millimetres, identical to the world coordinates the
viewer reports as `probe.lps` in `viewer/ViewerCore.ts`:

- `+x` = patient **left**. The patient's **right** side therefore has
  `x < midline`, and the fixture's right-side landmarks all carry negative x.
- `+y` = **posterior**. "Anterior to" means a **smaller** y.
- `+z` = **superior**. "Above" means a **larger** z.

Comparisons follow from that:

- **Anterior / posterior** tests compare the node's `y` against the landmark's
  `y` interpolated at the node's `z`.
- **Medial / lateral** tests compare `|x - midline|` against
  `|landmark.x - midline|`, so the same rule works on both sides.
- Polyline landmarks (SCM posterior border, IJV, carotid) are sampled at
  various z and interpolated **linearly** at the node's z, **clamped** to the
  first / last sample outside the sampled range.
- Midline is `landmarks.midlineX` when given, else the mean of the two carotid
  medial edges at that z, else 0.

## Rules

Evaluated in this order; the first match wins.

| # | test | result |
| --- | --- | --- |
| 0 | `z > skullBaseZ` | `unclassified` |
| 1 | `z < clavicleZ` | `VII` |
| 2 | `z >= hyoidInferiorZ` **and** medial to the carotid medial edge **and** posterior to the carotid | `RP` |
| 3 | posterior to the SCM posterior border | `Va` if `z >= cricoidInferiorZ`, else `Vb` |
| 4 | `z >= hyoidInferiorZ` and anterior to the submandibular gland posterior border | `Ia` if medial **and** anterior to the anterior digastric landmark, else `Ib` |
| 5 | `z >= hyoidInferiorZ` (so: posterior to the gland, anterior to the SCM) | `IIb` if posterior to the IJV posterior edge, else `IIa` |
| 6 | medial to the carotid medial edge (below the hyoid, above the clavicle) | `VI` |
| 7 | lateral to the carotid | `III` if `z >= cricoidInferiorZ`, else `IV` |

### Where the order differs from the spec's listing order, and why

- **VII is tested before III / IV / V.** The spec bounds level V explicitly at
  the clavicle but leaves level IV open-ended; taken literally, an
  infraclavicular lateral node would be IV. Testing `z < clavicleZ` first makes
  everything below the sternal notch VII, which is what rule 7 of the spec
  intends.
- **RP is tested before I / II.** The spec lists RP last, but a retropharyngeal
  node is above the hyoid, posterior to the submandibular gland and anterior to
  the SCM posterior border, so rule 2 of the spec would classify it as level II
  and RP would be unreachable.
- **V is tested before I / II.** Level II requires "anterior to the SCM
  posterior border", so a node above the hyoid but posterior to the SCM belongs
  to Va. Hoisting the V test makes that explicit rather than leaving it to fall
  through.

## `marginMm` and `confidence`

`marginMm` is the smallest absolute distance from the centroid to **any
boundary the classifier actually consulted** — z planes, y borders and
`|x - midline|` borders alike. Comparisons that were short-circuited away are
not counted, so the margin always describes the decision that was made.
`confidence` is `'boundary'` when `marginMm < 5` (`BOUNDARY_MARGIN_MM`), else
`'clear'`. A node with no consultable boundary gets `marginMm = Infinity` and
`confidence = 'clear'`.

`reasons` is the same trace in words, in evaluation order, e.g.

```
above skull base plane by 70.0 mm
above clavicle / sternal notch plane by 105.0 mm
above hyoid plane by 20.0 mm
lateral to carotid medial edge by 10.8 mm
posterior to submandibular gland posterior border by 18.0 mm
anterior to IJV posterior edge by 0.8 mm
```

## Sides

`side` is geometric: `x < midline` is `'right'`, `x > midline` is `'left'`, and
`|x - midline| <= 2` (`MIDLINE_TOLERANCE_MM`) is `'midline'`. Landmark lookup
always uses the left/right sign even when the reported side is `'midline'`.
Note that this is purely positional — Ia, VI and VII are midline levels
clinically, but a node 8 mm off the midline in level VI is still reported on
that geometric side rather than being forced to `'midline'`.

## Optional landmarks and their defaults

| landmark | when absent |
| --- | --- |
| `skullBaseZ` | no superior limit; nothing is `unclassified` for being too high |
| `clavicleZ` | no inferior limit; level VII is never assigned |
| `midlineX` | mean of the two carotid medial edges at that z, else 0 |
| `ijvPosteriorEdge` | `ijvCenter` shifted **5 mm posterior** (`+y`); this is the IIa / IIb divider, so supplying the real edge materially improves that split |
| `digastricAnteriorMedial` | level I is always reported as `Ib` |
| `carotidMedial` | the medial/lateral test is skipped, and **VI and RP can never be assigned** |

A missing or empty `scmPosteriorBorder` or `ijvCenter` yields `unclassified`
with the reason naming the missing landmark.

## Limitations — read before trusting the output

- **No pharyngeal wall landmark exists**, so RP cannot use its real definition
  ("posterior to the pharyngeal wall, medial to the ICA, anterior to the
  prevertebral muscles"). The simplified stand-in is: at or above the hyoid,
  medial to the carotid medial edge, and posterior to the carotid. It will
  over-call medial-and-posterior nodes that are really high level II, and it
  cannot distinguish retropharyngeal from prevertebral.
- **Ia vs Ib is a quadrant test, not a muscle model.** With only one
  `digastricAnteriorMedial` point per side, the anterior belly is modelled as
  an axis-aligned corner and `Ia` is the anteromedial quadrant of it (medial in
  `|x - midline|` **and** at or anterior in `y`). The real submental triangle is
  a wedge that widens posteriorly toward the hyoid, so a node that is medial but
  posterior to the landmark is called `Ib` here where the true triangle might
  contain it. Sampling the anterior belly as a polyline would fix this.
- **The IIa / IIb fat plane is not modelled.** The spec mentions "posterior to
  the IJV posterior edge (with a fat plane)"; this implementation uses the edge
  itself, with no extra tolerance.
- **No anterior bound on level VI**, no mandible plane bounding level I
  superiorly, and no posterior (prevertebral / trapezius) bound on level V. A
  node outside the neck laterally or anteriorly is still assigned a level.
- **`marginMm` is a per-axis distance, not a true 3-D distance** to a boundary
  surface: boundaries are compared one coordinate at a time, which is what the
  spec's "more than 5 mm from every boundary" wording describes.
- **Level V has no z band of its own** in `levelBands`, because Va and Vb share
  the III and IV z ranges and are separated from them only in the axial plane.
- **Everything is landmark quality in, level quality out.** Sparse polyline
  sampling is interpolated linearly, so a landmark that curves between samples
  is approximated by a chord.

## Neck dissection suggestion

`neckDissectionSuggestion(tally)` returns one plain-English line per side that
has nodes, in the fixed order right, left, midline (`neckDissectionSummary`
joins them, or returns `'No nodes classified.'`). It is deliberately
conservative: it names the involved levels, gives the contiguous Roman-numeral
range they span, notes when that range is not contiguous, and appends the fixed
`(+ Ib if oral cavity primary)` reminder only when Ib is not already involved.
RP and unclassified nodes are reported as separate clauses and never folded
into the range. No other clinical rule is encoded here.

```
Right: levels IIa, IIb, III and IV involved; consider selective neck dissection II–IV (+ Ib if oral cavity primary)
```

## Tests

```powershell
cd C:\Users\o948145\hnrad\frontend
npx vitest run src/tools/necklevels
```
