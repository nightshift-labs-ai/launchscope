// Screenshot tool for Launchscope (build-time only, never shipped in dashboard/).
//
//   PATH=/path/to/node22/bin:$PATH LD_LIBRARY_PATH=... node tools/shoot.mjs [--page out/dashboard/index.html]
//
// Opens the built page over file://, sets each view by its URL hash, and writes screenshots/<name>.png,
// or a JPEG when the PNG is over the byte budget: four images must fit a 1.5 MiB dossier once base64
// grows them by a third, so each stays under BUDGET bytes. Re-run main.ts afterwards so the dossier
// carries the new images.

import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};
const page = resolve(argOf('page', join(repo, 'out', 'dashboard', 'index.html')));
const only = argOf('only', null);
const BUDGET = Number(argOf('budget', 270000));
const VIEWPORT = { width: 1440, height: 1000 };
const pwDir = process.env.PLAYWRIGHT_DIR ?? '/home/agent/tools/pw/node_modules/';
const { chromium } = createRequire(pwDir)('playwright');

// Each view the judge sees: its file name and the URL hash that sets the page's state.
const SHOTS = [
  { name: '1-board', hash: '#board' },
  { name: '2-detail', hash: '#p/opentrade' },
  { name: '3-filtered', hash: '#board?fam=trade&verdict=farm&sort=perhour' },
  { name: '4-method', hash: '#method' },
];

if (!existsSync(page)) {
  console.error(`shoot: no page at ${page}: run main.ts into out/ first`);
  process.exit(2);
}
const outDir = join(repo, 'screenshots');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const tab = await ctx.newPage();
const errors = [];
tab.on('pageerror', (e) => errors.push(String(e)));
tab.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

for (const shot of SHOTS.filter((s) => !only || only.split(',').includes(s.name))) {
  await tab.goto(pathToFileURL(page).href + shot.hash);
  await tab.waitForSelector('#view *', { timeout: 15000 });
  await tab.waitForTimeout(400);
  let bytes = await tab.screenshot({ type: 'png' });
  let ext = 'png';
  for (const quality of [88, 82, 76, 70]) {
    if (bytes.length <= BUDGET) break;
    bytes = await tab.screenshot({ type: 'jpeg', quality });
    ext = 'jpg';
  }
  for (const old of readdirSync(outDir)) if (old.startsWith(`${shot.name}.`)) rmSync(join(outDir, old));
  writeFileSync(join(outDir, `${shot.name}.${ext}`), bytes);
  console.log(`shoot: ${shot.name}.${ext} ${(bytes.length / 1024).toFixed(0)} KiB`);
}
await browser.close();
if (errors.length) {
  console.error(`shoot: the page logged errors:\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
const total = readdirSync(outDir).reduce((n, f) => n + statSync(join(outDir, f)).size, 0);
console.log(`shoot: screenshots/ holds ${(total / 1024).toFixed(0)} KiB (base64 in the dossier: ${((total * 4) / 3 / 1024).toFixed(0)} KiB)`);
