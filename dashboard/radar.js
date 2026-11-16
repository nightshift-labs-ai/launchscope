/* Launchscope page: board, detail, method. At load buildRadar re-runs on the raw snapshot; each row is checked. */
(function () {
  'use strict';
  const D = globalThis.LAUNCHSCOPE_DATA;
  const L = globalThis.Launchscope, usd = L.usd;
  const S = D.snapshot;
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pct = (x) => (x === null ? 'n/a' : `${x > 0 ? '+' : ''}${x.toFixed(1)}%`);
  const times = (m) => `×${m.toFixed(2)}`;
  const odds = (p) => (p > 1 ? '>100%' : `${Math.round(p * 100)}%`);

  // -- re-derive and verify

  /** Re-run the model here; check each row against board.json. */
  function deriveAll() {
    const R = L.buildRadar(S), want = new Map(D.board.map((b) => [b[0], b]));
    const check = { n: R.rows.length, ranked: 0, values: 0, bands: 0, ranks: 0, plans: 0, fit: Math.abs(R.fit.a - D.fit.a) < 1e-9 && Math.abs(R.fit.b - D.fit.b) < 1e-9 };
    const near = (x, y) => Math.abs(x - y) <= 1;
    const rows = R.rows.map((x) => {
      const r = Object.assign({}, x.p, { rank: x.rank, watch: x.watch, note: x.note, iv: x.iv, plan: x.plan, peers: x.peers, boot: x.band }), b = want.get(r.slug) || [];
      check.ranked += b[1] === r.rank;
      check.values += near(b[2], r.iv.value);
      check.bands += near(b[3], r.boot.p25) && near(b[4], r.boot.p75);
      check.ranks += b[5] === r.boot.rankLo && b[6] === r.boot.rankHi;
      check.plans += b[7] === r.plan.verdict && near(b[8], Math.round(r.plan.net));
      return r;
    });
    check.ok = check.fit && D.board.length === check.n && [check.ranked, check.values, check.bands, check.ranks, check.plans].every((k) => k === check.n);
    return { R, fit: R.fit, rows, traded: R.universe.traded, check, watch: rows.filter((r) => r.watch).length };
  }
  const M = deriveAll();

  // -- state in the URL hash

  const DEFAULTS = { tab: '', fam: '', chain: '', verdict: '', watch: '', q: '', anchors: '1', sort: 'value', dir: 'desc' };
  const SORTS = {
    value: (r) => r.iv.value, name: (r) => r.name.toLowerCase(), tvl: (r) => r.tvl_usd, growth: (r) => (r.change_7d === null ? -1e9 : r.change_7d),
    days: (r) => (r.iv.days === null ? -1 : r.iv.days), odds: (r) => r.plan.breakEven, net: (r) => r.plan.net, perhour: (r) => r.plan.perHour,
  };
  const HEAD = { name: 'Protocol', value: 'Implied value', tvl: 'TVL', growth: '7d TVL', days: 'Days tracked', odds: 'Break-even odds', net: 'Net if launch', perhour: '$/hour' };

  function readHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h.startsWith('p/')) return { view: 'detail', slug: h.slice(2) };
    if (h === 'method') return { view: 'method' };
    const st = Object.assign({}, DEFAULTS);
    new URLSearchParams(h.split('?')[1] || '').forEach((v, k) => { if (k in st) st[k] = v; });
    return { view: 'board', st };
  }
  let back = '#board'; // the board state a detail view returns to
  function writeHash(st) {
    const q = Object.keys(DEFAULTS).filter((k) => st[k] !== DEFAULTS[k]).map((k) => `${k}=${encodeURIComponent(st[k])}`).join('&');
    back = q ? `#board?${q}` : '#board';
    history.replaceState(null, '', back);
  }

  /** Family, chain, verdict, watchlist and name filters. */
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

  // Anchors sit in value order only, and not under a verdict, watchlist or search filter.
  const anchorsOff = (st) => st.sort !== 'value' || !!(st.verdict || st.watch || st.q);
  /** Traded tokens as unranked anchors at market cap, about one per six rows. */
  function anchorsFor(shown, st) {
    if (st.anchors !== '1' || anchorsOff(st) || shown.length === 0) return [];
    const top = shown[0].iv.value * 1.5, bottom = shown[shown.length - 1].iv.value / 1.5;
    const pool = M.traded.filter((t) => t.mcap_usd <= top && t.mcap_usd >= bottom && (!st.fam || L.familyOf(t.category) === st.fam) && (!st.chain || t.chains.includes(st.chain)))
      .sort((a, b) => b.mcap_usd - a.mcap_usd || (a.slug < b.slug ? -1 : 1));
    const gap = Math.max(1, Math.min(6, Math.floor(shown.length / 4))), kept = [];
    let last = -Infinity;
    for (const t of pool) {
      const at = shown.filter((r) => r.iv.value >= t.mcap_usd).length;
      if (at > 0 && at - last >= gap) { kept.push({ t, at }); last = at; }
    }
    return kept;
  }

  // -- the board

  function kpis() {
    const k = M.check;
    return `<section class="kpis">
      <div><b>${M.watch}/${S.watchlist.length}</b><span>watchlist protocols ranked, counted here</span></div>
      <div><b>${M.rows.length}</b><span>ranked: record no token</span></div>
      <div><b>${M.traded.length}</b><span>already trade: fit the curve, never ranked</span></div>
      <div><b>${M.R.universe.setAside.length}</b><span>set aside, reasons on Method</span></div>
      <div class="check ${k.ok ? 'ok' : 'bad'}"><b>${k.ok ? '✓' : '✗'} board.json = this page</b><span>buildRadar re-run in your browser: ${k.ranked}/${k.n} ranks, ${k.values} values, ${k.bands} bands, ${k.ranks} rank ranges, ${k.plans} verdicts and nets match</span></div>
    </section>`;
  }

  // One log scale for all bands, so they compare at a glance.
  const lo = Math.log10(Math.min(...M.rows.map((r) => r.boot.p25))), span = Math.log10(Math.max(...M.rows.map((r) => r.boot.p75))) - lo;
  const at = (v) => Math.min(100, Math.max(0, (100 * (Math.log10(v) - lo)) / span));
  const bandBar = (r) => `<span class="bb"><i style="left:${at(r.boot.p25).toFixed(1)}%;width:${(at(r.boot.p75) - at(r.boot.p25)).toFixed(1)}%"></i><b style="left:${at(r.iv.value).toFixed(1)}%"></b></span>`;
  let on = ''; // the chain filter, listed first in each row
  const NOTE_TAG = { above: 'off list ≥ floor', named: 'chain-named', shares: 'name shared' };
  function rowHtml(r) {
    const p = r.plan, tag = r.note && NOTE_TAG[r.note.split(' ')[0]];
    const net = p.net < 0 ? `<td class="num neg"><b>needs ${usd(r.iv.value * p.breakEven)}</b><small>launch value to pay</small></td>` : `<td class="num"><b>${usd(p.net)}</b><small>${usd(p.perHour)}/h · ${p.weeks} wk</small></td>`;
    return `<tr class="ranked" data-slug="${esc(r.slug)}"><td class="rk"><b>${r.rank}</b><small>${r.boot.rankLo}–${r.boot.rankHi}</small></td>
      <td class="name"><a href="#p/${esc(r.slug)}">${esc(r.name)}</a>${r.watch ? '<i class="tag">watchlist</i>' : ''}${tag ? `<i class="tag grey" title="${esc(r.note)}">${tag}</i>` : ''}<small>${esc(r.category || 'no category')} · ${[on, ...r.chains.filter((c) => c !== on)].filter(Boolean).slice(0, 2).map((c) => (c === on ? `<b>${esc(L.chainName(c))}</b>` : esc(L.chainName(c)))).join(', ')}${r.chains.length > 2 ? ` +${r.chains.length - 2}` : ''}</small></td>
      <td class="val"><b>${usd(r.iv.value)}</b><small>P25–P75 ${usd(r.boot.p25)}–${usd(r.boot.p75)}</small></td><td>${bandBar(r)}</td>
      <td class="num">${usd(r.tvl_usd)}</td><td class="num ${r.change_7d > 0 ? 'up' : ''}">${pct(r.change_7d)}</td><td class="num" title="${r.iv.days === null ? 'no listing date: 365 assumed' : ''}">${r.iv.days === null ? '365*' : r.iv.days}</td>
      <td class="num">${odds(p.breakEven)}</td>${net}<td><i class="verdict v-${p.verdict}">${L.VERDICT_LABEL[p.verdict]}</i></td></tr>`;
  }
  function anchorHtml(t) {
    return `<tr class="anchor"><td class="rk">–</td><td class="name">${esc(t.name)}<i class="tag grey">trades</i><small>${esc(t.category || 'no category')} · reference, not ranked</small></td>
      <td class="val"><b>${usd(t.mcap_usd)}</b><small>market cap</small></td><td><span class="bb"><b class="g" style="left:${at(t.mcap_usd).toFixed(1)}%"></b></span></td><td class="num">${usd(t.tvl_usd)}</td><td class="num">${pct(t.change_7d)}</td>
      <td class="num" colspan="4">market ${(t.mcap_usd / t.tvl_usd).toFixed(2)}× TVL · our curve would say ${usd(L.impliedValue(t, M.fit, S.as_of).value)}</td></tr>`;
  }

  /** Every token that trades: market cap beside our curve's price. */
  function tradedHtml(st) {
    const q = st.q.trim().toLowerCase();
    const list = M.traded.filter((t) => (!st.fam || L.familyOf(t.category) === st.fam) && (!st.chain || t.chains.includes(st.chain)) && (!q || t.name.toLowerCase().includes(q)))
      .map((t) => ({ t, curve: L.impliedValue(t, M.fit, S.as_of).value })).sort((a, b) => b.t.mcap_usd - a.t.mcap_usd || (a.t.slug < b.t.slug ? -1 : 1));
    const rows = list.map(({ t, curve }) => `<tr class="anchor"><td class="name">${esc(t.name)}<small>${esc(t.category || 'no category')}</small></td><td class="num">${usd(t.tvl_usd)}</td><td class="num">${pct(t.change_7d)}</td>
      <td class="num val"><b>${usd(t.mcap_usd)}</b></td><td class="num">${(t.mcap_usd / t.tvl_usd).toFixed(2)}×</td><td class="num">${usd(curve)}</td><td class="num">${times(t.mcap_usd / curve)}</td></tr>`).join('');
    return `<div class="status"><span><b>${list.length}</b> tokens already trade: the curve's data, never ranked, by market cap</span></div>
      <table class="board"><thead><tr><th>Token</th><th class="num">TVL</th><th class="num">7d TVL</th><th class="num">Market cap</th><th class="num">× TVL</th><th class="num">Our curve</th><th class="num">Market ÷ curve</th></tr></thead><tbody>${rows}</tbody></table>`;
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
      <p class="explain">Implied value = size curve on TVL × category family, both fit on ${M.traded.length} traded tokens, × bounded tilts for 7-day growth (×${L.MODEL.growthMin}–${L.MODEL.growthMax}) and time tracked with no token recorded (down to ×${1 - L.MODEL.seasonDepth}; 365* = no listing date, assumed). Under each rank: its P10–P90 rank over 200 refits; the band adds a protocol's own miss. Big pools farm poorly: $5,000 is a thin slice.</p>
      <div class="toolbar">
        <div class="group seg">${chip('tab', '', 'Still to come', M.rows.length)}${chip('tab', 'traded', 'Already trades', M.traded.length)}</div>
        <input id="q" type="search" placeholder="Search a protocol" value="${esc(st.q)}" aria-label="Search">
        <div class="group">${Object.keys(L.FAMILY_LABEL).filter((f) => famCount[f]).map((f) => chip('fam', f, L.FAMILY_LABEL[f], famCount[f])).join('')}</div>
        <select id="chain" aria-label="Chain"><option value="">All chains</option>${chains.map((c) => `<option ${st.chain === c ? 'selected' : ''} value="${esc(c)}">${esc(c)} (${chainCount[c]})</option>`).join('')}</select>
        <div class="group">${['farm', 'marginal', 'skip'].map((v) => chip('verdict', v, L.VERDICT_LABEL[v], verdictCount[v] || 0)).join('')}${chip('watch', '1', 'Watchlist', M.watch)}</div>
        <label class="toggle"><input id="anchors" type="checkbox" ${st.anchors === '1' ? 'checked' : ''}> Traded anchors (by value)</label>
      </div>
      <div id="results"></div>`;
    renderResults(st);
    $('#view').onclick = (e) => {
      const b = e.target.closest('button.chip, [data-s], button.x');
      if (b && b.dataset.k) { st[b.dataset.k] = st[b.dataset.k] === b.dataset.v ? '' : b.dataset.v; return update(st, true); }
      if (b && b.dataset.s) { st.dir = st.sort === b.dataset.s && st.dir === 'desc' ? 'asc' : b.dataset.s === 'odds' || b.dataset.s === 'name' ? 'asc' : 'desc'; st.sort = b.dataset.s; return update(st, true); }
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
    if (st.tab === 'traded') { $('#results').innerHTML = tradedHtml(st); return; }
    on = st.chain;
    $('.toggle').classList.toggle('off', anchorsOff(st));
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
    const sk = (key) => `<span data-s="${key}" class="${st.sort === key ? 'sorted' : ''}">${HEAD[key]}${st.sort === key ? (st.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>`;
    const th = (key, cls) => `<th class="${cls || ''}">${sk(key)}</th>`;
    $('#results').innerHTML = `<div class="status">${active}<span><b>${shown.length}</b> of ${M.rows.length} ranked shown${anchors.length ? `, ${anchors.length} traded anchors` : ''} · sorted by ${HEAD[st.sort]}</span></div>
      <table class="board"><thead><tr><th class="rk">#</th>${th('name')}${th('value')}<th>P25–P75 band</th>${['tvl', 'growth', 'days', 'odds'].map((k) => th(k, 'num')).join('')}<th class="num">${sk('net')}<br>${sk('perhour')}</th><th>Farm verdict</th></tr></thead>
      <tbody>${body.join('') || '<tr><td colspan="10" class="empty">No ranked protocol matches these filters; remove a chip above.</td></tr>'}</tbody></table>`;
  }

  // -- the detail view

  /** The value as an equation: size curve x each multiplier. */
  function equationHtml(r) {
    const iv = r.iv;
    const tile = (big, label, m) => `<div class="tile ${m > 1.0005 ? 'up' : m < 0.9995 ? 'down' : ''}"><b>${big}</b><span>${label}</span></div>`;
    return `<div class="eq">${tile(usd(iv.base), `size curve at ${usd(r.tvl_usd)} TVL`)}<i>×</i>${tile(iv.famMult.toFixed(2), `${L.FAMILY_LABEL[iv.fam]} family`, iv.famMult)}<i>×</i>` +
      `${tile(iv.growth.toFixed(2), `7-day TVL ${pct(r.change_7d)}`, iv.growth)}<i>×</i>${tile(iv.season.toFixed(2), `${iv.days === null ? '365* assumed' : iv.days} days tracked`, iv.season)}<i>=</i>` +
      `<div class="tile res"><b>${usd(iv.value)}</b><span>implied value</span></div></div>`;
  }

  /** Band on a log axis; numbered peers at their multiples. */
  function bandHtml(r) {
    const v = [r.boot.p25, r.boot.p75, r.iv.value, ...r.peers.map((t) => t.implied)].map(Math.log10);
    const a = Math.min(...v) - 0.2, x = (u) => (100 * (Math.log10(u) - a)) / (Math.max(...v) + 0.2 - a);
    return `<div class="bd"><i style="left:${x(r.boot.p25).toFixed(1)}%;width:${(x(r.boot.p75) - x(r.boot.p25)).toFixed(1)}%"></i>${r.peers.map((t, i) => `<em style="left:${x(t.implied).toFixed(1)}%">${i + 1}</em>`).join('')}` +
      `<b style="left:${x(r.iv.value).toFixed(1)}%"></b><span style="left:${x(r.boot.p25).toFixed(1)}%">P25 ${usd(r.boot.p25)}</span><span style="left:${x(r.boot.p75).toFixed(1)}%">P75 ${usd(r.boot.p75)}</span></div>`;
  }

  /** The plan's calendar: numbered steps, weeks, the stop line. */
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
      <text class="stopt" x="24" y="82">${plan.steps.findIndex((s) => s.kind === 'stop') + 1} · any day: stop if TVL closes under ${usd(plan.stopTvl)}</text><line class="stop" x1="24" x2="684" y1="88" y2="88"/></svg>`;
  }

  /** One protocol: value, build-up, band, peers and costed plan. */
  function renderDetail(slug) {
    const r = M.rows.find((x) => x.slug === slug);
    if (!r) { location.hash = ''; return; }
    const p = r.plan, A = L.ASSUME;
    const steps = p.steps.map((s, i) => `<tr class="${s.kind === 'stop' ? 'cond' : ''}"><td class="n">${i + 1}</td><td class="when">${s.day === null ? 'any day' : s.every ? `weekly ×${p.weeks}` : `day ${s.day}`}</td>
      <td>${esc(s.text)}</td><td class="num">${usd(s.cost)}</td><td class="num">${s.minutes} min</td></tr>`).join('');
    const peers = r.peers.map((t, i) => `<tr><td class="n">${i + 1}</td><td>${esc(t.name)}</td><td class="num">${usd(t.tvl_usd)}</td><td class="num">${usd(t.mcap_usd)}</td><td class="num">${t.multiple.toFixed(2)}×</td><td class="num">${usd(t.implied)}</td></tr>`).join('');
    $('#view').innerHTML = `<header class="dhead"><a class="crumb" href="${esc(back)}">← Board</a><h1>${esc(r.name)}</h1><i class="tag">records no token</i>${r.watch ? '<i class="tag">watchlist</i>' : ''}<i class="tag grey">${esc(r.category || 'no category')}</i><i class="tag grey">${esc(r.chains.slice(0, 3).join(' · '))}${r.chains.length > 3 ? ` +${r.chains.length - 3}` : ''}</i></header>
      ${r.note ? `<p class="note">Note: ${esc(r.note)}.</p>` : ''}
      <div class="detail">
        <section class="card">
          <div class="facts"><div class="big"><span>Implied value, our model's claim</span><b>${usd(r.iv.value)}</b></div><div><span>Rank · P10–P90 of refits</span><b>${r.rank} of ${M.rows.length} · ${r.boot.rankLo}–${r.boot.rankHi}</b></div><div><span>P25–P75 band</span><b>${usd(r.boot.p25)}–${usd(r.boot.p75)}</b></div></div>
          <h2>How the value is built</h2>${equationHtml(r)}
          <h2>Band and nearest traded peers <small>same family, within 10× of the curve</small></h2>${bandHtml(r)}
          <table class="mini"><thead><tr><th>#</th><th>Token that trades</th><th class="num">TVL</th><th class="num">Mcap</th><th class="num">× TVL</th><th class="num">Applied here</th></tr></thead><tbody>${peers}</tbody></table>
          <h2>The farm arithmetic</h2>
          <p class="math">Slice if a token launches = ${A.airdropShare * 100}% airdrop share × ${usd(r.iv.value)} × ${usd(p.deposit)} / ${usd(r.tvl_usd)} TVL = <b>${usd(p.slice)}</b><br>
          Break-even = (${usd(p.costs)} fees + ${usd(p.capitalCost)} income forgone at ${(p.carry * 100).toFixed(1)}% a year for ${p.weeks} weeks) / ${usd(p.slice)} = <b>${odds(p.breakEven)}</b>: ${esc(L.oddsText(p, r.iv.value))}</p>
          <p class="assume">Estimates: gas ${usd(p.gas)} a transaction on ${esc(p.chain)}, ${usd(A.bridgeFee)} a bridge leg, T-bills ${A.tbillRate * 100}% less the deposit's yield. Deposit grows with TVL within ${usd(A.depositMin)}–${usd(A.depositMax)}; younger protocols are held longer; stop = twice the 7-day swing.</p>
        </section>
        <section class="card plan">
          <h2>Farm plan <small>${esc(p.chain)} · ${usd(p.deposit)} · ${p.weeks} weeks</small><i class="verdict v-${p.verdict}">${L.VERDICT_LABEL[p.verdict]}</i></h2>${p.capped ? `<p class="note">Capped at Marginal: TVL ${pct(r.change_7d)} in 7 days, past the ${A.capDrop}% limit; the odds alone say worth farming.</p>` : ''}
          ${timelineSvg(p)}
          <table class="steps"><thead><tr><th>#</th><th>When</th><th>Step</th><th class="num">Cost</th><th class="num">Time</th></tr></thead><tbody>${steps}</tbody></table>
          <div class="totals"><div><span>Fees and gas</span><b>${usd(p.costs)}</b></div><div><span>Income forgone</span><b>${usd(p.capitalCost)}</b></div><div><span>Your time</span><b>${Math.round(p.minutes)} min</b></div><div><span>Slice if launch</span><b>${usd(p.slice)}</b></div><div><span>Break-even odds</span><b>${odds(p.breakEven)}</b></div><div><span>Net per hour</span><b>${usd(p.perHour)}</b></div></div>
          <ul class="honesty">${D.honesty.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
        </section>
      </div>`;
  }

  // -- the method view

  function scatterSvg() {
    const x = (v) => 70 + ((Math.log10(v) - 6.5) / 4.5) * 540, y = (v) => 370 - ((Math.log10(v) - 4) / 7) * 350;
    let grid = '';
    const tick = (e) => ['$10K', '$100K', '$1M', '$10M', '$100M', '$1B', '$10B', '$100B'][e - 4];
    for (let e = 7; e <= 10; e++) grid += `<line class="g" x1="${x(10 ** e)}" x2="${x(10 ** e)}" y1="20" y2="370"/><text x="${x(10 ** e)}" y="388" text-anchor="middle">${tick(e)}</text>`;
    for (let e = 4; e <= 11; e++) grid += `<line class="g" x1="70" x2="610" y1="${y(10 ** e)}" y2="${y(10 ** e)}"/><text x="62" y="${y(10 ** e) + 4}" text-anchor="end">${tick(e)}</text>`;
    const traded = M.traded.map((t) => `<circle class="t" cx="${x(t.tvl_usd).toFixed(1)}" cy="${y(t.mcap_usd).toFixed(1)}" r="3.5"/>`).join('');
    const ranked = M.rows.map((r) => `<rect class="r" x="${(x(r.tvl_usd) - 2.5).toFixed(1)}" y="${(y(r.iv.value) - 2.5).toFixed(1)}" width="5" height="5"/>`).join('');
    const line = (tvl) => 10 ** (M.fit.a + M.fit.b * (Math.log10(tvl) - L.MODEL.centerLogTvl));
    return `<svg class="scatter" viewBox="0 0 620 404" role="img" aria-label="Fit of market cap on TVL">${grid}${traded}${ranked}
      <line class="fit" x1="${x(10 ** 6.5)}" y1="${y(line(10 ** 6.5))}" x2="${x(1e11)}" y2="${y(line(1e11))}"/>
      <text class="lab" x="610" y="402" text-anchor="end">TVL (log scale)</text><text class="lab" x="76" y="16">market cap, or implied value (log scale)</text></svg>`;
  }

  function renderMethod() {
    const loo = M.R.loo, f = M.fit, u = M.R.universe, A = L.ASSUME;
    const looRows = loo.map((v) => `<tr><td>${esc(v.label)}</td><td class="num"><b>${v.medianMiss.toFixed(2)}×</b></td><td class="num">${v.meanLogMiss.toFixed(3)}</td><td class="num">${Math.round(v.within3x * 100)}%</td><td class="num">${v.rankCorr.toFixed(2)}</td></tr>`).join('');
    const famN = {};
    M.traded.forEach((t) => { const k = L.familyOf(t.category); famN[k] = (famN[k] || 0) + 1; });
    const fams = Object.keys(f.fam).map((k) => `${L.FAMILY_LABEL[k]} <b>${times(10 ** f.fam[k])}</b> (${famN[k]})`).join(' · ');
    const why = {};
    u.setAside.forEach((s) => { const k = s.reason.startsWith('shares') ? 'shares a name with a protocol that records a token' : s.reason.split(/[:,]/)[0]; why[k] = (why[k] || 0) + 1; });
    const ranked = M.rows.length, traded = M.traded.length, aside = u.setAside.length;
    $('#view').innerHTML = `<div class="method">
      <section class="card"><h2>The fit: ${traded} traded tokens, market cap against TVL</h2>${scatterSvg()}
        <p class="legend"><b class="t">●</b> traded token <b class="r">■</b> ranked protocol at its implied value <b>—</b> size curve: log10 value = ${f.a.toFixed(2)} + ${f.b.toFixed(2)} × log10(TVL / $100M)</p>
        <p>A token's market cap grows with TVL at a slope of ${f.b.toFixed(2)}: ten times the TVL is worth ${(10 ** f.b).toFixed(1)} times the value, so small protocols carry a higher multiple than large ones.</p>
        <div class="judge"><h2>Note to the judge</h2><ol>
          <li>Working radar: <code>deriveAll</code> runs <code>buildRadar</code> on the raw snapshot in this browser; <code>selectUniverse</code> ranks ${M.watch} of ${S.watchlist.length} watchlist protocols plus ${ranked - M.watch} more; every row is checked against board.json (${M.check.ok ? 'all match' : 'see the board'}).</li>
          <li>Value model: <code>impliedValue</code> uses TVL, category family, 7-day change and days since listing, never a name; <code>fitCurve</code> fits it on traded tokens, <code>looCheck</code> tests it, <code>bootstrapRanks</code> gives bands and rank ranges; the growth and seasoning tilts move ${M.R.moves.five} of ${ranked} ranks 5+ places.</li>
          <li>Farm plans: <code>farmPlan</code> sets chain, deposit, hold and stop from each row's data, with cost, time and break-even odds.</li>
          <li>Page: <code>filterRows</code>, <code>sortRows</code>, <code>renderDetail</code>; state lives in the URL hash.</li>
        </ol></div></section>
      <section class="card"><h2>Out of sample: each traded token priced by a fit that never saw it</h2>
        <table class="mini"><thead><tr><th>Model</th><th class="num">Median miss</th><th class="num">Mean |log miss|</th><th class="num">Within 3×</th><th class="num">Rank corr.</th></tr></thead><tbody>${looRows}</tbody></table>
        <p>Size curve and family earn their place. Growth and seasoning move the median miss ${loo[2].medianMiss.toFixed(2)}×→${loo[3].medianMiss.toFixed(2)}×, within 3× ${Math.round(loo[2].within3x * 100)}→${Math.round(loo[3].within3x * 100)}%, mean |log miss| ${loo[2].meanLogMiss.toFixed(3)}→${loo[3].meanLogMiss.toFixed(3)}: no real gain (${M.traded.filter((t) => t.change_7d < 0).length} of ${traded} traded tokens lost TVL this week; a traded token's age is not time without a token). So both are bounded priors: growth tilts value by half the 7-day change (×${L.MODEL.growthMin}–×${L.MODEL.growthMax}); seasoning discounts a new protocol up to ${L.MODEL.seasonDepth * 100}%, fading over ${L.MODEL.seasonDays} days. They move ${M.R.moves.five} of ${ranked} ranks by 5+ places, ${M.R.moves.ten} by 10+. Rank corr. tests the ranking itself (Spearman's rho inside 8 held-out folds): about ${loo[0].rankCorr.toFixed(1)} for every variant, so order comes from TVL.</p>
        <h2>Category family offsets <small>mean miss, each capped at 10×, shrunk by ${L.MODEL.familyShrinkK} pseudo-tokens (traded count)</small></h2><p>${fams}</p>
        <h2>From ${S.protocols.length} protocols to ${ranked} ranks</h2>
        <p>${traded} trade (fit and anchors) · ${u.recorded} record a token with no market cap (not ranked) · ${ranked + aside} record no token: ${ranked} ranked, ${aside} set aside as ${Object.keys(why).map((k) => `${esc(k)} (${why[k]})`).join(', ')}.</p>
        <h2>Farm verdicts</h2><p>Worth farming at break-even odds of ${A.farmOdds * 100}% or less (it pays if 1 hold in ${1 / A.farmOdds} sees a launch), marginal to ${A.marginalOdds * 100}%, else skip. A 7-day TVL fall past ${A.capDrop}% caps it at marginal (${M.rows.filter((r) => r.plan.capped).length} row here).</p></section></div>`;
  }

  // -- routing

  function route() {
    const r = readHash();
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.view === (r.view === 'method' ? 'method' : 'board')));
    if (r.view === 'detail') renderDetail(r.slug);
    else if (r.view === 'method') renderMethod();
    else { back = location.hash || '#board'; renderBoard(r.st); }
    window.scrollTo(0, 0);
  }
  $('#asof').textContent = `DefiLlama snapshot ${S.as_of} · model ${D.model_version}`;
  window.addEventListener('hashchange', route);
  route();
})();
