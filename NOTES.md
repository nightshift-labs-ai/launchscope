# Launchscope: build notes (keep current; a later session continues from here)

Entry for make.fun token-radar-01. Brief: /home/agent/makefun/briefs/radar1_brief_1.md. Kit rules:
/home/agent/makefun-kit/tokenradar01/x_s228/token-radar-01-kit/RULES.txt. Never push, never submit.

## Commands
```sh
export PATH=/home/agent/tools/node22/bin:$PATH
export LD_LIBRARY_PATH=/home/agent/tools/libroot/usr/lib/x86_64-linux-gnu
SNAP=/home/agent/makefun-kit/tokenradar01/x_s228/token-radar-01-kit/input/snapshot.json
MAKEFUN_OUTPUT_DIR=out node main.ts --input $SNAP     # build out/
node tools/shoot.mjs                                  # screenshots/ from out/dashboard
MAKEFUN_OUTPUT_DIR=out node main.ts --input $SNAP     # rebuild so the dossier carries the images
node tools/gate.mjs --snapshot $SNAP                  # 7 gate rows + determinism (run before each commit)
```

## Layout
- `main.ts`: reads the snapshot, loads `dashboard/model.js` via createRequire, writes board.json, data.js
  (at /output/data.js, outside dashboard/ so data never eats the judge's 64 KB source budget), copies
  dashboard/ + screenshots/, writes dossier.json with vendor/makefun-board.ts (unchanged copy).
- `dashboard/model.js`: THE model (judge reads it): universe rule, fit, impliedValue, looCheck,
  bootstrapRanks, nearestPeers, farmPlan, stepText. Classic script: global `Launchscope` + module.exports.
- `dashboard/radar.js`: page logic; `index.html`; `style.css`. Names chosen so the dossier's path order is
  index.html, model.js, radar.js, style.css (the model is read second, CSS last).
- `tools/gate.mjs` (local gate + determinism), `tools/shoot.mjs` (Playwright screenshots).

## Decisions (with numbers, snapshot as_of 2026-11-14)
- Token status: `trades` = mcap_usd > 0 (128); `recorded` = token fields but no usable mcap (288, incl. 15
  with mcap 0; not ranked, not fit); `none` = records no token (342).
- Ranked universe (173 = 40 watchlist + 133): records no token, house watchlist rule minus the floor
  (product categories, versioned names, exchange names, wrapped/staked words), plus: above the floor but
  off the watchlist => DefiLlama files it under a parent (set aside); name stem shared with a protocol that
  records a token => set aside (GMX Solana, Kava Mint, Manta CeDeFi...). Watchlist rows always ranked (Mezo
  Earn carries a note). 169 set aside, reasons shown.
- Brief asked >=200 board rows; the honest to-come universe is 173. Padding would rank wrapped/staked/
  parented products as "to come" (criterion 2). Gate needs only 100 rows / 60 non-watchlist.
- board.json ranks = protocols that record no token only; traded tokens are unranked anchors on the page.
- Value = 10^(a + b*log10(TVL/1e8) + family offset) * growthTilt * seasonTilt.
  Fit on 128 traded: a=7.20, b=0.52 (log-log OLS, priors taken out first); 8 category families, offsets
  shrunk by K=8. LOO (128 traded) median miss / mean |log10 miss| / within 3x / Spearman:
  one multiple 4.77x 0.773 35% 0.43; + size curve 3.40x 0.693 42% 0.40; + family 3.24x 0.678 48% 0.42;
  + priors (full) 3.11x 0.679 48% 0.42. Spearman barely moves: order is set by TVL (curve rescales it). Growth/seasoning do NOT help out of sample (traded set's
  7-day changes were nearly all negative this week; listed_at of a traded token measures tracking, not
  token-free time), so they are bounded priors: growth x0.80-1.25 (0.5 per unit), seasoning
  1-0.4*exp(-days/240), unknown listed_at = 365 days. Say so on the method view.
- Bootstrap: 200 refits (mulberry32 seed 20261114) on resampled traded tokens; band = P25-P75 of refit
  value x one resampled residual (predictive, wide: ~x0.3 to x2.6); rank range = P10-P90 of rank (refits only).
- Farm plan: chain = cheapest of top-3 chains by TVL (DefiLlama orders chains by TVL), gas table = labelled
  assumptions; deposit = clamp(max(TVL/50k, 3x fixed costs / slice-per-$), $250, $5,000); hold =
  6..12 weeks (younger = longer); stop = TVL drop of clamp(2*|7d change|, 10, 35)%; slice = 10% airdrop
  share x value x deposit/TVL; verdict from break-even launch odds = (fees + T-bill 4% on capital)/slice:
  <=25% farm, <=60% marginal, else skip. Currently 21 farm / 107 marginal / 45 skip.
- Screenshot budget: gate caps dossier at 1.5 MiB and images are base64 (x4/3), so 4 images must total
  <= ~1.1 MB raw => <= 270 KB each (brief's 300-350 KB each would overflow with 4).

## Page (M2)
- Routes: `#board?fam=&chain=&verdict=&watch=&q=&anchors=1&sort=value&dir=desc` (defaults omitted),
  `#p/<slug>`, `#method`. Filter changes use history.replaceState (no re-render of the toolbar on typing).
- `deriveAll` (radar.js) refits + recomputes values, 200-run bootstrap, plans; KPI strip shows
  "board.json = this page" with counts (173/173 each). Fails visibly (red) if anything differs.
- Anchors: traded tokens within [min shown value /1.5, max *1.5], same filters, only in value order,
  thinned to one per ~6 ranked rows (22 on the full board).
- Detail: value + rank range + band; equation tiles (size curve x family x growth x seasoning = value);
  band strip with numbered peer diamonds; peers table; "farm arithmetic" (slice and break-even formulas
  with the row's numbers); plan card: timeline SVG, 9 costed/timed steps, totals, honesty box.
- Method: scatter (traded grey, ranked accent, fit line), LOO table (live looCheck), family offsets,
  universe accounting, note to the judge (function names).
- Screenshots: 1-board (#board), 2-detail (#p/opentrade, watchlist rank 10, RWA, marginal 46%),
  3-filtered (#board?fam=trade&verdict=farm&sort=perhour: 20 rows), 4-method. PNG 230-260 KB each.
- Budgets now: dashboard source ~62.9 KB, dossier text ~63.2 KB of 65,536 (uncut), dossier 1.45 MB of
  1.57 MB. Any addition must be paid for by a trim.

## Status
- M1 done (b1bcfe7): valid entry, gate 8/8, minimal page.
- M2 done: full page, 4 screenshots, README. Background review workflow (gate/model/plan) running;
  confirmed findings go into M3.
- Next (M3): judge-eye critique of the 4 screenshots, 5 weakest points listed here, fixed.
