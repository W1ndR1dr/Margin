/**
 * Headless capture of the Margin interface.
 *
 * CLAUDE.md forbids capturing the desktop; the only sanctioned way to look at
 * the UI is the app's own browser tab or headless Chrome pointed at
 * 127.0.0.1:5173. This script is the second of those: it drives the running
 * dev server with puppeteer-core and the system Chrome, and writes app-only
 * PNGs into tools/.
 *
 *   node tools/capture_ui.mjs                 # phantom screens only
 *   node tools/capture_ui.mjs --hanseg        # also the HaN-Seg CT and MR
 *
 * Anything rendered from HaN-Seg pixel data is written with `hanseg` in the
 * filename, which .gitignore already excludes (CC BY-NC-ND, NoDerivatives).
 *
 * puppeteer-core is a dev-time convenience, installed with `--no-save`:
 *   npm install --no-save puppeteer-core@23
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));

// puppeteer-core lives in frontend/node_modules, and ESM resolution walks up
// from THIS file (tools/), not from the cwd — so resolve it explicitly.
const requireFromFrontend = createRequire(join(HERE, '..', 'frontend', 'package.json'));
const puppeteer = requireFromFrontend('puppeteer-core');
const OUT = HERE;
const APP = 'http://127.0.0.1:5173';
const BACKEND = { host: '127.0.0.1', port: 8765 };

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const VIEW = { width: 1680, height: 1000, deviceScaleFactor: 1 };

/** Phantom geometry, straight out of backend/hnrad/phantom.py. */
const PHANTOM = {
  // slice 115 of 180, z = -89.5 + k
  z: 25.5,
  sliceIndex: 115,
  icaRightCentre: [-20.375, -8.375, 25.5],
  icaRadiusMm: 3.5,
  tumourCentre: [-11.6, -19.4, 25.5],
  tumourRadiusMm: 12.5,
};

/* ------------------------------------------------------------------ */

function api(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ ...BACKEND, path }, (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => {
          try {
            resolve(JSON.parse(b));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromePath() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('No Chrome or Edge found. Set CHROME_PATH.');
  return process.env.CHROME_PATH || found;
}

/** Wait until a predicate evaluated in the page returns true. */
async function until(page, fn, { timeout = 60_000, every = 250, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn)) return true;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(every);
  }
}

async function shot(page, name) {
  const path = join(OUT, name);
  await page.screenshot({ path });
  const n = name.padEnd(34);
  console.log(`  ${n} written`);
}

/** World (LPS mm) -> page pixels, through the axial viewport's own transform. */
async function worldToPage(page, pane, world) {
  return page.evaluate(
    (paneId, w) => {
      const m = window.__margin;
      const vp = m.viewer.getViewport(paneId);
      const el = m.viewer.getElement(paneId);
      if (!vp || !el || !vp.worldToCanvas) return null;
      const c = vp.worldToCanvas(w);
      const r = el.getBoundingClientRect();
      return { x: r.left + c[0], y: r.top + c[1] };
    },
    pane,
    world,
  );
}

/* ------------------------------------------------------------------ */
/* the interactions                                                    */
/* ------------------------------------------------------------------ */

async function openSeries(page, uid) {
  await page.evaluate(async (u) => {
    const res = await fetch(`/api/series/${encodeURIComponent(u)}`);
    const detail = await res.json();
    const mod = await import('/src/library.ts');
    await mod.openSeries(detail);
  }, uid);
  await until(page, () => window.__margin.store.getState().panes.axial.total > 0, {
    label: 'volume on screen',
  });
  // Let the stream fill in so the capture is not of a half-loaded volume.
  await until(page, () => !window.__margin.store.getState().loading.active, {
    label: 'streaming to finish',
    timeout: 120_000,
  });
  await sleep(900);
}

/** Quick-add the bone threshold so the Structures list and 3D have content. */
async function addStructures(page) {
  await page.evaluate(() => window.__margin.quickAdd('bone'));
  await until(page, () => window.__margin.structures.getState().items.length > 0, {
    label: 'a structure',
    timeout: 180_000,
  });
  await until(page, () => window.__margin.structures.getState().busy === null, {
    label: 'segmentation to settle',
    timeout: 180_000,
  });
  // Also wait for the per-row work (mask fetch, surface build). A pointer
  // interaction started while the 3D surface is still being attached races
  // Cornerstone's actor bookkeeping and the drag is silently dropped.
  await until(page, () => window.__margin.structures.getState().items.every((r) => !r.busy), {
    label: 'surfaces to finish',
    timeout: 180_000,
  });
  await sleep(2500);
}

/**
 * Drive the carotid tool for real: circle the right ICA lumen, then trace the
 * tumour, both on the axial view at the slice the phantom puts them on.
 */
async function runCarotid(page) {
  // Layout first, then let React settle, then navigate — the resize that
  // follows a grid change has to land before the jump, not after it.
  await page.evaluate(() => {
    window.__margin.store
      .getState()
      .set({ grid: '1x1', primaryPane: 'axial', activePane: 'axial' });
  });
  await sleep(700);
  // Scroll to the slice the way the scrubber does. Converging rather than
  // one-shot, because the tumour has to be on screen for the trace to mean
  // anything and a single scroll can be swallowed while actors attach.
  for (let attempt = 0; attempt < 8; attempt++) {
    const at = await page.evaluate(() => window.__margin.store.getState().panes.axial.slice);
    if (Math.abs(at - PHANTOM.sliceIndex) <= 1) break;
    await page.evaluate((k) => window.__margin.viewer.setSlice('axial', k), PHANTOM.sliceIndex);
    await sleep(400);
    if (attempt === 7) console.log(`  warning: axial landed on slice ${at + 1}`);
  }

  const map = (w) =>
    page.evaluate((ww) => {
      const m = window.__margin;
      const vp = m.viewer.getViewport('axial');
      const el = m.viewer.getElement('axial');
      if (!vp?.worldToCanvas || !el) return null;
      const c = vp.worldToCanvas(ww);
      const r = el.getBoundingClientRect();
      return { x: r.left + c[0], y: r.top + c[1] };
    }, w);

  /*
   * 1. the lumen circle: centre -> wall.
   *
   * Synthetic input has to be slow enough for Cornerstone to see a DRAG
   * rather than a click, and the first attempt after a layout change is
   * sometimes swallowed while actors are still attaching — so retry.
   */
  const c = await map(PHANTOM.icaRightCentre);
  const edge = await map([
    PHANTOM.icaRightCentre[0] + PHANTOM.icaRadiusMm,
    PHANTOM.icaRightCentre[1],
    PHANTOM.icaRightCentre[2],
  ]);
  if (!c || !edge) throw new Error('could not map the ICA to the canvas');

  let circled = false;
  for (let attempt = 1; attempt <= 4 && !circled; attempt++) {
    await page.evaluate(() => window.__margin.carotid.start());
    await sleep(500 + attempt * 300);
    // Belt and braces: assert the drag will be read as a CircleROI and not as
    // a Crosshairs rotation, which is what a stray drag does otherwise.
    const armed = await page.evaluate(() => {
      window.__margin.viewer.setActiveTool('CircleROI');
      return window.__margin.store.getState().activeTool;
    });
    if (armed !== 'CircleROI') console.log(`  active tool is ${armed}, not CircleROI`);
    await sleep(250);

    await page.mouse.move(c.x, c.y);
    await sleep(120);
    await page.mouse.down();
    await sleep(120);
    for (let t = 1; t <= 20; t++) {
      await page.mouse.move(c.x + ((edge.x - c.x) * t) / 20, c.y + ((edge.y - c.y) * t) / 20);
      await sleep(30);
    }
    await sleep(150);
    await page.mouse.up();
    await sleep(800);

    const after = await page.evaluate(() => ({
      phase: window.__margin.carotidStore.getState().phase,
      hint: window.__margin.carotidStore.getState().hint,
    }));
    circled = after.phase === 'tumor';
    if (!circled) console.log(`  circle attempt ${attempt}: phase=${after.phase} hint=${after.hint}`);
  }
  if (!circled) return false;

  /*
   * 2. the tumour contour.
   *
   * Traced from the pixels rather than drawn as an ellipse: ray-cast out from
   * the tumour centre and stop where the HU leaves the lesion's own window.
   * That follows the real margin, including the notch the ICA carves into it,
   * so the contact angle the tool reports is a measurement of the phantom and
   * not of my approximation of it.
   */
  const ring = await page.evaluate((T) => {
    const m = window.__margin;
    const hu = (x, y, z) => {
      const ijk = m.viewer.worldToIjk([x, y, z]);
      return ijk ? m.viewer.huAtIjk(ijk) : null;
    };
    const [cx, cy, cz] = T.centre;
    const centreHu = hu(cx, cy, cz) ?? 75;
    // The phantom carries per-voxel noise, so a single out-of-window sample is
    // not an edge. Require a run of them, and median-smooth the radii, or the
    // traced contour comes out as a star.
    const lo = centreHu - 34;
    const hi = centreHu + 34;
    const N = 72;
    const radii = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      let last = T.minR;
      let miss = 0;
      for (let r = T.minR; r <= T.maxR; r += 0.3) {
        const v = hu(cx + Math.cos(a) * r, cy + Math.sin(a) * r, cz);
        if (v === null || v < lo || v > hi) {
          miss += 1;
          if (miss >= 4) break;
        } else {
          miss = 0;
          last = r;
        }
      }
      radii.push(last);
    }
    const smooth = radii.map((_, i) => {
      const w = [-2, -1, 0, 1, 2].map((d) => radii[(i + d + N) % N]).sort((p, q) => p - q);
      return w[2];
    });
    // A surgeon traces the margin ON the wall, not a voxel short of it — and
    // the ray stops one sample before the bright vessel. Add that back, or the
    // contour floats just outside the carotid and reads as zero contact.
    return smooth.map((r, i) => {
      const a = (i / N) * Math.PI * 2;
      const rr = Math.min(T.maxR, r + 1.2);
      return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, cz];
    });
  }, { centre: PHANTOM.tumourCentre, minR: 2.5, maxR: 22 });

  const first = await map(ring[0]);
  if (!first) throw new Error('could not map the tumour to the canvas');
  await page.mouse.move(first.x, first.y);
  await sleep(90);
  await page.mouse.down();
  await sleep(90);
  for (const w of ring.slice(1)) {
    const q = await map(w);
    if (q) {
      await page.mouse.move(q.x, q.y);
      await sleep(14);
    }
  }
  await page.mouse.move(first.x, first.y);
  await sleep(120);
  await page.mouse.up();
  await sleep(1100);

  const out = await page.evaluate(() => {
    const st = window.__margin.carotidStore.getState();
    return {
      phase: st.phase,
      hint: st.hint,
      angle: st.result?.angleDeg ?? null,
      severity: st.result?.severity ?? null,
      slice: st.result?.sliceIndex ?? null,
    };
  });
  console.log(
    `  carotid: phase=${out.phase} angle=${
      out.angle === null ? 'none' : out.angle.toFixed(1) + '\u00b0'
    } severity=${out.severity} slice=${out.slice === null ? '-' : out.slice + 1}${
      out.hint ? ` hint="${out.hint}"` : ''
    }`,
  );
  if (out.angle !== null) {
    await page.evaluate(() => window.__margin.carotid.addToMeasurements());
    await sleep(500);
  }
  return out.angle !== null;
}

/* ------------------------------------------------------------------ */

async function main() {
  const wantHanseg = process.argv.includes('--hanseg');
  mkdirSync(OUT, { recursive: true });

  const studies = await api('/api/studies');
  const phantomStudy = studies.find((s) => /PHANTOM/i.test(s.patient_name || ''));
  if (!phantomStudy) throw new Error('the phantom study is not in the library');
  const phantomSeries = (await api(`/api/studies/${phantomStudy.study_uid}/series`)).find(
    (s) => s.is_3d,
  );

  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    defaultViewport: VIEW,
    args: [
      `--window-size=${VIEW.width},${VIEW.height}`,
      // WebGL in headless Chrome needs SwiftShader unless a GPU is exposed.
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-gpu-sandbox',
      '--no-sandbox',
      '--hide-scrollbars',
    ],
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('  [page error]', e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') console.error('  [console]', m.text());
    });

    await page.goto(APP, { waitUntil: 'networkidle2', timeout: 90_000 });
    await until(page, () => Boolean(window.__margin), { label: 'the app to boot' });
    await until(page, () => window.__margin.store.getState().studies.length > 0, {
      label: 'the library',
    });
    await sleep(700);

    console.log('phantom:');
    await shot(page, 'ui_v2_library.png');

    await openSeries(page, phantomSeries.series_uid);
    await shot(page, 'ui_v2_read_strip.png');

    await addStructures(page);
    await page.evaluate(() => window.__margin.store.getState().set({ panelTab: 'structures' }));
    await sleep(500);
    await shot(page, 'ui_v2_structures.png');

    const gotCarotid = await runCarotid(page);
    await page.evaluate(() =>
      window.__margin.store.getState().set({ grid: 'strip', panelTab: 'findings' }),
    );
    await sleep(900);
    await shot(page, gotCarotid ? 'ui_v2_read_carotid.png' : 'ui_v2_read_carotid_FAILED.png');

    await page.evaluate(() => window.__margin.store.getState().set({ panelTab: 'findings' }));
    await sleep(400);
    await shot(page, 'ui_v2_findings.png');

    await page.evaluate(() => window.__margin.store.getState().set({ grid: '2x2' }));
    await sleep(900);
    await shot(page, 'ui_v2_layout_2x2.png');

    // Ask drawer, with a real question through the stub transport.
    await page.evaluate(() =>
      window.__margin.store.getState().set({ grid: 'strip', askOpen: true }),
    );
    await sleep(500);
    await page.evaluate(async () => {
      const mod = await import('/src/tools/ask/index.ts');
      const labels = window.__margin.structures.getState().items.map((s) => s.name);
      await mod.ask('How much carotid contact is there?', {
        modality: 'CT',
        sequence: null,
        structureNames: labels,
        findings: [],
        measurements: window.__margin.store.getState().measurements,
      });
    });
    await sleep(800);
    await shot(page, 'ui_v2_ask.png');

    await page.evaluate(() =>
      window.__margin.store.getState().set({ askOpen: false, shortcutsOpen: true }),
    );
    await sleep(500);
    await shot(page, 'ui_v2_shortcuts.png');
    await page.evaluate(() =>
      window.__margin.store.getState().set({ shortcutsOpen: false, paletteOpen: true }),
    );
    await sleep(500);
    await page.keyboard.type('caro');
    await sleep(400);
    await shot(page, 'ui_v2_palette.png');
    await page.evaluate(() => window.__margin.store.getState().set({ paletteOpen: false }));

    if (wantHanseg) {
      console.log('hanseg (gitignored):');
      const hs = studies.filter((s) => /HANSEG/i.test(s.patient_name || ''));
      const st = hs[0];
      const series = await api(`/api/studies/${st.study_uid}/series`);
      const ct = series.find((s) => s.modality === 'CT' && s.is_3d);
      const mr = series.find((s) => s.modality === 'MR' && s.is_3d);

      if (ct) {
        await openSeries(page, ct.series_uid);
        await page.evaluate(() => window.__margin.store.getState().set({ panelTab: 'findings' }));
        await sleep(600);
        await shot(page, 'ui_v2_hanseg_ct.png');
      }
      if (mr) {
        await openSeries(page, mr.series_uid);
        await sleep(800);
        const w = await page.evaluate(() => {
          const s = window.__margin.store.getState();
          return { ww: s.panes.axial.ww, wc: s.panes.axial.wc, src: s.windowSource, primary: s.primaryPane };
        });
        console.log(`  MR auto window: W${w.ww} L${w.wc} (${w.src}), primary=${w.primary}`);
        await shot(page, 'ui_v2_hanseg_mr.png');

        await page.evaluate(
          (uid) => window.__margin.store.getState().set({ screen: 'library', expandedStudy: uid }),
          st.study_uid,
        );
        await until(
          page,
          () => {
            const s = window.__margin.store.getState();
            return Boolean(s.expandedStudy && s.seriesByStudy[s.expandedStudy]);
          },
          { label: 'the series list' },
        );
        await sleep(1600);
        await shot(page, 'ui_v2_hanseg_sequences.png');
      }
    }

    const errs = await page.evaluate(() => window.__marginErrors ?? []);
    if (errs.length) console.error('page errors:', errs);
  } finally {
    await browser.close();
  }
  console.log('done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
