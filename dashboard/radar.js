/* Launchscope page: renders the board from data.js and re-derives every number with model.js. */
(function () {
  'use strict';
  const D = globalThis.LAUNCHSCOPE_DATA;
  const L = globalThis.Launchscope;
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** Refit and recompute every row in the browser; compare with what main.ts wrote. */
  function verify() {
    const fit = L.fitCurve(L.fitPoints(D.traded, D.as_of, true), { slope: true, families: true, priors: true });
    let same = 0;
    for (const r of D.rows) if (Math.abs(L.impliedValue(r, fit, D.as_of).value - r.value) <= 1) same++;
    return { fit, same, total: D.rows.length };
  }

  function renderBoard(check) {
    $('#kpis').innerHTML =
      `<div><b>${D.counts.watchlist}/${D.counts.watchlist}</b> watchlist covered</div>` +
      `<div><b>${D.counts.ranked}</b> ranked, record no token</div>` +
      `<div><b>${D.counts.traded}</b> traded tokens fit the curve</div>` +
      `<div class="${check.same === check.total ? 'ok' : 'bad'}"><b>${check.same}/${check.total}</b> values re-derived in this page ${check.same === check.total ? '✓' : '✗'}</div>`;
    const rows = D.rows.map((r) =>
      `<tr><td class="num">${r.rank}</td><td><a href="#p/${esc(r.slug)}">${esc(r.name)}</a>${r.watch ? ' <span class="tag">watchlist</span>' : ''}</td>` +
      `<td>${esc(r.category || '-')}</td><td class="num"><b>${L.usd(r.value)}</b></td><td class="num">${L.usd(r.p25)} to ${L.usd(r.p75)}</td>` +
      `<td class="num">${r.rank_lo}-${r.rank_hi}</td><td class="num">${L.usd(r.tvl_usd)}</td><td class="num">${r.change_7d === null ? '-' : r.change_7d.toFixed(1) + '%'}</td>` +
      `<td class="v-${r.verdict}">${L.VERDICT_LABEL[r.verdict]}</td></tr>`).join('');
    $('#view').innerHTML = `<table class="board"><thead><tr><th>Rank</th><th>Protocol</th><th>Category</th><th>Implied value</th><th>P25 to P75</th><th>Rank range</th><th>TVL</th><th>7d</th><th>Farm verdict</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderDetail(slug, check) {
    const r = D.rows.find((x) => x.slug === slug);
    if (!r) return renderBoard(check);
    const iv = L.impliedValue(r, check.fit, D.as_of);
    const plan = L.farmPlan(r, iv.value, D.as_of);
    const steps = plan.steps.map((s) => `<li>${esc(L.stepText(s, plan.weeks))}</li>`).join('');
    $('#view').innerHTML = `<p><a href="#">Back to the board</a></p><h1>${esc(r.name)} <small>rank ${r.rank} · range ${r.rank_lo}-${r.rank_hi}</small></h1>` +
      `<p>Implied value <b>${L.usd(iv.value)}</b> = size curve ${L.usd(iv.base)} × family ${iv.famMult.toFixed(2)} × growth ${iv.growth.toFixed(2)} × seasoning ${iv.season.toFixed(2)}.</p>` +
      `<ol class="plan">${steps}</ol><p>${esc(L.summaryText(plan, iv.value))}</p><ul class="honesty">${L.HONESTY.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`;
  }

  function route() {
    const check = verify();
    const hash = location.hash.slice(1);
    if (hash.startsWith('p/')) renderDetail(decodeURIComponent(hash.slice(2)), check);
    else renderBoard(check);
  }
  window.addEventListener('hashchange', route);
  route();
})();
