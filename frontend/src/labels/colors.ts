/**
 * Structure colours.
 *
 * The anatomy tokens in DESIGN.md are the source of truth; Cornerstone wants
 * `[r, g, b]` 0..255, the panel wants a CSS colour, so both are kept together.
 * Anything that is not recognisable anatomy falls back to a fixed palette that
 * stays away from the anatomy hues so a threshold label is never mistaken for
 * a named organ.
 */

export type Rgb = [number, number, number];

export type AnatomyKey =
  | 'bone'
  | 'airway'
  | 'artery'
  | 'vein'
  | 'tumor'
  | 'node'
  | 'nerve'
  | 'gland'
  | 'muscle';

/** Structure categories used to group the Structures list. */
export type Category = 'bones' | 'vessels' | 'airway' | 'glands' | 'muscles' | 'nodal' | 'other';

export interface AnatomyToken {
  /** CSS custom property from tokens.css, for panel chrome. */
  token: string;
  hex: string;
  rgb: Rgb;
  category: Category;
}

/** DESIGN.md anatomy tokens (tokens.css `--bone`, `--airway`, …). */
export const ANATOMY: Record<AnatomyKey, AnatomyToken> = {
  bone: { token: '--bone', hex: '#e9e4d6', rgb: [233, 228, 214], category: 'bones' },
  airway: { token: '--airway', hex: '#7dd3fc', rgb: [125, 211, 252], category: 'airway' },
  artery: { token: '--artery', hex: '#f87171', rgb: [248, 113, 113], category: 'vessels' },
  vein: { token: '--vein', hex: '#60a5fa', rgb: [96, 165, 250], category: 'vessels' },
  tumor: { token: '--tumor', hex: '#e255a1', rgb: [226, 85, 161], category: 'other' },
  node: { token: '--node', hex: '#c084fc', rgb: [192, 132, 252], category: 'nodal' },
  nerve: { token: '--nerve', hex: '#fde68a', rgb: [253, 230, 138], category: 'other' },
  // Not in tokens.css; kept in the same family so an AI run reads as one set.
  gland: { token: '--gland', hex: '#5eead4', rgb: [94, 234, 212], category: 'glands' },
  muscle: { token: '--muscle', hex: '#fb923c', rgb: [251, 146, 60], category: 'muscles' },
};

/**
 * Fallback palette for structures with no anatomical identity (region grows,
 * ad-hoc thresholds). Deliberately off the anatomy hues.
 */
export const FALLBACK_PALETTE: Rgb[] = [
  [45, 212, 191],
  [163, 230, 53],
  [244, 114, 182],
  [56, 189, 248],
  [251, 191, 36],
  [167, 139, 250],
  [52, 211, 153],
  [248, 150, 30],
  [125, 211, 200],
  [217, 119, 255],
];

export function rgbToCss(rgb: Rgb): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
}

/* ------------------------------------------------------------------ */
/* name -> anatomy                                                    */
/* ------------------------------------------------------------------ */

interface Rule {
  key: AnatomyKey;
  /** Matched against the lower-cased, underscore-normalised structure name. */
  test: RegExp;
}

/**
 * Ordered: the first match wins, so the specific patterns (nodal levels,
 * named vessels) come before the broad ones (any "muscle").
 */
const RULES: Rule[] = [
  { key: 'node', test: /(^|[_\s])(level[_\s]?(i{1,3}v?|v[ab]?|vi{1,2}|[1-7])[ab]?|node|lymph|lnl|nodal)/ },
  { key: 'airway', test: /(airway|trachea|larynx|laryn|glottis|subglottic|bronch|lumen|sinus|nasal_cavity|pharynx|cavity)/ },
  { key: 'artery', test: /(artery|arteries|arterial|carotid|aorta|vertebral|subclavian|innominate|brachiocephalic|maxillary|facial_art)/ },
  { key: 'vein', test: /(vein|venous|jugular|\bijv\b|sinus_sag|sigmoid|brachioceph_ven)/ },
  // Cartilage before glands, or "thyroid_cartilage" would read as a gland.
  { key: 'bone', test: /(cartilage|hyoid|cricoid|mandible|maxilla|vertebra|skull|cranium|clavicle)/ },
  { key: 'gland', test: /(gland|parotid|submandibular|thyroid|sublingual|pituitary|lacrimal|eye|lens|cochlea)/ },
  { key: 'muscle', test: /(muscle|masseter|pterygoid|sternocleido|scm|constrictor|digastric|mylohyoid|genioglossus|longus|trapezius|temporalis)/ },
  { key: 'nerve', test: /(nerve|optic|chiasm|brachial_plexus|spinal_cord|cord)/ },
  { key: 'tumor', test: /(tumou?r|gtv|ctv|ptv|lesion|mass)/ },
  { key: 'bone', test: /(bone|bones|mandible|maxilla|vertebra|skull|cranium|clavicle|hyoid|cricoid|thyroid_cart|cartilage|scapula|sternum|rib|humerus|c[1-7]\b|craniofacial|zygoma|temporal|occipital|sphenoid|ethmoid|teeth|dental)/ },
];

/** Best-guess anatomy token for a structure name; null when nothing matches. */
export function anatomyForName(name: string): AnatomyKey | null {
  const n = name.toLowerCase().replace(/[-\s]+/g, '_');
  for (const r of RULES) if (r.test.test(n)) return r.key;
  return null;
}

export function categoryForName(name: string): Category {
  const key = anatomyForName(name);
  return key ? ANATOMY[key].category : 'other';
}

/** A colour for a structure: its anatomy token, else the fallback palette. */
export function colorForName(name: string, index = 0): Rgb {
  const key = anatomyForName(name);
  if (key) return ANATOMY[key].rgb;
  return FALLBACK_PALETTE[Math.abs(index) % FALLBACK_PALETTE.length];
}

export const CATEGORY_LABEL: Record<Category, string> = {
  bones: 'Bones',
  vessels: 'Vessels',
  airway: 'Airway',
  glands: 'Glands & organs',
  muscles: 'Muscles',
  nodal: 'Nodal levels',
  other: 'Other',
};

export const CATEGORY_ORDER: Category[] = [
  'bones',
  'vessels',
  'airway',
  'glands',
  'muscles',
  'nodal',
  'other',
];
