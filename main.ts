// Launchscope: a token launch radar for make.fun's token-radar-01 (Node 22, standard library only).
//
// Reads the sealed DefiLlama snapshot (/input/snapshot.json, or --input <file|dir>), and runs the value
// model in dashboard/model.js: the very file the page loads, so the judge reads the function that wrote
// every number on the board. Writes /output/board.json (the ranked protocols that record no token, each
// with a costed farm plan), /output/data.js (the raw inputs the page re-derives everything from), copies
// dashboard/ and screenshots/ to /output, and writes /output/dossier.json with the vendored library.
//
// Deterministic: no clock, no unseeded randomness, every sort has a slug tie-break, so two runs write the
// same bytes. Outside the grader, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
// The shared model: a classic script that sets globalThis.Launchscope and module.exports.
const L = require('./dashboard/model.js');

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}
interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

function fail(message: string, code = 1): never {
  process.stderr.write(`launchscope: ${message}\n`);
  process.exit(code);
}

/** --name <value> or --name=<value>, else the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

/** The snapshot, refused unless every protocol carries the ten fields with the types the model reads. */
function parseSnapshot(text: string): Snapshot {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) fail('snapshot.json lacks protocols or watchlist');
  if (typeof raw.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.as_of)) fail('snapshot.json lacks a YYYY-MM-DD as_of');
  const nullable = (v: unknown, t: string) => v === null || typeof v === t;
  for (const p of raw.protocols) {
    const ok = typeof p === 'object' && p !== null && typeof p.slug === 'string' && typeof p.name === 'string' && p.name !== '' &&
      Array.isArray(p.chains) && typeof p.tvl_usd === 'number' && p.tvl_usd > 0 && nullable(p.category, 'string') &&
      nullable(p.change_7d, 'number') && nullable(p.mcap_usd, 'number') && nullable(p.listed_at, 'string') &&
      nullable(p.gecko_id, 'string') && nullable(p.symbol, 'string');
    if (!ok) fail(`snapshot protocol ${JSON.stringify(p?.slug)} is not the ten-field shape`);
  }
  return {
    as_of: raw.as_of,
    source: typeof raw.source === 'string' ? raw.source : '',
    floor_usd: typeof raw.floor_usd === 'number' ? raw.floor_usd : 50_000_000,
    protocols: raw.protocols,
    watchlist: raw.watchlist.filter((s: unknown) => typeof s === 'string'),
  };
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount /input`, 2);
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
const snap = parseSnapshot(readFileSync(inputFile, 'utf8'));

// ---------------------------------------------------------------- the model

const radar = L.buildRadar(snap);
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

const board = radar.rows.map((row: any) => ({
  rank: row.rank,
  slug: row.p.slug,
  name: row.p.name,
  implied_value_usd: row.iv.value,
  farm_steps: [...row.plan.steps.map((s: any) => L.stepText(s, row.plan.weeks)), L.summaryText(row.plan, row.iv.value)],
  token_status: 'records no token',
  on_watchlist: row.watch,
  category: row.p.category,
  chains: row.p.chains,
  tvl_usd: row.p.tvl_usd,
  change_7d: row.p.change_7d,
  listed_at: row.p.listed_at,
  days_without_token: row.iv.days,
  value_parts: { size_curve_usd: Math.round(row.iv.base), family: row.iv.fam, family_x: r4(row.iv.famMult), growth_x: r4(row.iv.growth), seasoning_x: r4(row.iv.season) },
  band_p25_usd: row.band.p25,
  band_p75_usd: row.band.p75,
  rank_range: [row.band.rankLo, row.band.rankHi],
  farm: { chain: row.plan.chain, deposit_usd: row.plan.deposit, weeks: row.plan.weeks, costs_usd: r4(row.plan.costs), capital_cost_usd: r4(row.plan.capitalCost), slice_if_launch_usd: r4(row.plan.slice), break_even_odds: r4(row.plan.breakEven), verdict: row.plan.verdict },
  note: row.note,
}));

/** The gate's board rows, checked before anything is written: null when the board passes. */
function boardIssue(rows: any[], s: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `${rows.length} rows, not 100 to 4,000`;
  const known = new Set(s.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    if (!known.has(r.slug) || seen.has(r.slug) || /\s/.test(r.slug)) return `row ${i}: slug ${r.slug} unknown, repeated or spaced`;
    seen.add(r.slug);
    if (r.rank !== i + 1) return `row ${i}: rank ${r.rank} is not ${i + 1}`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 1e14) return `row ${i}: bad implied value`;
    if (i > 0 && r.implied_value_usd > rows[i - 1].implied_value_usd) return `row ${i}: value rises with rank`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `row ${i}: ${r.farm_steps.length} farm steps`;
    for (const step of r.farm_steps) if (step.trim().length < 20 || step.trim().length > 600) return `row ${i}: a farm step of ${step.trim().length} characters`;
  }
  if (rows[0].implied_value_usd === rows[rows.length - 1].implied_value_usd) return 'every implied value is the same';
  const missing = s.watchlist.filter((w) => !seen.has(w));
  if (missing.length > 0) return `watchlist slugs missing: ${missing.join(', ')}`;
  return null;
}
const issue = boardIssue(board, snap);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

// What the page re-derives from: raw snapshot fields per row, plus our outputs to check its results against.
const data = {
  as_of: snap.as_of,
  source: snap.source,
  floor_usd: snap.floor_usd,
  model_version: L.MODEL.version,
  counts: {
    protocols: snap.protocols.length,
    watchlist: snap.watchlist.length,
    ranked: radar.rows.length,
    traded: radar.universe.traded.length,
    set_aside: radar.universe.setAside.length,
    recorded: radar.universe.recorded,
  },
  fit: radar.fit,
  loo: radar.loo,
  traded: radar.universe.traded.map((p: Protocol) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d, listed_at: p.listed_at, mcap_usd: p.mcap_usd })),
  rows: radar.rows.map((row: any) => ({
    slug: row.p.slug, name: row.p.name, category: row.p.category, chains: row.p.chains, tvl_usd: row.p.tvl_usd,
    change_7d: row.p.change_7d, listed_at: row.p.listed_at, watch: row.watch, note: row.note,
    rank: row.rank, value: row.iv.value, p25: row.band.p25, p75: row.band.p75, rank_lo: row.band.rankLo, rank_hi: row.band.rankHi,
    net: Math.round(row.plan.net), verdict: row.plan.verdict,
  })),
  set_aside: radar.universe.setAside,
};

// ---------------------------------------------------------------- the files

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ model: L.MODEL.version, as_of: snap.as_of, ranks: 'protocols that record no token only; traded tokens are unranked anchors', rows: board })}\n`);
writeFileSync(join(out, 'data.js'), `// Launchscope data: written by main.ts from ${snap.as_of}'s snapshot. The page re-derives every value from it.\nglobalThis.LAUNCHSCOPE_DATA = ${JSON.stringify(data)};\n`);

/** Copy a directory tree's regular files (names starting with a dot skipped) into a fresh `to`. */
function copyTree(from: string, to: string): string[] {
  rmSync(to, { recursive: true, force: true });
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    const st = statSync(path);
    if (st.isDirectory()) copied.push(...copyTree(path, join(to, name)).map((n) => `${name}/${n}`));
    else if (st.isFile()) {
      copyFileSync(path, join(to, name));
      copied.push(name);
    }
  }
  return copied;
}

const pages = copyTree(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyTree(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3 || shots.length > 4) fail(`screenshots/ holds ${shots.length} images: hand in 3 or 4`);

// Written last: the scorer rebuilds the dossier from this directory and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }));

const c = data.counts;
process.stdout.write(
  `launchscope: ${c.protocols} protocols; ranked ${c.ranked} that record no token (${c.watchlist} watchlist), ` +
    `fit on ${c.traded} traded tokens, ${c.set_aside} set aside, ${c.recorded} record a token without a market cap\n` +
    `launchscope: wrote board.json, data.js, dashboard/ (${pages.length} files), screenshots/ (${shots.length}) and dossier.json to ${out}\n`,
);
