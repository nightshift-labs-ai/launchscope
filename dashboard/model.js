/* Launchscope model: the one file that turns the DefiLlama snapshot into the board.
 *
 * main.ts loads this exact file (createRequire) to write board.json, and the page loads it again to
 * recompute every value, band, rank range and farm plan from the raw snapshot fields in data.js. No
 * protocol is known here by name: every number follows from its TVL, its 7-day TVL change and the days
 * since DefiLlama began tracking it while it still records no token.
 *
 *   value = 10^(a + b * log10(TVL / $100M) + family offset) * growthTilt * seasonTilt
 *
 *   a, b     least squares on logs over the snapshot's traded tokens (market cap against TVL)
 *   family   each category family's mean miss on the traded set, shrunk toward 0 by K pseudo-tokens
 *   tilts    bounded priors for 7-day growth and seasoning; looCheck shows what each one adds
 */
(function (root) {
  'use strict';

  const MODEL = {
    version: 'launchscope-1',
    centerLogTvl: 8, // the curve is centred at $100M of TVL
    familyShrinkK: 8, // pseudo-tokens pulling each family offset toward zero
    growthWeight: 0.5, // +10% TVL in 7 days tilts value by +5%...
    growthMin: 0.8, // ...never below x0.80
    growthMax: 1.25, // ...never above x1.25
    seasonDepth: 0.4, // a protocol tracked for 0 days is discounted 40%...
    seasonDays: 240, // ...and the discount fades with this time constant (days)
    unknownDays: 365, // no listed_at: assume one year
    bootstrapRuns: 200,
    seed: 20261114,
  };

  // Farm-plan assumptions, stated on every plan. Gas is USD per transaction, a round estimate.
  const ASSUME = {
    tbillRate: 0.04, // a year: what the capital would earn in T-bills instead
    airdropShare: 0.1, // share of a launched token's value paid to depositors, pro rata to TVL
    bridgeFee: 1, // USD to move USDC onto the chain, and again to move it back
    depositPerTvl: 1 / 50000,
    depositMin: 250,
    depositMax: 5000,
    gasDefault: 0.5,
    gas: {
      Ethereum: 3, Bitcoin: 2.5, Tron: 1, Cardano: 0.2, Arbitrum: 0.1, Avalanche: 0.1, Linea: 0.1, Scroll: 0.1,
      Starknet: 0.1, 'Hyperliquid L1': 0.1, 'zkSync Era': 0.1, Optimism: 0.08, Binance: 0.08, Base: 0.05,
      Monad: 0.05, Sonic: 0.05, Mantle: 0.05, Berachain: 0.05, Plasma: 0.05, Ink: 0.05, Unichain: 0.05,
      Flare: 0.05, TON: 0.05, Fantom: 0.05, Katana: 0.05, 'Robinhood Chain': 0.05, 'X Layer': 0.05, Pharos: 0.05,
      'Plume Mainnet': 0.05, Morph: 0.05, Etherlink: 0.05, Fraxtal: 0.05, Noble: 0.05, Bittensor: 0.05, CORE: 0.05,
      Polygon: 0.03, Sui: 0.02, Aptos: 0.02, Near: 0.02, Solana: 0.01, Stellar: 0.01, Algorand: 0.01, Ripple: 0.01,
      xDai: 0.01, Celo: 0.01, Arc: 0.01, Stable: 0.01,
    },
  };

  const HONESTY = [
    'One wallet, your own funds. Never split a position across wallets.',
    'A token launch is not promised: DefiLlama records no token here, which is not proof there is none.',
    "Claim only through the protocol's official domain, never through a link someone sends you.",
    "Cost arithmetic and our model's claim, not investment advice.",
  ];

  // ------------------------------------------------------------ helpers

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const log10 = Math.log10;

  function quantile(values, q) {
    const s = values.slice().sort((a, b) => a - b);
    const at = (s.length - 1) * q;
    const lo = Math.floor(at);
    return lo + 1 < s.length ? s[lo] + (s[lo + 1] - s[lo]) * (at - lo) : s[lo];
  }

  /** Seeded PRNG (mulberry32): the bootstrap draws the same numbers on every run. */
  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** "$1.2M"-style dollars for tables; cents below $10 so gas reads. */
  function usd(n) {
    const a = Math.abs(n), sign = n < 0 ? '-' : '';
    if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
    if (a >= 1e4) return `${sign}$${(a / 1e3).toFixed(0)}K`;
    if (a >= 10) return `${sign}$${groupThousands(Math.round(a))}`;
    return `${sign}$${a.toFixed(2)}`;
  }
  function groupThousands(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** Whole days from listed_at to as_of; null when DefiLlama gives no date. */
  function daysSince(listedAt, asOf) {
    if (!listedAt) return null;
    return Math.max(0, Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${listedAt}T00:00:00Z`)) / 86400000));
  }

  // ------------------------------------------------------------ families and the universe

  const FAMILY_OF = {
    Lending: 'lend', CDP: 'lend', 'CDP Manager': 'lend', 'Uncollateralized Lending': 'lend', 'Collateral Markets': 'lend',
    'Collateral Management': 'lend', Dexs: 'trade', Derivatives: 'trade', Options: 'trade', 'Prediction Market': 'trade',
    'Interest Rate Derivatives': 'trade', Synthetics: 'trade', 'OTC Marketplace': 'trade', 'NFT Marketplace': 'trade',
    Launchpad: 'trade', Yield: 'vault', 'Yield Aggregator': 'vault', 'Risk Curators': 'vault', 'Onchain Capital Allocator': 'vault',
    'Liquidity Manager': 'vault', 'Leveraged Farming': 'vault', Farm: 'vault', Indexes: 'vault', 'Options Vault': 'vault',
    'Basis Trading': 'vault', RWA: 'rwa', 'Stablecoin Wrapper': 'rwa', 'Dual-Token Stablecoin': 'rwa', 'Algo-Stables': 'rwa',
    'Stablecoin Issuer': 'rwa', 'Reserve Currency': 'rwa', CeDeFi: 'rwa', 'Liquid Staking': 'stake', Restaking: 'stake',
    'Staking Pool': 'stake', 'Liquid Restaking': 'stake', 'Restaked BTC': 'stake', 'Anchor BTC': 'stake', 'Decentralized BTC': 'stake',
    Bridge: 'infra', 'Canonical Bridge': 'infra', 'Cross Chain Bridge': 'infra', Chain: 'infra', Payments: 'infra',
    Privacy: 'infra', 'AI Agents': 'infra', 'Decentralized AI': 'infra', 'Crypto Card Issuer': 'infra', Insurance: 'infra', CEX: 'cex',
  };
  const FAMILY_LABEL = { lend: 'Lending & CDP', trade: 'Trading', vault: 'Vaults & yield', rwa: 'RWA & stables', stake: 'Staking', infra: 'Infra & chains', cex: 'Exchanges', other: 'Other' };
  const familyOf = (category) => FAMILY_OF[category] || 'other';

  // The house's watchlist rule, minus its $50M floor: the same exclusions applied to every size.
  const PRODUCT_CATEGORIES = ['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'];
  const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
  const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
  const WRAP_WORD = /\b(wrapped|staked|staking)\b/i;
  // First words too common to tie two protocols into one family (chains, generic nouns).
  const GENERIC_STEMS = new Set(['the', 'liquid', 'staked', 'wrapped', 'bitcoin', 'btc', 'eth', 'usd', 'yield', 'finance', 'protocol',
    'network', 'capital', 'labs', 'dao', 'earn', 'vault', 'vaults', 'lending', 'dex', 'bridge', 'pool', 'project', 'stake', 'staking',
    'plasma', 'stellar', 'solana', 'base', 'ethereum', 'arbitrum', 'binance', 'bnb', 'sui', 'ton', 'tron', 'avalanche', 'polygon',
    'optimism', 'hyperliquid', 'circle', 'figure', 'native', 'super', 'open', 'core', 'one', 'prime', 'x']);

  /** trades (a market cap), recorded (a token but no market cap) or none (records no token). */
  function tokenStatus(p) {
    if (p.mcap_usd !== null && p.mcap_usd > 0) return 'trades';
    if (p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null) return 'recorded';
    return 'none';
  }

  function nameStem(name) {
    const w = (name.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)[0] || '').replace(/\.(fi|io|xyz|money|finance)$/, '');
    return w.length >= 3 && !GENERIC_STEMS.has(w) ? w : null;
  }

  /** Why a protocol that records no token is kept off the ranks, or null when it is a launch still to come. */
  function setAsideReason(p, floor, onWatchlist, stems) {
    if (PRODUCT_CATEGORIES.includes(p.category)) return `${p.category}: usually a product of a token that trades`;
    if (VERSIONED.test(p.name)) return 'versioned name: a release of another protocol';
    if (EXCHANGE_NAME.test(p.name)) return "starts with an exchange's name";
    if (WRAP_WORD.test(p.name)) return 'wrapped or staked product';
    if (p.tvl_usd >= floor && !onWatchlist) return 'above the floor yet off the watchlist: DefiLlama files it under a parent';
    const stem = nameStem(p.name);
    if (stem && stems.has(stem)) return `shares its name with ${stems.get(stem)}, which records a token`;
    return null;
  }

  /** Split the snapshot: ranked (records no token), traded (the fit and the anchors), set aside, recorded. */
  function selectUniverse(snap) {
    const watch = new Set(snap.watchlist);
    const stems = new Map();
    for (const p of snap.protocols) {
      const s = tokenStatus(p) !== 'none' ? nameStem(p.name) : null;
      if (s && !stems.has(s)) stems.set(s, p.name);
    }
    const ranked = [], traded = [], setAside = [];
    let recorded = 0;
    for (const p of snap.protocols) {
      const status = tokenStatus(p);
      if (status === 'trades') traded.push(p);
      else if (status === 'recorded') recorded++;
      else {
        const why = setAsideReason(p, snap.floor_usd, watch.has(p.slug), stems);
        if (why === null || watch.has(p.slug)) ranked.push({ p, watch: watch.has(p.slug), note: why });
        else setAside.push({ slug: p.slug, name: p.name, tvl_usd: p.tvl_usd, reason: why });
      }
    }
    return { ranked, traded, setAside, recorded };
  }

  // ------------------------------------------------------------ the value model

  function growthTilt(change7d) {
    const g = change7d === null ? 0 : change7d / 100;
    return clamp(1 + MODEL.growthWeight * g, MODEL.growthMin, MODEL.growthMax);
  }
  function seasonTilt(days) {
    return 1 - MODEL.seasonDepth * Math.exp(-(days === null ? MODEL.unknownDays : days) / MODEL.seasonDays);
  }

  const FULL = { slope: true, families: true, priors: true };

  /** One point per traded token: x = log10(TVL / $100M), y = log10(market cap), the priors taken out when asked. */
  function fitPoints(traded, asOf, priors) {
    return traded.map((p) => ({
      slug: p.slug,
      x: log10(p.tvl_usd) - MODEL.centerLogTvl,
      y: log10(p.mcap_usd) - (priors ? log10(growthTilt(p.change_7d) * seasonTilt(daysSince(p.listed_at, asOf))) : 0),
      prior: priors ? log10(growthTilt(p.change_7d) * seasonTilt(daysSince(p.listed_at, asOf))) : 0,
      fam: familyOf(p.category),
    }));
  }

  /** Least squares on logs: y = a + b*x (b fixed at 1 without a slope), then shrunk family means of the misses. */
  function fitCurve(points, opts) {
    const n = points.length;
    let mx = 0, my = 0;
    for (const pt of points) { mx += pt.x; my += pt.y; }
    mx /= n; my /= n;
    let b = 1;
    if (opts.slope) {
      let sxy = 0, sxx = 0;
      for (const pt of points) { sxy += (pt.x - mx) * (pt.y - my); sxx += (pt.x - mx) * (pt.x - mx); }
      if (sxx > 0) b = sxy / sxx;
    }
    const a = my - b * mx;
    const fam = {};
    if (opts.families) {
      const sum = {}, count = {};
      for (const pt of points) {
        sum[pt.fam] = (sum[pt.fam] || 0) + (pt.y - a - b * pt.x);
        count[pt.fam] = (count[pt.fam] || 0) + 1;
      }
      for (const f of Object.keys(sum).sort()) fam[f] = sum[f] / (count[f] + MODEL.familyShrinkK);
    }
    return { a, b, fam, n };
  }

  const predictLog = (fit, x, fam) => fit.a + fit.b * x + (fit.fam[fam] || 0);

  /** Our model's claim for one protocol: what its token would be worth if its record stayed as it is. */
  function impliedValue(p, fit, asOf) {
    const days = daysSince(p.listed_at, asOf);
    const fam = familyOf(p.category);
    const base = Math.pow(10, fit.a + fit.b * (log10(p.tvl_usd) - MODEL.centerLogTvl));
    const famMult = Math.pow(10, fit.fam[fam] || 0);
    const growth = growthTilt(p.change_7d);
    const season = seasonTilt(days);
    return { value: Math.max(1, Math.round(base * famMult * growth * season)), base, famMult, growth, season, days, fam };
  }

  // ------------------------------------------------------------ honesty: leave-one-out and the bootstrap

  const VARIANTS = [
    { key: 'multiple', label: 'TVL x one multiple', slope: false, families: false, priors: false },
    { key: 'curve', label: '+ size curve (slope b)', slope: true, families: false, priors: false },
    { key: 'family', label: '+ category family', slope: true, families: true, priors: false },
    { key: 'full', label: '+ growth & seasoning priors', slope: true, families: true, priors: true },
  ];

  function spearman(xs, ys) {
    const rank = (v) => {
      const order = v.map((x, i) => i).sort((i, j) => v[i] - v[j] || i - j), r = new Array(v.length);
      for (let k = 0; k < order.length;) {
        let e = k;
        while (e + 1 < order.length && v[order[e + 1]] === v[order[k]]) e++;
        for (let m = k; m <= e; m++) r[order[m]] = (k + e) / 2 + 1;
        k = e + 1;
      }
      return r;
    };
    const rx = rank(xs), ry = rank(ys), n = xs.length, mean = (n + 1) / 2;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (rx[i] - mean) * (ry[i] - mean); sxx += (rx[i] - mean) ** 2; syy += (ry[i] - mean) ** 2;
    }
    return sxy / Math.sqrt(sxx * syy);
  }

  /** Each traded token predicted by a fit that never saw it, for each nested variant of the model. */
  function looCheck(traded, asOf) {
    return VARIANTS.map((v) => {
      const pts = fitPoints(traded, asOf, v.priors);
      const miss = [], predicted = [], actual = [];
      pts.forEach((pt, i) => {
        const fit = fitCurve(pts.filter((_, j) => j !== i), v);
        const yhat = predictLog(fit, pt.x, pt.fam);
        miss.push(Math.abs(pt.y - yhat));
        predicted.push(yhat + pt.prior);
        actual.push(pt.y + pt.prior);
      });
      return {
        key: v.key, label: v.label, n: pts.length,
        medianMiss: Math.pow(10, quantile(miss, 0.5)),
        meanLogMiss: miss.reduce((s, m) => s + m, 0) / miss.length,
        within3x: miss.filter((m) => m <= log10(3)).length / miss.length,
        spearman: spearman(predicted, actual),
      };
    });
  }

  /**
   * 200 refits on traded tokens drawn with replacement (seeded). Per row: the P25-P75 band of value
   * (each refit times one resampled miss of the full fit) and the P10-P90 range of its rank.
   */
  function bootstrapRanks(traded, rows, asOf, runs, seed) {
    const pts = fitPoints(traded, asOf, true);
    const full = fitCurve(pts, FULL);
    const resid = pts.map((pt) => pt.y - predictLog(full, pt.x, pt.fam));
    const rand = mulberry32(seed);
    const draws = rows.map(() => []), ranks = rows.map(() => []);
    for (let r = 0; r < runs; r++) {
      const sample = pts.map(() => pts[Math.floor(rand() * pts.length)]);
      const fit = fitCurve(sample, FULL);
      const vals = rows.map((p) => impliedValue(p, fit, asOf).value);
      vals.map((v, i) => i).sort((i, j) => vals[j] - vals[i] || cmp(rows[i].slug, rows[j].slug)).forEach((i, k) => ranks[i].push(k + 1));
      vals.forEach((v, i) => draws[i].push(v * Math.pow(10, resid[Math.floor(rand() * resid.length)])));
    }
    return rows.map((p, i) => ({
      p25: Math.round(quantile(draws[i], 0.25)), p75: Math.round(quantile(draws[i], 0.75)),
      rankLo: Math.round(quantile(ranks[i], 0.1)), rankHi: Math.round(quantile(ranks[i], 0.9)),
    }));
  }

  /** The traded tokens closest in TVL within the same family (any family when it has too few), with the multiple each implies. */
  function nearestPeers(p, traded, k) {
    const fam = familyOf(p.category), x = log10(p.tvl_usd);
    const same = traded.filter((t) => familyOf(t.category) === fam);
    return (same.length >= k ? same : traded)
      .map((t) => ({ t, d: Math.abs(log10(t.tvl_usd) - x) }))
      .sort((u, v) => u.d - v.d || cmp(u.t.slug, v.t.slug))
      .slice(0, k)
      .map(({ t }) => ({ slug: t.slug, name: t.name, tvl_usd: t.tvl_usd, mcap_usd: t.mcap_usd, multiple: t.mcap_usd / t.tvl_usd, implied: Math.round(p.tvl_usd * (t.mcap_usd / t.tvl_usd)) }));
  }

  // ------------------------------------------------------------ the farm plan

  function gasOn(chain) {
    return Object.prototype.hasOwnProperty.call(ASSUME.gas, chain) ? ASSUME.gas[chain] : ASSUME.gasDefault;
  }
  /** DefiLlama lists chains by TVL: the cheapest of the top three, where the deposits are; the first wins a tie. */
  function cheapestChain(chains) {
    let best = chains[0] || 'Ethereum';
    for (const c of chains.slice(0, 3)) if (gasOn(c) < gasOn(best)) best = c;
    return best;
  }
  const holdWeeks = (days) => 6 + Math.round(6 * (1 - Math.min(days === null ? MODEL.unknownDays : days, 730) / 730));
  const stopDropPct = (change7d) => (change7d === null ? 20 : clamp(Math.round(2 * Math.abs(change7d)), 10, 35));
  const roundDeposit = (x) => (x < 1000 ? Math.round(x / 50) * 50 : Math.round(x / 100) * 100);

  /** The one action a depositor takes, by category, with any cost beyond gas and the minutes it takes. */
  function depositAction(p, deposit, chain) {
    const c = p.category || '', fam = familyOf(c), d = usd(deposit), n = p.name;
    if (c === 'Dexs') return { text: `Add ${d} to ${n}'s deepest stablecoin pool on ${chain} (USDC paired with another dollar stablecoin), so price swings stay small.`, extra: deposit * 0.0005, minutes: 15 };
    if (c === 'Derivatives' || c === 'Options') return { text: `Deposit ${d} USDC into ${n}'s liquidity vault on ${chain}; it takes the other side of traders and can lose in sharp moves.`, extra: 0, minutes: 15 };
    if (c === 'Prediction Market' || c === 'OTC Marketplace') return { text: `Fund ${n} on ${chain} with ${d} USDC and keep it as resting liquidity rather than open bets.`, extra: 0, minutes: 15 };
    if (c === 'Chain') return { text: `Bridge ${d} USDC to ${n} through its official bridge and supply it in the chain's largest lending market.`, extra: ASSUME.bridgeFee, minutes: 25 };
    if (c === 'Payments') return { text: `Open a ${d} payment channel on ${n} with a well-connected node and keep it open.`, extra: 0, minutes: 30 };
    if (c === 'Insurance') return { text: `Provide ${d} of cover capital to ${n}'s pool on ${chain}; a paid claim can draw it down.`, extra: 0, minutes: 20 };
    if (fam === 'lend') return { text: `Supply ${d} USDC to ${n}'s main market on ${chain} and do not borrow against it.`, extra: 0, minutes: 10 };
    if (fam === 'rwa') return { text: `Pass ${n}'s KYC if it asks (allow 1 to 3 days), check its minimum, then subscribe ${d} to its main fund on ${chain}.`, extra: 0, minutes: 45 };
    if (fam === 'stake') return { text: `Stake ${d} of ${chain}'s native asset, only if you already hold it, through ${n}; the stake keeps that asset's price risk.`, extra: 0, minutes: 15 };
    if (fam === 'vault') return { text: `Deposit ${d} USDC into ${n}'s largest USDC vault on ${chain}; read its withdrawal delay before you sign.`, extra: 0, minutes: 15 };
    return { text: `Deposit ${d} USDC into ${n} on ${chain} through its own app.`, extra: 0, minutes: 15 };
  }

  /**
   * A costed timeline for one protocol, from its own record: chain, deposit, hold length and stop level
   * all follow from its chains, TVL, implied value, 7-day change and seasoning. The verdict compares the
   * slice a depositor gets if a token launches at our value with the plan's costs: the break-even odds
   * are the launch chance at which the plan pays for itself (we never guess that chance).
   */
  function farmPlan(p, value, asOf) {
    const days = daysSince(p.listed_at, asOf);
    const chain = cheapestChain(p.chains);
    const gas = gasOn(chain);
    const weeks = holdWeeks(days);
    const slicePerDollar = (ASSUME.airdropShare * value) / p.tvl_usd;
    const fixed = 7 * gas + 2 * ASSUME.bridgeFee;
    const deposit = clamp(roundDeposit(Math.max(p.tvl_usd * ASSUME.depositPerTvl, (3 * fixed) / slicePerDollar)), ASSUME.depositMin, ASSUME.depositMax);
    const drop = stopDropPct(p.change_7d);
    const stopTvl = p.tvl_usd * (1 - drop / 100);
    const act = depositAction(p, deposit, chain);
    const steps = [
      { day: 0, kind: 'verify', text: `Open ${p.name} from its DefiLlama listing, bookmark that domain, and read its docs on rewards and withdrawals.`, cost: 0, minutes: 20 },
      { day: 0, kind: 'fund', text: `Move ${usd(deposit)} USDC and about ${usd(10 * gas)} of gas to your one wallet on ${chain}${p.chains.length > 1 ? `, the cheapest of its top ${Math.min(3, p.chains.length)} chains by TVL` : ''}.`, cost: ASSUME.bridgeFee + gas, minutes: 15 },
      { day: 0, kind: 'deposit', text: act.text, cost: 2 * gas + act.extra, minutes: act.minutes },
      { day: 1, kind: 'record', text: `Check the position shows in the app and log the transaction hash, date and amount.`, cost: 0, minutes: 5 },
      { day: 7, kind: 'watch', text: `Every week, check its TVL on DefiLlama against the stop level ${usd(stopTvl)} (${drop}% under today's ${usd(p.tvl_usd)}).`, cost: 0, minutes: 5 * weeks, every: 7 },
      { day: Math.round((weeks * 7) / 2), kind: 'recheck', text: `Midway, re-read the rewards page; if it names a qualifying action for depositors (a lock, a claim, a vote), do it once.`, cost: gas, minutes: 10 },
      { day: null, kind: 'stop', text: `Stop rule: if TVL closes below ${usd(stopTvl)} or withdrawals pause, withdraw at once and end the plan.`, cost: gas, minutes: 10 },
      { day: weeks * 7, kind: 'exit', text: `After ${weeks} weeks, withdraw the ${usd(deposit)} and move it back off ${chain}.`, cost: gas + ASSUME.bridgeFee, minutes: 15 },
      { day: weeks * 7, kind: 'claim', text: `If a token launches, claim only through the domain bookmarked on day 0, never through a link sent to you.`, cost: gas, minutes: 10 },
    ];
    // The stop step replaces the exit when it fires, so it is not added to the totals.
    const counted = steps.filter((s) => s.kind !== 'stop');
    const costs = counted.reduce((sum, s) => sum + s.cost, 0);
    const minutes = counted.reduce((sum, s) => sum + s.minutes, 0);
    const capitalCost = (deposit * ASSUME.tbillRate * weeks * 7) / 365;
    const slice = slicePerDollar * deposit;
    const net = slice - costs - capitalCost;
    const breakEven = (costs + capitalCost) / slice;
    const verdict = breakEven <= 0.25 ? 'farm' : breakEven <= 0.6 ? 'marginal' : 'skip';
    return { chain, gas, deposit, weeks, drop, stopTvl, steps, costs, minutes, capitalCost, slice, net, breakEven, verdict, perHour: net / (minutes / 60) };
  }

  const VERDICT_LABEL = { farm: 'Worth farming', marginal: 'Marginal', skip: 'Skip' };

  /** One plan step as board.json's farm_steps string: when, what, what it costs and how long it takes. */
  function stepText(s, weeks) {
    const when = s.day === null ? 'Any day' : s.every ? `Weekly to week ${weeks}` : `Day ${s.day}`;
    const time = s.every ? `5 min a week, ${s.minutes} min in all` : `${s.minutes} min`;
    return `${when}: ${s.text} Cost: ${usd(s.cost)}. Time: ${time}.`;
  }
  function summaryText(plan, value) {
    return `Totals: ${usd(plan.costs)} of fees and gas, ${usd(plan.capitalCost)} of T-bill income forgone on ${usd(plan.deposit)} for ${plan.weeks} weeks, ` +
      `${plan.minutes} min of your time. If a token launches at our model's ${usd(value)}, the slice is ${usd(plan.slice)}: break-even launch odds ` +
      `${Math.round(plan.breakEven * 100)}%, verdict ${VERDICT_LABEL[plan.verdict]}.`;
  }

  // ------------------------------------------------------------ the whole board

  /** Everything the board shows, from the snapshot alone: main.ts writes it, the page re-derives it. */
  function buildRadar(snap) {
    const u = selectUniverse(snap);
    const fit = fitCurve(fitPoints(u.traded, snap.as_of, true), FULL);
    const scored = u.ranked.map((r) => ({ r, iv: impliedValue(r.p, fit, snap.as_of) }));
    scored.sort((x, y) => y.iv.value - x.iv.value || cmp(x.r.p.slug, y.r.p.slug));
    const boot = bootstrapRanks(u.traded, scored.map((s) => s.r.p), snap.as_of, MODEL.bootstrapRuns, MODEL.seed);
    const rows = scored.map((s, i) => ({
      rank: i + 1, p: s.r.p, watch: s.r.watch, note: s.r.note, iv: s.iv, band: boot[i],
      peers: nearestPeers(s.r.p, u.traded, 3), plan: farmPlan(s.r.p, s.iv.value, snap.as_of),
    }));
    return { universe: u, fit, rows, loo: looCheck(u.traded, snap.as_of) };
  }

  const api = {
    MODEL, ASSUME, HONESTY, FAMILY_LABEL, VERDICT_LABEL, VARIANTS,
    usd, groupThousands, quantile, mulberry32, daysSince, familyOf, tokenStatus, nameStem, selectUniverse,
    growthTilt, seasonTilt, fitPoints, fitCurve, predictLog, impliedValue, looCheck, bootstrapRanks,
    nearestPeers, cheapestChain, gasOn, farmPlan, stepText, summaryText, buildRadar,
  };
  root.Launchscope = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
