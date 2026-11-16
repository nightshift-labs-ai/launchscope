/* Launchscope page. Renders the board, a detail view per protocol and the method view. Every number
 * shown is re-derived here by model.js (impliedValue, bootstrapRanks, farmPlan) from the raw snapshot
 * fields in data.js, and checked against what main.ts wrote to board.json. */
(function () {
  'use strict';
  const D = globalThis.LAUNCHSCOPE_DATA;
  const L = globalThis.Launchscope;
  const FULL = { slope: true, families: true, priors: true };
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pct = (x) => (x === null ? 'n/a' : `${x > 0 ? '+' : ''}${x.toFixed(1)}%`);
  const times = (m) => `×${m.toFixed(2)}`;
  const odds = (p) => (p > 1 ? '>100%' : `${Math.round(p * 100)}%`);
  const logScale = (lo, hi, a, b) => (v) => a + ((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (b - a);

  // ------------------------------------------------------------ re-derive and verify

  /** Refit on the traded tokens, recompute every row, and count how many match board.json. */
  function deriveAll() {
    const fit = L.fitCurve(L.fitPoints(D.traded, D.as_of, true), FULL);
    const rows = D.rows.map((r) => {
      const iv = L.impliedValue(r, fit, D.as_of);
      return Object.assign({}, r, { iv, plan: L.farmPlan(r, iv.value, D.as_of), peers: L.nearestPeers(r, D.traded, 3) });
    });
    const boot = L.bootstrapRanks(D.traded, rows, D.as_of, L.MODEL.bootstrapRuns, L.MODEL.seed);
    const check = { n: rows.length, values: 0, bands: 0, ranks: 0, plans: 0, fit: Math.abs(fit.a - D.fit.a) < 1e-9 && Math.abs(fit.b - D.fit.b) < 1e-9 };
    rows.forEach((r, i) => {
      r.boot = boot[i];
      if (Math.abs(r.iv.value - r.value) <= 1) check.values++;
      if (Math.abs(boot[i].p25 - r.p25) <= 1 && Math.abs(boot[i].p75 - r.p75) <= 1) check.bands++;
      if (boot[i].rankLo === r.rank_lo && boot[i].rankHi === r.rank_hi) check.ranks++;
      if (r.plan.verdict === r.verdict && Math.abs(Math.round(r.plan.net) - r.net) <= 1) check.plans++;
    });
    check.ok = check.fit && [check.values, check.bands, check.ranks, check.plans].every((k) => k === check.n);
    return { fit, rows, check };
  }
  const M = deriveAll();
  const bandLo = Math.min(...M.rows.map((r) => r.p25)), bandHi = Math.max(...M.rows.map((r) => r.p75));

  // ------------------------------------------------------------ state in the URL hash

  const DEFAULTS = { fam: '', chain: '', verdict: '', watch: '', q: '', anchors: '1', sort: 'value', dir: 'desc' };
  const SORTS = {
    value: (r) => r.iv.value, name: (r) => r.name.toLowerCase(), tvl: (r) => r.tvl_usd, growth: (r) => (r.change_7d === null ? -1e9 : r.change_7d),
    days: (r) => (r.iv.days === null ? -1 : r.iv.days), odds: (r) => r.plan.breakEven, perhour: (r) => r.plan.perHour,
  };
  const SORT_LABEL = { value: 'implied value', name: 'name', tvl: 'TVL', growth: '7-day TVL change', days: 'days with no token', odds: 'break-even odds', perhour: 'net per hour' };

  function readHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h.startsWith('p/')) return { view: 'detail', slug: h.slice(2) };
    if (h === 'method') return { view: 'method' };
    const st = Object.assign({}, DEFAULTS);
    new URLSearchParams(h.split('?')[1] || '').forEach((v, k) => { if (k in st) st[k] = v; });
    return { view: 'board', st };
  }
  function writeHash(st) {
    const q = Object.keys(DEFAULTS).filter((k) => st[k] !== DEFAULTS[k]).map((k) => `${k}=${encodeURIComponent(st[k])}`).join('&');
    history.replaceState(null, '', q ? `#board?${q}` : '#board');
  }

  /** The rows a reader asked for: family, chain, verdict, watchlist and a name search. */
  function filterRows(rows, st) {
    const q = st.q.trim().toLowerCase();
    return rows.filter((r) => (!st.fam || r.iv.fam === st.fam) && (!st.chain || r.chains.includes(st.chain)) &&
      (!st.verdict || r.plan.verdict === st.verdict) && (!st.watch || r.watch) &&
      (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)));
  }
  function sortRows(rows, st) {
    const key = SORTS[st.sort] || SORTS.value, sign = st.dir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * sign || a.rank - b.rank; });
  }

  /**
   * Traded tokens as unranked anchors at their market cap, in value order only: those matching the
   * filters and inside the shown value range, thinned to about one per six ranked rows.
   */
  function anchorsFor(shown, st) {
    if (st.anchors !== '1' || st.sort !== 'value' || shown.length === 0 || st.verdict || st.watch || st.q) return [];
    const top = shown[0].iv.value * 1.5, bottom = shown[shown.length - 1].iv.value / 1.5;
    const pool = D.traded.filter((t) => t.mcap_usd <= top && t.mcap_usd >= bottom && (!st.fam || L.familyOf(t.category) === st.fam) && (!st.chain || t.chains.includes(st.chain)))
      .sort((a, b) => b.mcap_usd - a.mcap_usd || (a.slug < b.slug ? -1 : 1));
    const gap = Math.max(1, Math.min(6, Math.floor(shown.length / 4))), kept = [];
    let last = -Infinity;
    for (const t of pool) {
      const at = shown.filter((r) => r.iv.value >= t.mcap_usd).length;
      if (at - last >= gap) { kept.push({ t, at }); last = at; }
    }
    return kept;
  }

  // ------------------------------------------------------------ the board

  function kpis() {
    const c = D.counts, k = M.check;
    return `<section class="kpis">
      <div><b>${c.watchlist}/${c.watchlist}</b><span>watchlist protocols ranked</span></div>
      <div><b>${c.ranked}</b><span>ranked: record no token</span></div>
      <div><b>${c.traded}</b><span>traded tokens fit the curve, shown grey</span></div>
      <div><b>${c.set_aside}</b><span>set aside as products of a token (Method)</span></div>
      <div class="check ${k.ok ? 'ok' : 'bad'}"><b>${k.ok ? '✓' : '✗'} board.json = this page</b><span>${k.values}/${k.n} values, ${k.bands} bands, ${k.ranks} rank ranges and ${k.plans} plans re-derived in your browser</span></div>
    </section>`;
  }

  function bandBar(lo, hi, v, cls) {
    const sx = logScale(bandLo, bandHi, 5, 155);
    const band = lo ? `<rect x="${sx(lo).toFixed(1)}" y="3" width="${(sx(hi) - sx(lo)).toFixed(1)}" height="10" rx="5"/>` : '';
    return `<svg class="bar ${cls}" width="160" height="16" aria-hidden="true"><line x1="5" x2="155" y1="8" y2="8"/>${band}<circle cx="${sx(Math.min(Math.max(v, bandLo), bandHi)).toFixed(1)}" cy="8" r="4.5"/></svg>`;
  }

  function rowHtml(r) {
    const p = r.plan;
    return `<tr class="ranked" data-slug="${esc(r.slug)}"><td class="rk"><b>${r.rank}</b><small>${r.boot.rankLo}–${r.boot.rankHi}</small></td>
      <td class="name"><a href="#p/${esc(r.slug)}">${esc(r.name)}</a>${r.watch ? '<i class="tag">watchlist</i>' : ''}<small>${esc(r.category || 'no category')} · ${esc(r.chains.slice(0, 2).join(', '))}${r.chains.length > 2 ? ` +${r.chains.length - 2}` : ''}</small></td>
      <td class="val"><b>${L.usd(r.iv.value)}</b><small>${L.usd(r.boot.p25)}–${L.usd(r.boot.p75)}</small></td><td>${bandBar(r.boot.p25, r.boot.p75, r.iv.value, 'pre')}</td>
      <td class="num">${L.usd(r.tvl_usd)}</td><td class="num ${r.change_7d > 0 ? 'up' : ''}">${pct(r.change_7d)}</td><td class="num">${r.iv.days === null ? 'n/a' : r.iv.days}</td>
      <td class="num">${odds(p.breakEven)}</td><td class="num">${L.usd(p.perHour)}/h</td><td><i class="verdict v-${p.verdict}">${L.VERDICT_LABEL[p.verdict]}</i></td></tr>`;
  }
  function anchorHtml(t) {
    return `<tr class="anchor"><td class="rk">–</td><td class="name">${esc(t.name)}<i class="tag grey">trades</i><small>${esc(t.category || 'no category')} · reference, not ranked</small></td>
      <td class="val"><b>${L.usd(t.mcap_usd)}</b><small>market cap</small></td><td>${bandBar(0, 0, t.mcap_usd, 'traded')}</td>
      <td class="num">${L.usd(t.tvl_usd)}</td><td class="num">${pct(t.change_7d)}</td><td class="num">–</td><td class="num" colspan="3">market pays ${(t.mcap_usd / t.tvl_usd).toFixed(2)}× its TVL</td></tr>`;
  }

  function renderBoard(st) {
    const famCount = {}, chainCount = {}, verdictCount = {};
    for (const r of M.rows) {
      famCount[r.iv.fam] = (famCount[r.iv.fam] || 0) + 1;
      verdictCount[r.plan.verdict] = (verdictCount[r.plan.verdict] || 0) + 1;
      for (const c of r.chains) chainCount[c] = (chainCount[c] || 0) + 1;
    }
    const chip = (key, val, label, n) => `<button class="chip ${st[key] === val ? 'on' : ''}" data-k="${key}" data-v="${esc(val)}">${esc(label)} <small>${n}</small></button>`;
    const chains = Object.keys(chainCount).sort((a, b) => chainCount[b] - chainCount[a] || (a < b ? -1 : 1)).slice(0, 30);
    $('#view').innerHTML = `${kpis()}
      <p class="explain">Rank = our model's implied value among the ${D.counts.ranked} protocols that record no token. Under each rank, its range over 200 refits; under each value, its P25–P75 band. Grey rows already trade: shown at market cap for scale, never ranked.</p>
      <div class="toolbar">
        <input id="q" type="search" placeholder="Search a protocol" value="${esc(st.q)}" aria-label="Search">
        <div class="group">${Object.keys(L.FAMILY_LABEL).filter((f) => famCount[f]).map((f) => chip('fam', f, L.FAMILY_LABEL[f], famCount[f])).join('')}</div>
        <select id="chain" aria-label="Chain"><option value="">All chains</option>${chains.map((c) => `<option ${st.chain === c ? 'selected' : ''} value="${esc(c)}">${esc(c)} (${chainCount[c]})</option>`).join('')}</select>
        <div class="group">${['farm', 'marginal', 'skip'].map((v) => chip('verdict', v, L.VERDICT_LABEL[v], verdictCount[v] || 0)).join('')}${chip('watch', '1', 'Watchlist', D.counts.watchlist)}</div>
        <label class="toggle"><input id="anchors" type="checkbox" ${st.anchors === '1' ? 'checked' : ''}> Traded anchors</label>
      </div>
      <div id="results"></div>`;
    renderResults(st);
    $('#view').onclick = (e) => {
      const b = e.target.closest('button.chip, th[data-s], button.x');
      if (b && b.dataset.k) { st[b.dataset.k] = st[b.dataset.k] === b.dataset.v ? '' : b.dataset.v; return update(st, true); }
      if (b && b.dataset.s) { st.dir = st.sort === b.dataset.s && st.dir === 'desc' ? 'asc' : b.dataset.s === 'odds' || b.dataset.s === 'name' ? 'asc' : 'desc'; st.sort = b.dataset.s; return update(st); }
      const tr = e.target.closest('tr.ranked');
      if (tr && !e.target.closest('a')) location.hash = `p/${tr.dataset.slug}`;
    };
    $('#q').oninput = (e) => { st.q = e.target.value; update(st); };
    $('#chain').onchange = (e) => { st.chain = e.target.value; update(st, true); };
    $('#anchors').onchange = (e) => { st.anchors = e.target.checked ? '1' : ''; update(st); };
  }
  function update(st, full) {
    writeHash(st);
    if (full) renderBoard(st); else renderResults(st);
  }

  function renderResults(st) {
    const shown = sortRows(filterRows(M.rows, st), st);
    const anchors = anchorsFor(shown, st);
    const body = [];
    let a = 0;
    shown.forEach((r, i) => {
      while (a < anchors.length && anchors[a].at === i) body.push(anchorHtml(anchors[a++].t));
      body.push(rowHtml(r));
    });
    while (a < anchors.length) body.push(anchorHtml(anchors[a++].t));
    const active = ['fam', 'chain', 'verdict', 'watch', 'q'].filter((k) => st[k]).map((k) => {
      const label = k === 'fam' ? L.FAMILY_LABEL[st.fam] : k === 'verdict' ? L.VERDICT_LABEL[st.verdict] : k === 'watch' ? 'Watchlist only' : k === 'q' ? `“${st.q}”` : st.chain;
      return `<button class="chip on x" data-k="${k}" data-v="${esc(st[k])}">${esc(label)} ✕</button>`;
    }).join('');
    const th = (key, label, cls) => `<th data-s="${key}" class="${cls || ''} ${st.sort === key ? 'sorted' : ''}">${label}${st.sort === key ? (st.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`;
    $('#results').innerHTML = `<div class="status">${active}<span><b>${shown.length}</b> of ${M.rows.length} ranked shown${anchors.length ? `, ${anchors.length} traded anchors` : ''} · sorted by ${SORT_LABEL[st.sort]}</span></div>
      <table class="board"><thead><tr>${th('value', '#', 'rk')}${th('name', 'Protocol')}${th('value', 'Implied value')}<th>P25–P75 band</th>${th('tvl', 'TVL', 'num')}${th('growth', '7d TVL', 'num')}${th('days', 'Days, no token', 'num')}${th('odds', 'Break-even', 'num')}${th('perhour', 'Net if launch', 'num')}<th>Farm verdict</th></tr></thead>
      <tbody>${body.join('') || '<tr><td colspan="10" class="empty">No protocol matches these filters.</td></tr>'}</tbody></table>`;
  }

  // ------------------------------------------------------------ the detail view

  /** The value as an equation: the size curve at this TVL, times each multiplier, equals the value. */
  function equationHtml(r) {
    const iv = r.iv;
    const tile = (big, label, m) => `<div class="tile ${m === undefined ? '' : m > 1.0005 ? 'up' : m < 0.9995 ? 'down' : ''}"><b>${big}</b><span>${label}</span></div>`;
    return `<div class="eq">${tile(L.usd(iv.base), `size curve at ${L.usd(r.tvl_usd)} TVL`)}<i>×</i>${tile(iv.famMult.toFixed(2), `${L.FAMILY_LABEL[iv.fam]} family`, iv.famMult)}<i>×</i>` +
      `${tile(iv.growth.toFixed(2), `7-day TVL ${pct(r.change_7d)}`, iv.growth)}<i>×</i>${tile(iv.season.toFixed(2), `${iv.days === null ? '365 assumed' : iv.days} days, no token`, iv.season)}<i>=</i>` +
      `<div class="tile res"><b>${L.usd(iv.value)}</b><span>implied value</span></div></div>`;
  }

  /** The band on a log axis, with the value and what each traded peer's multiple would make it. */
  function bandSvg(r) {
    const pts = [r.boot.p25, r.boot.p75, r.iv.value, ...r.peers.map((t) => t.implied)];
    const sx = logScale(Math.min(...pts) / 1.4, Math.max(...pts) * 1.4, 12, 548), x = (v) => sx(v).toFixed(1);
    const peers = r.peers.map((t, i) => `<g class="pr"><path d="M${x(t.implied)} 24l12 12-12 12-12-12z"/><text x="${x(t.implied)}" y="40" text-anchor="middle">${i + 1}</text></g>`).join('');
    return `<svg class="band" viewBox="0 0 560 70" role="img" aria-label="Value band and peers"><line x1="12" x2="548" y1="36" y2="36"/>
      <rect x="${x(r.boot.p25)}" y="29" width="${(sx(r.boot.p75) - sx(r.boot.p25)).toFixed(1)}" height="14" rx="7"/>${peers}<circle cx="${x(r.iv.value)}" cy="36" r="8"/>
      <text class="v" x="${x(r.iv.value)}" y="16" text-anchor="middle">${L.usd(r.iv.value)}</text><text x="${x(r.boot.p25)}" y="64" text-anchor="middle">P25 ${L.usd(r.boot.p25)}</text><text x="${x(r.boot.p75)}" y="64" text-anchor="middle">P75 ${L.usd(r.boot.p75)}</text></svg>`;
  }

  /** The plan's calendar, day 0 to the exit week: numbered steps, weekly ticks and the stop line. */
  function timelineSvg(plan) {
    const end = plan.weeks * 7, sx = (d) => 24 + (d / end) * 660;
    let ticks = '', lastX = -99;
    for (let w = 0; w <= plan.weeks; w++) ticks += `<line x1="${sx(w * 7)}" x2="${sx(w * 7)}" y1="44" y2="52"/><text x="${sx(w * 7)}" y="66" text-anchor="middle">${w === 0 ? 'day 0' : `week ${w}`}</text>`;
    const marks = plan.steps.map((s, i) => {
      if (s.day === null) return '';
      lastX = Math.max(sx(s.day), lastX + 23);
      return `<g class="mk"><circle cx="${lastX}" cy="22" r="10"/><text x="${lastX}" y="26" text-anchor="middle">${i + 1}</text></g>`;
    }).join('');
    return `<svg class="timeline" viewBox="0 0 740 94" role="img" aria-label="Plan timeline"><line class="axis" x1="24" x2="684" y1="44" y2="44"/>${ticks}${marks}
      <text class="stopt" x="24" y="82">7 · any day: stop if TVL closes under ${L.usd(plan.stopTvl)}</text><line class="stop" x1="24" x2="684" y1="88" y2="88"/></svg>`;
  }

  /** One protocol: its value, how it is built, its band and rank range, peers, and its costed plan. */
  function renderDetail(slug) {
    const r = M.rows.find((x) => x.slug === slug);
    if (!r) { location.hash = ''; return; }
    const p = r.plan, A = L.ASSUME;
    const steps = p.steps.map((s, i) => `<tr class="${s.kind === 'stop' ? 'cond' : ''}"><td class="n">${i + 1}</td><td class="when">${s.day === null ? 'any day' : s.every ? `weekly ×${p.weeks}` : `day ${s.day}`}</td>
      <td>${esc(s.text)}</td><td class="num">${L.usd(s.cost)}</td><td class="num">${s.minutes} min</td></tr>`).join('');
    const peers = r.peers.map((t, i) => `<tr><td class="n">${i + 1}</td><td>${esc(t.name)}</td><td class="num">${L.usd(t.tvl_usd)}</td><td class="num">${L.usd(t.mcap_usd)}</td><td class="num">${t.multiple.toFixed(2)}×</td><td class="num">${L.usd(t.implied)}</td></tr>`).join('');
    $('#view').innerHTML = `<header class="dhead"><a class="crumb" href="#board">← Board</a><h1>${esc(r.name)}</h1><i class="tag">records no token</i>${r.watch ? '<i class="tag">watchlist</i>' : ''}<i class="tag grey">${esc(r.category || 'no category')}</i><i class="tag grey">${esc(r.chains.slice(0, 3).join(' · '))}${r.chains.length > 3 ? ` +${r.chains.length - 3}` : ''}</i></header>
      ${r.note ? `<p class="note">Note: ${esc(r.note)}.</p>` : ''}
      <div class="detail">
        <section class="card">
          <div class="facts"><div class="big"><span>Implied value, our model's claim</span><b>${L.usd(r.iv.value)}</b></div><div><span>Rank · refit range</span><b>${r.rank} of ${M.rows.length} · ${r.boot.rankLo}–${r.boot.rankHi}</b></div><div><span>P25–P75 band</span><b>${L.usd(r.boot.p25)}–${L.usd(r.boot.p75)}</b></div></div>
          <h2>How the value is built</h2>${equationHtml(r)}
          <h2>Band and nearest traded peers <small>same family, closest TVL</small></h2>${bandSvg(r)}
          <table class="mini"><thead><tr><th>#</th><th>Token that trades</th><th class="num">TVL</th><th class="num">Mcap</th><th class="num">× TVL</th><th class="num">Applied here</th></tr></thead><tbody>${peers}</tbody></table>
          <h2>The farm arithmetic</h2>
          <p class="math">Slice if a token launches = ${A.airdropShare * 100}% airdrop share × ${L.usd(r.iv.value)} × ${L.usd(p.deposit)} / ${L.usd(r.tvl_usd)} TVL = <b>${L.usd(p.slice)}</b><br>
          Break-even odds = (${L.usd(p.costs)} fees + ${L.usd(p.capitalCost)} T-bill income at ${A.tbillRate * 100}% for ${p.weeks} weeks) / ${L.usd(p.slice)} = <b>${odds(p.breakEven)}</b></p>
          <p class="assume">Gas ${L.usd(p.gas)} a transaction on ${esc(p.chain)} and ${L.usd(A.bridgeFee)} per bridge leg are our estimates. Deposit grows with TVL (and with what it takes for the slice to cover fees 3×), within ${L.usd(A.depositMin)}–${L.usd(A.depositMax)}; the hold is longer for younger protocols; the stop is twice the 7-day swing. Verdict: odds ≤25% worth farming, ≤60% marginal, else skip.</p>
        </section>
        <section class="card plan">
          <h2>Farm plan <small>${esc(p.chain)} · ${L.usd(p.deposit)} · ${p.weeks} weeks</small><i class="verdict v-${p.verdict}">${L.VERDICT_LABEL[p.verdict]}</i></h2>
          ${timelineSvg(p)}
          <table class="steps"><thead><tr><th>#</th><th>When</th><th>Step</th><th class="num">Cost</th><th class="num">Time</th></tr></thead><tbody>${steps}</tbody></table>
          <div class="totals"><div><span>Fees and gas</span><b>${L.usd(p.costs)}</b></div><div><span>T-bill income forgone</span><b>${L.usd(p.capitalCost)}</b></div><div><span>Your time</span><b>${Math.round(p.minutes)} min</b></div><div><span>Slice if a token launches</span><b>${L.usd(p.slice)}</b></div><div><span>Break-even launch odds</span><b>${odds(p.breakEven)}</b></div></div>
          <ul class="honesty">${L.HONESTY.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
        </section>
      </div>`;
  }

  // ------------------------------------------------------------ the method view

  function scatterSvg() {
    const x = (v) => 70 + ((Math.log10(v) - 6.5) / 4.5) * 540, y = (v) => 370 - ((Math.log10(v) - 5) / 6) * 350;
    let grid = '';
    const tick = (e) => ['$100K', '$1M', '$10M', '$100M', '$1B', '$10B', '$100B'][e - 5];
    for (let e = 7; e <= 10; e++) grid += `<line class="g" x1="${x(10 ** e)}" x2="${x(10 ** e)}" y1="20" y2="370"/><text x="${x(10 ** e)}" y="388" text-anchor="middle">${tick(e)}</text>`;
    for (let e = 5; e <= 11; e++) grid += `<line class="g" x1="70" x2="610" y1="${y(10 ** e)}" y2="${y(10 ** e)}"/><text x="62" y="${y(10 ** e) + 4}" text-anchor="end">${tick(e)}</text>`;
    const traded = D.traded.map((t) => `<circle class="t" cx="${x(t.tvl_usd).toFixed(1)}" cy="${y(Math.max(t.mcap_usd, 1e5)).toFixed(1)}" r="3.5"/>`).join('');
    const ranked = M.rows.map((r) => `<rect class="r" x="${(x(r.tvl_usd) - 2.5).toFixed(1)}" y="${(y(r.iv.value) - 2.5).toFixed(1)}" width="5" height="5"/>`).join('');
    const line = (tvl) => 10 ** (M.fit.a + M.fit.b * (Math.log10(tvl) - L.MODEL.centerLogTvl));
    return `<svg class="scatter" viewBox="0 0 620 404" role="img" aria-label="Fit of market cap on TVL">${grid}${traded}${ranked}
      <line class="fit" x1="${x(10 ** 6.5)}" y1="${y(line(10 ** 6.5))}" x2="${x(1e11)}" y2="${y(line(1e11))}"/>
      <text class="lab" x="610" y="402" text-anchor="end">TVL (log scale)</text><text class="lab" x="76" y="16">market cap, or implied value (log scale)</text></svg>`;
  }

  function renderMethod() {
    const loo = L.looCheck(D.traded, D.as_of), f = M.fit;
    const looRows = loo.map((v) => `<tr><td>${esc(v.label)}</td><td class="num"><b>${v.medianMiss.toFixed(2)}×</b></td><td class="num">${v.meanLogMiss.toFixed(3)}</td><td class="num">${Math.round(v.within3x * 100)}%</td><td class="num">${v.spearman.toFixed(2)}</td></tr>`).join('');
    const famN = {}, famR = {};
    D.traded.forEach((t) => { const k = L.familyOf(t.category); famN[k] = (famN[k] || 0) + 1; });
    M.rows.forEach((r) => { famR[r.iv.fam] = (famR[r.iv.fam] || 0) + 1; });
    const famRows = Object.keys(f.fam).map((k) => `<tr><td>${L.FAMILY_LABEL[k]}</td><td class="num">${famN[k] || 0}</td><td class="num">${famR[k] || 0}</td><td class="num">${times(10 ** f.fam[k])}</td></tr>`).join('');
    const why = {};
    D.set_aside.forEach((s) => { const k = s.reason.startsWith('shares') ? 'shares a name with a protocol that records a token' : s.reason.split(':')[0]; why[k] = (why[k] || 0) + 1; });
    const c = D.counts;
    $('#view').innerHTML = `<div class="method">
      <section class="card"><h2>The fit: ${c.traded} traded tokens, market cap against TVL</h2>${scatterSvg()}
        <p class="legend"><i class="dot t"></i> traded token <i class="dot r"></i> ranked protocol at its implied value <i class="dot fit"></i> size curve: log10 value = ${f.a.toFixed(2)} + ${f.b.toFixed(2)} × log10(TVL / $100M)</p>
        <p>A token's market cap grows with TVL at a slope of ${f.b.toFixed(2)}: ten times the TVL is worth ${(10 ** f.b).toFixed(1)} times the value, so small protocols carry a higher multiple than large ones.</p>
        <div class="judge"><h2>Note to the judge</h2><ol>
          <li>Working radar: <code>selectUniverse</code> ranks all ${c.watchlist} watchlist protocols plus ${c.ranked - c.watchlist} more; at load, <code>deriveAll</code> re-runs the model on data.js and checks it against board.json (${M.check.ok ? 'all match' : 'see the board'}).</li>
          <li>Value model: <code>impliedValue</code> uses only TVL, 7-day change and days since listing; <code>fitCurve</code> fits it on the snapshot's traded tokens, <code>looCheck</code> tests it, <code>bootstrapRanks</code> gives bands and rank ranges.</li>
          <li>Farm plans: <code>farmPlan</code> picks the chain, deposit, hold and stop from each row's data, with a cost and a time per step and break-even odds.</li>
          <li>Page: <code>filterRows</code>, <code>sortRows</code>, <code>renderDetail</code>; state lives in the URL hash.</li>
        </ol></div></section>
      <section class="card"><h2>Out of sample: each traded token priced by a fit that never saw it</h2>
        <table class="mini"><thead><tr><th>Model</th><th class="num">Median miss</th><th class="num">Mean |log miss|</th><th class="num">Within 3×</th><th class="num">Rank corr.</th></tr></thead><tbody>${looRows}</tbody></table>
        <p>The size curve and the category family earn their place. The 7-day growth and seasoning tilts do not improve the fit on traded tokens (their mean miss stays ${loo[3].meanLogMiss.toFixed(3)} against ${loo[2].meanLogMiss.toFixed(3)}): this week's traded TVL fell almost everywhere, and a traded token's listing age is not time without a token. So both are bounded priors, not fitted: growth tilts value by half the 7-day change, within ×${L.MODEL.growthMin.toFixed(2)}–×${L.MODEL.growthMax.toFixed(2)}; seasoning discounts a new protocol up to ${L.MODEL.seasonDepth * 100}%, fading over ${L.MODEL.seasonDays} days. A median miss of ${loo[3].medianMiss.toFixed(1)}× is why every row shows a band, not a point.</p>
        <h2>Category families <small>offset = mean miss shrunk by ${L.MODEL.familyShrinkK} pseudo-tokens</small></h2>
        <table class="mini"><thead><tr><th>Family</th><th class="num">Traded</th><th class="num">Ranked</th><th class="num">Offset</th></tr></thead><tbody>${famRows}</tbody></table>
        <h2>From ${c.protocols} protocols to ${c.ranked} ranks</h2>
        <p>${c.traded} trade (fit and anchors) · ${c.recorded} record a token with no market cap (not ranked) · ${c.ranked + c.set_aside} record no token: ${c.ranked} ranked, ${c.set_aside} set aside as ${Object.keys(why).map((k) => `${esc(k)} (${why[k]})`).join(', ')}.</p></section></div>`;
  }

  // ------------------------------------------------------------ routing

  function route() {
    const r = readHash();
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.view === (r.view === 'method' ? 'method' : 'board')));
    if (r.view === 'detail') renderDetail(r.slug);
    else if (r.view === 'method') renderMethod();
    else renderBoard(r.st);
    window.scrollTo(0, 0);
  }
  $('#asof').textContent = `DefiLlama snapshot ${D.as_of} · model ${D.model_version}`;
  window.addEventListener('hashchange', route);
  route();
})();
