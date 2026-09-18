/**
 * Build the offline icon bundle.
 *
 *   node scripts/build-icons.mjs      (npm run icons)
 *
 * Reads scripts/icon-manifest.mjs, pulls each icon's resolved body out of
 * @iconify-json/ph and @iconify-json/healthicons with @iconify/utils, and
 * writes src/ui/iconData.ts.
 *
 * Why generate instead of importing the JSON: `@iconify-json/ph/icons.json` is
 * 9161 icons and ~3 MB, and a JSON import cannot be tree-shaken. The generated
 * file carries only what the manifest lists (~130 icons, tens of kB) and means
 * the app makes NO network request for icons — a hard requirement, since both
 * servers bind 127.0.0.1 and there is no CDN at runtime (CLAUDE.md).
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { getIconData } from '@iconify/utils';
import { PHOSPHOR, HEALTH } from './icon-manifest.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, '..', 'src', 'ui', 'iconData.ts');

const ph = require('@iconify-json/ph/icons.json');
const healthicons = require('@iconify-json/healthicons/icons.json');

const missing = [];

/** Resolve one icon to a compact `{body, width, height}` record. */
function pull(set, name, where) {
  const data = getIconData(set, name);
  if (!data || !data.body) {
    missing.push(`${where}:${name}`);
    return null;
  }
  return {
    body: data.body,
    width: data.width ?? set.width ?? 24,
    height: data.height ?? set.height ?? 24,
  };
}

/** Phosphor's fill cut is the same name with a `-fill` suffix. */
const entries = [];

for (const [key, name] of Object.entries(PHOSPHOR)) {
  const regular = pull(ph, name, 'ph');
  if (!regular) continue;
  const fill = pull(ph, `${name}-fill`, 'ph-fill');
  entries.push([key, regular, fill]);
}

for (const [key, pair] of Object.entries(HEALTH)) {
  const regular = pull(healthicons, pair.outline, 'healthicons');
  if (!regular) continue;
  const fill = pull(healthicons, pair.fill, 'healthicons-fill');
  entries.push([key, regular, fill]);
}

if (missing.length) {
  // A missing name is a manifest bug, not a runtime fallback: fail loudly so
  // nobody ships a blank square.
  console.error(`\n  ${missing.length} icon(s) not found in their set:\n   ${missing.join('\n   ')}\n`);
  process.exit(1);
}

const json = (v) => JSON.stringify(v);

const lines = [];
lines.push('/* eslint-disable */');
lines.push('/**');
lines.push(' * GENERATED FILE — do not edit by hand.');
lines.push(' *');
lines.push(' * Written by `npm run icons` from scripts/icon-manifest.mjs. Holds the raw');
lines.push(' * bodies of every icon Margin draws, inlined so no network request is ever');
lines.push(' * made for an icon (CLAUDE.md: no CDN at runtime).');
lines.push(' *');
lines.push(' * Phosphor — MIT — https://phosphoricons.com');
lines.push(' * Health Icons — CC0 — https://healthicons.org');
lines.push(' */');
lines.push('import type { IconifyIcon } from \'@iconify/types\';');
lines.push('');
lines.push('export interface IconPair {');
lines.push('  /** Line cut — the resting state. */');
lines.push('  regular: IconifyIcon;');
lines.push('  /** Solid cut — the active state. Falls back to `regular` when the set has none. */');
lines.push('  fill: IconifyIcon;');
lines.push('}');
lines.push('');
lines.push('export const ICON_DATA = {');
for (const [key, regular, fill] of entries) {
  const solid = fill ?? regular;
  lines.push(`  ${key}: {`);
  lines.push(`    regular: { body: ${json(regular.body)}, width: ${regular.width}, height: ${regular.height} },`);
  lines.push(`    fill: { body: ${json(solid.body)}, width: ${solid.width}, height: ${solid.height} },`);
  lines.push('  },');
}
lines.push('} as const satisfies Record<string, IconPair>;');
lines.push('');
lines.push('/** Every icon name Margin knows. Anything else is a compile error. */');
lines.push('export type IconName = keyof typeof ICON_DATA;');
lines.push('');

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, lines.join('\n'), 'utf8');

const bytes = Buffer.byteLength(lines.join('\n'), 'utf8');
console.log(
  `icons: ${entries.length} names -> src/ui/iconData.ts (${(bytes / 1024).toFixed(1)} kB)`,
);
