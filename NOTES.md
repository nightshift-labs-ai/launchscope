# Launchscope: build notes (keep current; a later session continues from here)

Entry for make.fun token-radar-01. Brief: /home/agent/makefun/briefs/radar1_brief_1.md. Kit rules:
/home/agent/makefun-kit/tokenradar01/x_s228/token-radar-01-kit/RULES.txt. Never push, never submit.
Write entry files only with Write/Edit (the transcript gate credits only those lines; no sed -i on entry files).

## Commands
```sh
export PATH=/home/agent/tools/node22/bin:$PATH
export LD_LIBRARY_PATH=/home/agent/tools/libroot/usr/lib/x86_64-linux-gnu
SNAP=/home/agent/makefun-kit/tokenradar01/x_s228/token-radar-01-kit/input/snapshot.json
MAKEFUN_OUTPUT_DIR=out node main.ts --input $SNAP     # build out/
node tools/shoot.mjs [--only 2-detail]                # screenshots/ from out/dashboard (PNG, JPEG if >270 KB)
MAKEFUN_OUTPUT_DIR=out node main.ts --input $SNAP     # rebuild so the dossier carries the images
node tools/gate.mjs --snapshot $SNAP                  # 7 gate rows + determinism; warns on unstaged files
git add -A                                            # shoot.mjs may swap .png <-> .jpg
```

## Layout
- `main.ts`: reads + validates the snapshot, loads `dashboard/model.js` (createRequire), writes board.json
  (181 rows, farm_steps via stepText/summaryText which live in main.ts), data.js at /output/data.js =
  { model_version, snapshot (raw, as read), fit {a,b}, board [[slug, rank, value, p25, p75, rankLo, rankHi,
  verdict, net]...] }, copies dashboard/ + screenshots/, writes dossier.json.
- `dashboard/model.js`: THE model (judge reads it): selectUniverse, fitPoints/fitCurve, impliedValue,
  looCheck, bootstrapRanks, nearestPeers, depositAction/farmPlan, oddsText, buildRadar.
- `dashboard/radar.js`: page. deriveAll runs buildRadar(snapshot) in the browser and checks every row
  against board.json; board (to come / already trades tabs, filters, sort, anchors), renderDetail, renderMethod.
- Dossier path order: index.html, model.js, radar.js, style.css (model read 2nd, CSS last).

## Budgets (binding)
- Dossier source text must stay <= 65,536 bytes uncut: now 65,435 (dashboard files 65,089 bytes; dossier
  headings add ~346). Only ~100 bytes of room: any addition must be paid for by a trim first. The gate
  fails on a cut (our strict rule). Trims already taken: comments, merged CSS, family table -> one line,
  word lists as split strings, VARIANTS as tuples, shared HEAD labels, legend glyphs, honesty box, the
  index.html judge comment. Remaining trim candidates: long doc comments on bootstrapRanks/nearestPeers,
  the "From 758 protocols" paragraph, KPI span wording.
- Dossier <= 1.5 MiB: now 1.38 MB. 4 screenshots, each <= 270 KB (base64 grows them by a third).

## Model (snapshot as_of 2026-11-14)
- Universe: 758 protocols; 128 trade (mcap > 0: fit + anchors), 288 record a token without mcap (not
  ranked), 342 record no token -> 181 ranked (40/40 watchlist), 161 set aside.
  Set-aside rules: house watchlist rule minus floor (product categories, versioned names, wrapped/staked
  words); name stem shared with a token-recording protocol (generic words + every chain's first word are
  excluded from stems, from the data); chain venue (/^\S+ (DEX|AMM)$/ or first word = a chain's first word).
  Watchlist rows are always ranked (4 carry a chain-named note). Above-floor-but-off-watchlist rows (=
  DefiLlama parent) are ranked with a note (18), not dropped: the watchlist is a floor, not a ceiling.
- Value = 10^(a + b*log10(TVL/1e8) + family offset) * growthTilt * seasonTilt. a=7.25, b=0.52.
  Family offsets: mean residual clipped at +-1 dex, shrunk by K=8. Priors: growth x0.8-1.25 (0.5/unit),
  seasoning 1-0.4*exp(-days/240), unknown listed_at = 365.
- LOO median miss: one multiple 4.77x, + curve 3.40x, + family 3.31x, + priors 3.20x (mean |log miss|
  0.773, 0.693, 0.674, 0.676). Priors stated as not earning out of sample. Rank corr. = Spearman's rho
  inside each of 8 fixed folds (j % 8, one fit per fold), averaged: 0.40, 0.40, 0.39, 0.38 (same-order
  variants score the same; the old pooled-LOO version did not). Stated: order comes from TVL.
- Bootstrap 200 refits, seed 20261114: band = P25-P75 of refit x resampled residual; rank range = P10-P90
  over refits only (stated on the board).
- Peers: same family, closest TVL, only traded tokens within 10x of the curve (extreme multiples 43 -> 1).
- Farm plan: chain = cheapest of top-3 (DefiLlama orders chains by TVL); funding asset by chain/category
  (BTC chains/BTC categories -> BTC, Bittensor -> TAO, staking -> native coin you hold, else USDC);
  category actions incl. CDP savings pool, collateral vault, governance lock, stable mint, RWA fund (KYC
  step, deposit day 3), staking (no bridge legs, unbonding step); exit waits by category; stop = 2x the
  7-day swing (10-35%), costed like the exit; deposit = clamp(max(TVL/10k, 3x fixed/slice-per-$), 500,
  5000); hold 6-12 weeks (younger = longer); income forgone = deposit x (T-bill 4% - assumed deposit yield
  by family) x days; slice = 10% x value x deposit/TVL; break-even = costs/slice = the chance a token
  launches, with a snapshot, inside the hold; verdict on rounded odds: <=10% farm, <=25% marginal, else
  skip; a 7-day TVL fall past -30% (ASSUME.capDrop) caps farm at marginal (1 row: Anemoy Capital) ->
  57 / 80 / 44. Any non-USDC asset (BTC, TAO, QUBIC, staking coin) = "coin you already hold", no bridge
  legs (15 rows). perHour = net / active hours: board second line + sortable ($/hour), detail totals.

## M3 critique: the 5 weakest points (judge-eye read of the M2 screenshots + a 4-lens judge panel)
1. C1, coverage asserted not computed: "40/40" printed the watchlist size twice and the page never ran
   the universe rule. FIXED: data.js ships the raw snapshot; deriveAll runs buildRadar in the browser,
   counts watchlist coverage from the rows and checks ranks, values, bands, rank ranges and plans (181/181).
2. C2, traded vs to-come separation and the universe: traded tokens only as thinned grey rows; chain-native
   venues (XRPL DEX, Stellar DEX/AMM, Katana DEX, Plasma One...) ranked as "to come"; 20 above-floor
   protocols dropped by using the watchlist as a ceiling; a dead hard-coded exchange-name list. FIXED:
   "Still to come | Already trades" tabs (all 128 traded tokens with market cap, x TVL, our curve, market /
   curve); chain-venue rule; parented rows ranked with a note; EXCHANGE_NAME removed; anchors show our
   curve's price; family misses clipped at 10x (Trading x1.72 -> x1.47, set by one outlier before).
3. C3, plans impossible for some categories and too harsh overall: USDC to Bitcoin/Bittensor, CDP "supply
   USDC", staking with USDC bridge legs, Chain rows bridging twice, KYC timed on day 0, full 4% T-bill
   charge on yield-bearing deposits (all 40 watchlist rows skip/marginal), odds >100% printed, templated
   steps. FIXED: see Farm plan above; 10-11 steps by mechanism, row numbers in generic steps, exit waits.
4. C2 honesty details: pooled-LOO Spearman contradicted "order is set by TVL"; rank range vs band meaning
   unstated; peers with absurd multiples (0.000x, 14.5x). FIXED: column dropped, explain line states what
   each measures, peers within 10x of the curve.
5. C4/C5 legibility: 12 px secondary text (~8.5 px at the judge's 1024 px), faint band bars and anchor
   text, double sort arrow, inert anchors toggle, $/h column read as sub-minimum wage, back link lost
   filters. FIXED: 13 px, darker greys, one arrow + sortable affordance, toggle dimmed where it cannot
   apply, net $ (or "needs $X launch value") instead of $/h, back link keeps the board state. Paid for
   by removing the board's band-bar column and the detail band strip (numbers remain in text).

## Operator round after M3 (2026-11-16)
- Proxy-judge A/B: M3 06c14b7 beat v1 2a5f60e 6/6, all decided on criterion 1 (in-browser buildRadar
  re-run + counted 40/40): KEEP. Brought back what v1 had and M3 dropped, plus two operator fixes:
  1. board P25-P75 band bar (CSS bar, one shared log scale, own column) f1b4d7f
  2. detail band chart with numbered traded peers (CSS) 9ce3ddf
  3. method rank correlation, within 8 held-out folds 5390761
  4. net per hour: board second line + sortable, detail totals 836ea52
  5. native-coin plans say "you already hold", no bridge 74286ab
  6. verdict cap on a 7-day TVL fall past -30%, stated in detail + method fb7b693
- Then the merged review /home/agent/makefun/briefs/radar1_review_m3.md (appeared mid-round), one per commit:
  A1 rank range = "P10-P90 of 200 refits" 6ce1cfc; A2 family offsets "each capped at 10x" 00d50a9;
  A3 method quotes its own table + computed rank moves (buildRadar.moves: 104/181 by 5+, 44 by 10+;
  115/128 traded tokens lost TVL, computed) f26e0d0; B7 GROUND_RULES string in every row's farm_steps
  (main.ts, 11-12 steps) 4de4062; B8 honesty box -> one line under plan totals db5201f; A4 explainer:
  only curve + family are fitted, tilts bounded 842621d; A5 tag "off list >= floor" + exact note,
  EXCHANGE_NAME back (sets aside 0: CEX category first) b6c6a1d; A6 KPI says "verdicts and nets match"
  b54fae5; B9 "Days tracked", 365* where no listing date 8d23ee5; B10 tab label kept (no change);
  B11 plan wording (native coin "do not buy it", resting quotes + country-terms step, CDP < $1, CDP
  Manager -> vault action, hedged exit waits) 24f3800; C13 default board without anchors 60739ce;
  C13b judge note states rank moves dd70906; C15 scatter y-axis to $10K 0ff59d4; C14 filtered chain
  first in bold 108f4bf. C12 (readability at 1024 px): see Status.

## Status
- M1 b1bcfe7, M2 2a5f60e, M3 06c14b7, operator items 1-6 and review items above. Gate 8/8 +
  determinism after each commit; verdicts now 57 farm / 80 marginal / 44 skip.
- Open: review C12, readability at the judge's 1024 px (secondary text 13 px renders ~9 px). Two routes:
  (a) shoot.mjs at a 1200x833 viewport with deviceScaleFactor 1.2 (file stays 1440x1000, zero dashboard
  bytes; check the board table and the .detail/.method grids still fit, maybe fr units), or (b) a 14 px
  minimum in style.css (byte-neutral edits, fewer rows above the fold). Look at all 4 shots after.
- Possible next steps (free bytes first): sibling grouping for products of one pre-token protocol (Felix
  Vaults/Felix CDP, Figure Markets Prime/Exchange, Avant avUSD/avETH); prev/next links in the detail view;
  method legend wraps mid-formula; the board's "sorted by Implied value" capital.
