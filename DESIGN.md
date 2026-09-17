# Design system and product plan

Product name: **Margin** (chosen 2026-09-17). Repo/package code name stays `hnrad`.
The UI reads the name from one constant (`APP_NAME = "Margin"`).

## Name

**Margin.** The surgical margin is the whole point of the tool: knowing where
tumor ends and where you can safely cut. Short, plain English, works as a verb
in the clinic ("pull it up in Margin"). Earlier candidates (Hyoid, Atlas,
Cricoid, Sagitta) are retired.

Tagline options: "Know where to cut." / "See the neck clearly." /
"Surgical radiology, on your desk."

## Mark and icon

Primary mark: a tumor and its margin. A soft, slightly irregular rounded blob
(filled, teal) with a second contour offset outward by a constant distance
(stroked, teal, 2 units on a 24 unit grid, rounded joins). The gap between
the two is the margin. Optional: a single short tick crossing the gap at the
lower right, the measured distance. Teal on a near-black rounded-square tile
(radius 22 percent). Monochrome variants: white on black for the title bar,
black on white for print. It must survive at 16 px: at small sizes drop the
tick and keep only blob plus outline.

Files to produce: `frontend/public/icon.svg` (master), `icon-512.png`,
`icon-192.png`, `favicon.ico` (16/32), `icon-mono.svg`.

## Visual language

Dark by default (light theme later). Viewports are the hero and are the
darkest thing on screen; chrome is one step lighter; panels one more.

Color tokens (CSS custom properties on `:root`):

```
--canvas:      #0A0C10   viewport background, app background behind viewports
--panel:       #111419   side panels, top bar
--raised:      #181C23   cards, popovers, active tool button
--hairline:    rgba(255,255,255,0.08)
--hairline-2:  rgba(255,255,255,0.14)   hover borders
--text:        #E8ECF1
--text-2:      #9AA4B2
--text-3:      #5C6675   hints, disabled
--accent:      #2DD4BF   interactive, measurements, selection   (teal)
--accent-ink:  #04342C   text on accent fills
--warn:        #F5A524   caution, 180–270° encasement
--danger:      #F0554F   encasement >270°, errors
--ok:          #4ADE80
--tumor:       #E255A1   tumor segmentation, tumor contours
--node:        #C084FC   lymph nodes
--artery:      #F87171
--vein:        #60A5FA
--bone:        #E9E4D6
--airway:      #7DD3FC
--nerve:       #FDE68A
```

Typography: Inter for UI (13 px body, 12 px dense lists, 11 px captions,
15 px panel titles, weights 400 and 500 only). JetBrains Mono for anything
measured: overlays, HU values, coordinates, measurement values. Tabular
numerals everywhere numbers align.

Spacing on a 4 px grid. Control height 28 px in the toolbar, 32 px in forms.
Radius 6 px for controls, 10 px for cards. Hairline borders, no drop shadows
except popovers. Motion 120 ms ease-out, never bouncy. Focus ring 2 px accent.

Icons: lucide (outline, 1.5 px stroke, 18 px in the rail, 16 px in lists).

## Application shell

```
┌ top bar 44px ───────────────────────────────────────────────────────────┐
│ [mark] Margin   │ PHANTOM, NECK  ·  PHANTOM001  ·  56 M  ·  CT neck w/ contrast  ·  2026-09-17 │ Library  View  Plan  Compare  Report │ ⌘K │
├ rail 48px ┬ viewports ─────────────────────────────────────┬ panel 320px ┤
│ navigate   │  ┌──────────────┬──────────────┐               │ Measurements │
│ WL pan     │  │ axial        │ sagittal     │               │ Structures   │
│ zoom scrl  │  │              │              │               │ Tools        │
│ crosshair  │  ├──────────────┼──────────────┤               │ Report       │
│ ─────────  │  │ coronal      │ 3D           │               │              │
│ measure    │  │              │              │               │  (tab body)  │
│ ─────────  │  └──────────────┴──────────────┘               │              │
│ H&N tools  │                                                │              │
│ ─────────  │                                                │              │
│ layout 3D  │                                                │              │
├ status 24px ┴────────────────────────────────────────────────┴─────────────┤
│ HU 42  ·  L 12.3 P -8.1 S 104.0  ·  Ax 112/180  ·  W350 L40  ·  60 fps  ·  ● Local only │
└───────────────────────────────────────────────────────────────────────────┘
```

Left rail groups, top to bottom, each icon with tooltip "Name · hotkey":
1. Navigate: Window/Level (W), Pan (P), Zoom (Z), Scroll (S), Crosshairs (X)
2. Measure: Length (L), Bidirectional (B), Angle (A), Ellipse ROI (E),
   Rectangle ROI (T), Freehand ROI (D), Probe (H); Q cycles window presets
3. Head and neck tools: Carotid encasement (C), Node level (N), Airway (Y),
   Mandible (M), Segment (G)
4. Layout: 1×1, 1×2, 2×2, 3+1; 3D presets popover; Reset (R); Snapshot (K)

Viewport overlays (JetBrains Mono 11 px, 60 percent white, sharpen on hover):
top-left patient and study; top-right series and slice i/N; bottom-left W/L
and zoom; bottom-right orientation letters. A 2 px slice scrubber sits along
the bottom edge of every MPR viewport; hover shows the slice number, drag
scrolls. Active viewport has a 1 px accent inner border. Double-click or F
toggles maximize.

Right panel tabs:
- Measurements: dense bordered rows: icon, value in mono, orientation and
  slice, trash on hover. Click jumps. Footer: copy all, clear.
- Structures: segmentation layers with color swatch, name, volume in ml,
  visibility eye, opacity slider, "to 3D", "export STL".
- Tools: the active head-and-neck tool's guided panel. A stepper with one
  instruction per step ("1. Circle the carotid lumen", "2. Trace the tumor"),
  live result card with one big number, a category chip (abutment / partial
  / encasement) colored by severity, and "Add to report".
- Report: auto-composed findings list from measurements and tool results,
  each with its key image thumbnail; "Copy as text" for pasting into Epic;
  "Export tumor board slides".

Bottom status bar: HU and LPS under cursor, active slice, W/L, frame rate,
backend health dot, and a permanent "Local only" badge (reassurance that
nothing leaves the machine).

Command palette (Ctrl+K): every tool, preset, layout, patient and series is
reachable by typing. Keyboard cheat sheet on "?".

## Screens

1. **Library**: searchable patient table (name, MRN, last study, modalities,
   tumor board tag), study cards expanding to series thumbnails, drag-and-drop
   folder import with progress, recent studies, storage location shown.
2. **View**: the shell above. Hanging protocols: "Neck CT" (axial soft tissue,
   axial bone, coronal, 3D), "MPR" (three planes + 3D), "Single".
3. **Plan**: 3D-first layout. Large 3D viewport with structure list, mandible
   planner (osteotomy planes, defect length, fibula segments), airway cast,
   STL export.
4. **Compare**: prior and current side by side, registered, synced scroll and
   W/L, volume delta table, NI-RADS chip.
5. **Report**: findings, key images, measurements table, copy and export.

## Empty states and feedback

Backend down: a calm card with the exact command to start it and a retry
button. No studies: import drop zone with the studies folder path. Loading a
volume: thin accent progress bar under the top bar plus per-viewport skeleton
with the series name; MPR views become interactive as soon as the first
slices stream. Toasts bottom-center, 4 s, one line, undo where possible.

## Accessibility and ergonomics

Everything reachable by keyboard; hotkeys single-key without modifiers so a
gloved or one-handed user can drive it. Minimum 11 px text. Contrast ratio
4.5:1 for all text on panels. Colorblind-safe severity chips also carry a
label and a shape (dot, half, full ring).
