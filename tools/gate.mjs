// Local gate for Launchscope: the scorer's seven rows re-implemented, plus a determinism check.
//
//   node tools/gate.mjs --snapshot /path/to/snapshot.json [--out out]
//
// Runs main.ts twice into two fresh temporary directories and compares every byte, then checks the
// first run's output the way the sealed scorer does (RULES.txt, "The gate"). With --out it also copies
// that verified output to the given directory for the screenshot tool. Exits 1 when any row fails.
// Two rules here are stricter than the scorer, on purpose: no http(s):// anywhere in dashboard text, and
// no cut in the dossier text (the judge should read every line of the source).

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from '../vendor/makefun-board.ts';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};
const snapshotPath = resolve(argOf('snapshot', process.env.LAUNCHSCOPE_SNAPSHOT ?? '/input/snapshot.json'));
const copyTo = argOf('out', null);
if (!existsSync(snapshotPath)) {
  console.error(`gate: no snapshot at ${snapshotPath}: pass --snapshot <file>`);
  process.exit(2);
}
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));

const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MAX_DOSSIER = 1.5 * 1024 * 1024;
const results = [];
const record = (row, pass, detail) => results.push({ row, pass, detail });

// ---------------------------------------------------------------- two runs, every byte

function runMain(dir) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [join(repo, 'main.ts'), '--input', snapshotPath, '--output', dir], { encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) throw new Error(`main.ts exited ${r.status}: ${r.stderr.trim()}`);
  return ms;
}
function listTree(root, rel = '') {
  const out = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listTree(root, p));
    else out.push(p);
  }
  return out;
}

const runA = mkdtempSync(join(tmpdir(), 'launchscope-a-'));
const runB = mkdtempSync(join(tmpdir(), 'launchscope-b-'));
let out = runA;
try {
  const msA = runMain(runA);
  const msB = runMain(runB);
  const filesA = listTree(runA), filesB = listTree(runB);
  const differing = filesA.filter((f) => !filesB.includes(f) || !readFileSync(join(runA, f)).equals(readFileSync(join(runB, f))));
  const pass = differing.length === 0 && filesA.length === filesB.length;
  record('determinism', pass, pass ? `${filesA.length} files identical across two runs (${msA.toFixed(0)} ms, ${msB.toFixed(0)} ms)` : `differ: ${differing.slice(0, 5).join(', ')}`);
} catch (err) {
  record('determinism', false, String(err.message ?? err));
  report();
}

// ---------------------------------------------------------------- 1. dashboard_files

function urlInHtml(text) {
  for (const tag of text.match(/<[a-zA-Z][^>]*>/g) ?? []) {
    for (const m of tag.matchAll(/[\s/][^\s=/>]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g)) if (/https?:\/\//i.test(m[1])) return `attribute in ${tag.slice(0, 60)}`;
  }
  for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) if (/https?:\/\//i.test(m[1])) return '<style> body';
  for (const m of text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) if (urlInJs(m[1])) return 'inline script import';
  return null;
}
function urlInJs(text) {
  const specifiers = [
    /\bimport\s*(?:[\w*{}\s,]+\s*from\s*)?["'`]([^"'`]+)["'`]/g,
    /\bexport\s*[\w*{}\s,]*\s*from\s*["'`]([^"'`]+)["'`]/g,
    /\brequire\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g,
  ];
  return specifiers.some((re) => [...text.matchAll(re)].some((m) => /https?:\/\//i.test(m[1])));
}

{
  const root = join(out, 'dashboard');
  let detail = null, count = 0, bytes = 0, css = 0, js = 0, textBytes = 0;
  const strictHits = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) detail ??= `${p}: a dot-directory`;
        walk(p);
        continue;
      }
      const st = lstatSync(join(root, p));
      if (!st.isFile()) { detail ??= `${p}: not a regular file`; continue; }
      if (!PLAIN_NAME.test(e.name)) detail ??= `${p}: name is not plain`;
      count++;
      bytes += st.size;
      if (p.endsWith('.css')) css++;
      if (p.endsWith('.js')) js++; // the scorer asks for a .js file: an .mjs does not count
      if (/\.(html|css|js|json|mjs|svg|md|txt)$/.test(p)) {
        const text = readFileSync(join(root, p), 'utf8');
        textBytes += st.size;
        if (/https?:\/\//i.test(text)) strictHits.push(p);
        if (p.endsWith('.html')) { const why = urlInHtml(text); if (why) detail ??= `${p}: http(s) address in ${why}`; }
        if (p.endsWith('.css') && /https?:\/\//i.test(text)) detail ??= `${p}: http(s) address in a CSS file`;
        if (/\.(m?js)$/.test(p) && urlInJs(text)) detail ??= `${p}: http(s) address in an import`;
      }
    }
  };
  if (!existsSync(join(root, 'index.html'))) detail = 'no dashboard/index.html';
  else walk('');
  if (!detail && (css === 0 || js === 0)) detail = 'needs at least one .css and one .js';
  if (!detail && count > 400) detail = `${count} files, over 400`;
  if (!detail && bytes > 4 * 1024 * 1024) detail = `${bytes} bytes, over 4 MiB`;
  if (!detail && strictHits.length) detail = `strict: http(s):// text in ${strictHits.join(', ')}`;
  record('dashboard_files', detail === null, detail ?? `${count} files, ${bytes} bytes (${textBytes} bytes of source), no network address`);
}

// ---------------------------------------------------------------- 2-5. the board

let rows = null;
{
  const path = join(out, 'board.json');
  let detail = null;
  try {
    const buf = readFileSync(path);
    if (buf.length > 8 * 1024 * 1024) throw new Error(`${buf.length} bytes, over 8 MiB`);
    const doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf));
    rows = Array.isArray(doc) ? doc : doc?.rows;
    if (!Array.isArray(rows)) throw new Error('no rows array');
    if (rows.length < 100 || rows.length > 4000) throw new Error(`${rows.length} rows, not 100 to 4,000`);
    const known = new Set(snapshot.protocols.map((p) => p.slug));
    const seen = new Set(), invented = [];
    for (const r of rows) {
      if (typeof r.slug !== 'string' || r.slug.length < 1 || r.slug.length > 128 || /\s/.test(r.slug)) throw new Error(`bad slug ${JSON.stringify(r.slug)}`);
      if (seen.has(r.slug)) throw new Error(`slug ${r.slug} repeated`);
      seen.add(r.slug);
      if (!known.has(r.slug)) invented.push(r.slug);
      if (typeof r.name !== 'string' || r.name.length === 0) throw new Error(`${r.slug}: empty name`);
      if (!Number.isInteger(r.rank) || r.rank < 1) throw new Error(`${r.slug}: rank ${r.rank}`);
      if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 1e14) throw new Error(`${r.slug}: implied value ${r.implied_value_usd}`);
      if (!Array.isArray(r.farm_steps)) throw new Error(`${r.slug}: farm_steps is not an array`);
    }
    if (invented.length) throw new Error(`invented slugs: ${invented.slice(0, 3).join(', ')}`);
    if (rows.length >= 2 && rows.every((r) => r.implied_value_usd === rows[0].implied_value_usd)) throw new Error('all implied values equal');
  } catch (err) {
    detail = err.message;
    rows = null;
  }
  record('board_file', detail === null, detail ?? `${rows.length} rows, ${rows.filter((r) => !snapshot.watchlist.includes(r.slug)).length} beyond the watchlist`);
}
if (rows) {
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  const ranksOk = byRank.every((r, i) => r.rank === i + 1);
  const rising = byRank.findIndex((r, i) => i > 0 && r.implied_value_usd > byRank[i - 1].implied_value_usd);
  const allSame = rows.every((r) => r.implied_value_usd === rows[0].implied_value_usd);
  record('sorted_by_value', ranksOk && rising < 0 && !allSame,
    !ranksOk ? 'ranks are not exactly 1..N' : rising >= 0 ? `value rises at rank ${byRank[rising].rank}` : allSame ? 'all values equal' : `ranks 1..${rows.length}, values ${byRank[0].implied_value_usd} down to ${byRank.at(-1).implied_value_usd}`);
  const have = new Set(rows.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((w) => !have.has(w));
  record('coverage', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${snapshot.watchlist.length}/${snapshot.watchlist.length} watchlist slugs`);
  const badStep = rows.find((r) => r.farm_steps.length < 3 || r.farm_steps.length > 12 || r.farm_steps.some((s) => typeof s !== 'string' || s.trim().length < 20 || s.trim().length > 600));
  const lengths = rows.flatMap((r) => r.farm_steps.map((s) => s.trim().length));
  record('farm_steps', !badStep, badStep ? `${badStep.slug}: a step out of bounds` : `${Math.min(...rows.map((r) => r.farm_steps.length))}-${Math.max(...rows.map((r) => r.farm_steps.length))} steps a row, ${Math.min(...lengths)}-${Math.max(...lengths)} characters`);
} else {
  for (const row of ['sorted_by_value', 'coverage', 'farm_steps']) record(row, false, 'board_file failed');
}

// ---------------------------------------------------------------- 6. screenshots

/** Width, height and whether the file is whole, from the PNG or JPEG bytes alone. */
function imageInfo(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    let at = 8, whole = false;
    while (at + 8 <= buf.length) {
      const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8);
      at += 12 + len;
      if (type === 'IEND') { whole = at === buf.length; break; }
    }
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), whole };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let at = 2, width = 0, height = 0;
    while (at + 4 <= buf.length && buf[at] === 0xff) {
      const marker = buf[at + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
      const len = buf.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) { height = buf.readUInt16BE(at + 5); width = buf.readUInt16BE(at + 7); break; }
      at += 2 + len;
    }
    return { type: 'jpeg', width, height, whole: buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9 };
  }
  return null;
}
{
  const dir = join(out, 'screenshots');
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('.')).sort() : [];
  let detail = names.length < 3 || names.length > 4 ? `${names.length} images, not 3 or 4` : null;
  const sizes = [];
  for (const n of names) {
    const st = lstatSync(join(dir, n));
    if (!st.isFile()) { detail ??= `${n}: not a regular file`; continue; }
    if (!PLAIN_NAME.test(n)) detail ??= `${n}: name is not plain`;
    if (st.size > 524288) detail ??= `${n}: ${st.size} bytes, over 512 KiB`;
    const info = imageInfo(readFileSync(join(dir, n)));
    if (!info) { detail ??= `${n}: neither PNG nor JPEG`; continue; }
    if (!info.whole) detail ??= `${n}: not a whole ${info.type}`;
    const long = Math.max(info.width, info.height), short = Math.min(info.width, info.height);
    if (long > 1440 || short < 800) detail ??= `${n}: ${info.width}x${info.height} (long side <= 1440, short side >= 800)`;
    sizes.push(`${n} ${info.width}x${info.height} ${(st.size / 1024).toFixed(0)}K`);
  }
  record('screenshots', detail === null, detail ?? sizes.join(', '));
}

// ---------------------------------------------------------------- 7. dossier_matches

{
  let detail = null, size = 0, textBytes = 0;
  try {
    const want = Buffer.from(buildDossier(out, { text_max_bytes: 65536 }));
    const have = readFileSync(join(out, 'dossier.json'));
    size = have.length;
    if (!want.equals(have)) detail = 'dossier.json differs from buildDossier';
    else if (size > MAX_DOSSIER) detail = `${size} bytes, over 1.5 MiB`;
    const text = JSON.parse(have.toString('utf8')).text;
    textBytes = Buffer.byteLength(text, 'utf8');
    if (!detail && text.includes('[Cut at ')) detail = `strict: the source text is cut at 65,536 bytes (${textBytes})`;
  } catch (err) {
    detail = String(err.message ?? err);
  }
  record('dossier_matches', detail === null, detail ?? `byte-identical, ${size} bytes of ${MAX_DOSSIER} (${(100 * size / MAX_DOSSIER).toFixed(0)}%), source text ${textBytes} of 65,536 bytes, uncut`);
}

if (copyTo) {
  rmSync(copyTo, { recursive: true, force: true });
  cpSync(out, copyTo, { recursive: true });
}
rmSync(runB, { recursive: true, force: true });
rmSync(runA, { recursive: true, force: true });
report();

function report() {
  const width = Math.max(...results.map((r) => r.row.length));
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.row.padEnd(width)}  ${r.detail}`);
  // The scorer runs the committed tree: warn about entry files a commit would leave out.
  const git = spawnSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all', '--', 'main.ts', 'dashboard', 'screenshots', 'vendor', '.makefun', 'LICENSE'], { encoding: 'utf8' });
  const loose = (git.stdout || '').split('\n').filter((l) => l.startsWith('??') || l.startsWith(' D'));
  if (loose.length) console.log(`warning: not staged for commit (untracked or deleted): ${loose.map((l) => l.slice(3)).join(', ')}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(failed ? `gate: ${failed} row${failed === 1 ? '' : 's'} failed` : `gate: all ${results.length} rows pass`);
  process.exit(failed ? 1 : 0);
}
