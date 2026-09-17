# Margin UI overhaul brief (v2 shell)

Target: the concept canvas https://claude.ai/artifact/C2cx4phKhHwvfA2aqBj7WS and
DESIGN.md "v2 concept". Brian's instruction, verbatim: "I dont want generic
elements." Everything below is binding for the overhaul.

## 1. No generic elements

- No native browser controls anywhere: no `<input type=range>`, `<select>`,
  checkbox, radio, default `<button>` styling, default focus rings, default
  scrollbars in panels. Build: Toggle, Segmented, Slider (opacity, cine speed),
  Tabs, Chip, Pill, Tile, Drawer, Palette, Toast, Tooltip, Scrubber. One
  component each, in `src/ui/`, styled from tokens, keyboard-accessible, with
  a visible custom focus ring (2 px accent, 2 px offset).
- No lucide (or any stock icon set) in the product UI. A bespoke icon family
  in `src/ui/icons.tsx`: 20 px grid, 1.5 px stroke, round caps, one visual
  weight. Required marks: window/level, crosshairs, pan, zoom, scroll, length,
  bidirectional, angle, ellipse, freehand, probe, carotid (ring with an amber
  arc), airway (narrowing tube), node (three circles), mandible (horseshoe),
  segment (blob + outline), layout 1/2/4, snapshot, cine, reset, library,
  read, plan, compare, board, ask (four-point spark), local-only (shield dot),
  import (arrow into tray), structures (stacked layers).
- No emoji, no gradients washes, no drop shadows except popovers/drawer,
  no rounded-pill buttons everywhere, no card-on-card nesting.

## 2. Signature elements (only Margin has these)

- **Margin mark as progress.** Loading and job progress use the mark: the
  inner blob fills as a ring sweep, the offset contour pulses subtly. Used for
  volume streaming, AI jobs, imports.
- **Findings on the scrubber.** Every MPR viewport has a 4 px scrubber along
  its bottom edge with a tick every 10 slices and colored markers where
  findings live (warn amber, danger red, node violet, tumour magenta).
  Hover shows the finding title; click jumps.
- **Severity as shape + color.** Chips carry a glyph: dot (ok), half ring
  (caution), full ring (danger). Colorblind-safe by construction.
- **Evidence tiles.** Big JetBrains Mono number (28-40 px), 11 px label
  below, on --raised with a hairline. Used in findings, tool results, Ask.
- **Anatomy chip.** Bottom-right of the active viewport: swatch, structure
  name, HU. The matching Structures chip glows (hairline turns accent) while
  the cursor is over that structure.
- **Sent-to-Claude disclosure.** Dashed box under every Ask answer listing
  what left the machine. Never omitted.

## 3. Layout (from the canvas)

- Top bar 48 px: mark + "Margin"; patient banner (name bold, ID/age/sex mono,
  study description); study timeline chips (Prior/Current, current marked);
  workspace tabs Read / Plan / Compare / Board; Ask Margin bar (⌘K).
- Left rail 52 px: navigate, measure, head & neck tools, layout/snapshot;
  active tool on --raised with accent icon; tooltip "Name · key".
- Main: primary viewport (the plane being read) + 236 px context strip
  (SAG, COR, 3D structures) with 2 px gutters. Layout switch: primary+strip
  (default), 2x2, 1x1. Double-click / F still maximizes.
- Right panel 340 px, tabs: Findings (first) · Structures · Measure · Report.
  Findings rows: severity glyph, statement with the number in mono, one
  evidence line, slice link at right. Green rows for checked-and-normal.
- Ask Margin drawer 460 px replaces the right panel when open (Esc closes):
  user bubbles right, answers left with evidence tiles, criterion line with
  source, action buttons, disclosure box, suggestion chips, input at bottom.
- Status bar 26 px: HU · LPS · structure under cursor · slice · W/L · fps ·
  readiness ("anatomy ready · nodal levels ready") · Local only.
- Library: header with count line and store path; search that also accepts
  clinical queries as placeholder copy; drop zone with progress; table
  columns Patient / MRN / Latest study / Date / Anatomy / Flags; readiness
  pill (ready · n structures / segmenting % / queued); flags pills; right
  column tumour board list + background work + store size.

## 4. Type, color, motion

- Instrument Sans (UI) + JetBrains Mono (numbers, overlays, IDs). Tabular
  numerals on every numeric column. Sizes 11/12/13/14/15/22; weights 400/500/600.
- Tokens from DESIGN.md with --text-3 lightened to #6B7684.
- Motion 120 ms ease-out on hover/active; 180 ms for drawer/panel; the mark
  progress animates at 1.2 s loop; no bounce, no spring.

## 5. Keep working

Every v0.1/v0.2 behaviour must survive: library import, volume streaming,
crosshairs, presets, measurements, carotid tool (arc overlay), structures
(labelmaps, meshes, STL, distance), airway analyzer (chart, jump), AI panel
(jobs, structures), snapshot, hotkeys, command palette. `npm run build` and
`npm test` green. Verify in the browser with screenshots against the canvas.
