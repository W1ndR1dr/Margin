/**
 * The icon manifest — every glyph Margin is allowed to draw.
 *
 * Brian's rule (UI-OVERHAUL.md §1): no hand-drawn SVG paths. Icons come from
 * two professionally drawn open sets and nowhere else:
 *   - Phosphor (MIT)      `ph:*`          — the system set (rail, panels, chrome)
 *   - Health Icons (CC0)  `healthicons:*` — clinical marks only
 *
 * Nothing is fetched at runtime: `scripts/build-icons.mjs` reads this list and
 * writes `src/ui/iconData.ts` with the raw icon bodies inlined, so the bundle
 * carries ~120 icons instead of Phosphor's 9161. Add a name here, re-run
 * `npm run icons`, and it becomes available as `<Icon name="..." />`.
 *
 * Keys are Margin's own vocabulary, deliberately named after what the icon
 * MEANS here, not after the glyph — so swapping the art never touches call sites.
 */

/** Phosphor icons. The build script also pulls the `-fill` twin of each. */
export const PHOSPHOR = {
  /* ---- brand / chrome ---- */
  search: 'magnifying-glass',
  command: 'command',
  keyboard: 'keyboard',
  panelRight: 'sidebar-simple',
  close: 'x',
  check: 'check',
  checkCircle: 'check-circle',
  warning: 'warning',
  warningCircle: 'warning-circle',
  info: 'info',
  question: 'question',
  shieldCheck: 'shield-check',
  lock: 'lock-simple',
  spinner: 'circle-notch',
  dots: 'dots-three',
  gear: 'gear',
  sparkle: 'sparkle',
  ask: 'chat-teardrop-dots',
  send: 'paper-plane-tilt',

  /* ---- navigation / disclosure ---- */
  caretRight: 'caret-right',
  caretDown: 'caret-down',
  caretLeft: 'caret-left',
  caretUp: 'caret-up',
  arrowLeft: 'arrow-left',
  arrowRight: 'arrow-right',
  arrowUp: 'arrow-up',
  arrowDown: 'arrow-down',
  jump: 'arrow-bend-down-right',
  external: 'arrow-square-out',
  undo: 'arrow-u-up-left',

  /* ---- viewer: navigate group ---- */
  windowLevel: 'circle-half',
  pan: 'hand',
  zoom: 'magnifying-glass-plus',
  scroll: 'arrows-vertical',
  crosshair: 'crosshair-simple',

  /* ---- viewer: measure group ---- */
  length: 'ruler',
  bidirectional: 'arrows-out-line-horizontal',
  angle: 'angle',
  ellipseRoi: 'circle-dashed',
  rectangleRoi: 'bounding-box',
  freehandRoi: 'lasso',
  probe: 'eyedropper',

  /* ---- viewer: layout / output ---- */
  layoutStrip: 'layout',
  layoutQuad: 'squares-four',
  layoutSingle: 'square',
  layoutSplit: 'columns',
  volume3d: 'cube',
  play: 'play',
  pause: 'pause',
  reset: 'arrow-counter-clockwise',
  snapshot: 'camera',
  maximize: 'corners-out',
  minimize: 'corners-in',
  slab: 'stack-simple',
  invert: 'circle-half-tilt',
  link: 'link-simple',
  unlink: 'link-break',

  /* ---- library / data ---- */
  library: 'squares-four',
  study: 'folder-open',
  series: 'stack',
  image: 'image',
  images: 'images',
  folderAdd: 'folder-plus',
  drive: 'hard-drives',
  upload: 'upload-simple',
  download: 'download-simple',
  refresh: 'arrows-clockwise',
  trash: 'trash',
  copy: 'copy',
  plus: 'plus',
  minus: 'minus',
  eye: 'eye',
  eyeOff: 'eye-slash',
  pin: 'map-pin',
  calendar: 'calendar-blank',
  clock: 'clock-counter-clockwise',
  user: 'user',
  list: 'list-bullets',
  filter: 'funnel',
  sliders: 'sliders-horizontal',

  /* ---- findings / report ---- */
  findings: 'list-magnifying-glass',
  report: 'file-text',
  note: 'note-pencil',
  clipboard: 'clipboard-text',
  chart: 'chart-line',
  target: 'target',
  ruler: 'ruler',
  flask: 'flask',
  brain: 'brain',
  path: 'path',
  selection: 'selection-plus',
  wand: 'magic-wand',
  scissors: 'scissors',
  bracket: 'brackets-square',
  board: 'presentation-chart',
  compare: 'copy-simple',
  plan: 'compass-tool',
};

/**
 * Health Icons for clinical marks. The `-outline` cut is the line style that
 * sits next to Phosphor regular without shouting; the solid name (no suffix)
 * is the fill twin used for the active state.
 */
export const HEALTH = {
  neck: { outline: 'head-outline', fill: 'head' },
  ent: { outline: 'ears-nose-and-throat-outline', fill: 'ears-nose-and-throat' },
  node: { outline: 'lymph-nodes-outline', fill: 'lymph-nodes' },
  airway: { outline: 'lungs-outline', fill: 'lungs' },
  vessel: { outline: 'blood-vessel-outline', fill: 'blood-vessel' },
  tooth: { outline: 'tooth-outline', fill: 'tooth' },
  spine: { outline: 'spine-outline', fill: 'spine' },
  thyroid: { outline: 'thyroid-outline', fill: 'thyroid' },
  tumour: { outline: 'tumour-outline', fill: 'tumour' },
  oncology: { outline: 'oncology-outline', fill: 'oncology' },
  radiology: { outline: 'radiology-outline', fill: 'radiology' },
  xray: { outline: 'xray-outline', fill: 'xray' },
  ultrasound: { outline: 'ultrasound-scanner-outline', fill: 'ultrasound-scanner' },
  stethoscope: { outline: 'stethoscope-outline', fill: 'stethoscope' },
};
