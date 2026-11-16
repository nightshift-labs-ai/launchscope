/* Launchscope model: snapshot in, board out. main.ts runs it for board.json; the page re-runs buildRadar.
 *   value = 10^(a + b * log10(TVL / $100M) + family offset) * growthTilt * seasonTilt
 * a, b: least squares on logs over the traded tokens (market cap vs TVL); family offset: shrunk mean miss;
 * tilts: bounded priors for 7-day growth and days with no token. No value is set by a name. */
(function (root) {
  'use strict';

  const MODEL = {
    version: 'launchscope-1',
    centerLogTvl: 8, // the curve is centred at $100M of TVL
    familyShrinkK: 8, // pseudo-tokens pulling each family offset toward zero
    growthWeight: 0.5, // +10% TVL in 7 days tilts value by +5%...
    growthMin: 0.8, // ...within x0.80 to x1.25
    growthMax: 1.25,
    seasonDepth: 0.4, // a protocol tracked for 0 days is discounted 40%...
    seasonDays: 240, // ...and the discount fades with this time constant (days)
    unknownDays: 365, // no listed_at: assume one year
    bootstrapRuns: 200,
    seed: 20261114,
  };

  // Farm-plan assumptions, stated on every plan (the snapshot carries no gas, fee or yield figures).
  const ASSUME = {
    tbillRate: 0.04, // a year, what the capital would earn instead
    depositYield: { lend: 0.03, vault: 0.03, rwa: 0.035, stake: 0.03, trade: 0.02 }, // what the deposit itself earns
    airdropShare: 0.1, // of a launched token's value, paid to depositors pro rata to TVL
    farmOdds: 0.1, // worth farming if it pays when 1 hold in 10 sees a launch, marginal up to 1 in 4
    marginalOdds: 0.25,
    bridgeFee: 1, // USD per bridge leg
    depositPerTvl: 1 / 10000,
    depositMin: 500,
    depositMax: 5000,
    capDrop: -30, // a 7-day TVL fall past -30% caps the verdict at marginal
    gasDefault: 0.5, // a chain missing from the tiers below
    gas: {},
  };
  // Gas in USD per transaction, by tier: round estimates, not quotes.
  for (const [usdPerTx, chains] of [[3, 'Ethereum'], [2.5, 'Bitcoin'], [1, 'Tron'], [0.2, 'Cardano'],
    [0.1, 'Arbitrum|Avalanche|Linea|Scroll|Starknet|Hyperliquid L1|zkSync Era|BSquared|Mezo'], [0.08, 'Optimism|Binance'],
    [0.05, 'Base|Monad|Sonic|Mantle|Berachain|Plasma|Ink|Unichain|Flare|TON|Fantom|Katana|Robinhood Chain|X Layer|Pharos|Plume Mainnet|Morph|Etherlink|Fraxtal|Noble|Bittensor|CORE'],
    [0.03, 'Polygon'], [0.02, 'Sui|Aptos|Near'], [0.01, 'Solana|Stellar|Algorand|Ripple|xDai|Celo|Arc|Stable']]) {
    for (const c of chains.split('|')) ASSUME.gas[c] = usdPerTx;
  }


  // -- helpers

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const log10 = Math.log10;

  function quantile(values, q) {
    const s = values.slice().sort((a, b) => a - b), at = (s.length - 1) * q, lo = Math.floor(at);
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
    if (a >= 10) return `${sign}$${String(Math.round(a)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
    return `${sign}$${a.toFixed(2)}`;
  }

  /** Whole days from listed_at to as_of; null when DefiLlama gives no date. */
  function daysSince(listedAt, asOf) {
    if (!listedAt) return null;
    return Math.max(0, Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${listedAt}T00:00:00Z`)) / 86400000));
  }

  // -- families and the universe

  // DefiLlama's categories in eight families: one category alone holds too few traded tokens to fit.
  const FAMILY_OF = {};
  for (const [fam, cats] of Object.entries({
    lend: 'Lending|CDP|CDP Manager|Uncollateralized Lending|Collateral Markets|Collateral Management',
    trade: 'Dexs|Derivatives|Options|Prediction Market|Interest Rate Derivatives|Synthetics|OTC Marketplace|NFT Marketplace|Launchpad',
    vault: 'Yield|Yield Aggregator|Risk Curators|Onchain Capital Allocator|Liquidity Manager|Leveraged Farming|Farm|Indexes|Options Vault|Basis Trading',
    rwa: 'RWA|Stablecoin Wrapper|Dual-Token Stablecoin|Algo-Stables|Stablecoin Issuer|Reserve Currency|CeDeFi',
    stake: 'Liquid Staking|Restaking|Staking Pool|Liquid Restaking|Restaked BTC|Anchor BTC|Decentralized BTC',
    infra: 'Bridge|Canonical Bridge|Cross Chain Bridge|Chain|Payments|Privacy|AI Agents|Decentralized AI|Crypto Card Issuer|Insurance',
    cex: 'CEX',
  })) for (const c of cats.split('|')) FAMILY_OF[c] = fam;
  const FAMILY_LABEL = { lend: 'Lending & CDP', trade: 'Trading', vault: 'Vaults & yield', rwa: 'RWA & stables', stake: 'Staking', infra: 'Infra & chains', cex: 'Exchanges', other: 'Other' };
  const familyOf = (category) => FAMILY_OF[category] || 'other';

  // The house's watchlist rule, minus its $50M floor: the same exclusions applied to every size.
  const PRODUCT_CATEGORIES = 'Bridge|Canonical Bridge|Liquid Staking|Liquid Restaking|Restaked BTC|CEX'.split('|');
  const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
  const WRAP_WORD = /\b(wrapped|staked|staking)\b/i;
  const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
  // Our two additions: a chain's own trading venue ("XRPL DEX"), and a name shared with a token-bearing protocol.
  const CHAIN_VENUE = /^\S+ (DEX|AMM)$/i;
  // First words that tie no two protocols together; every chain's first word joins them from the data.
  const GENERIC_WORDS = 'the liquid btc eth usd yield finance protocol network capital labs dao earn vault vaults lending dex bridge pool project stake native super open one prime'.split(' ');
  const firstWord = (s) => s.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)[0] || '';

  /** trades (a market cap), recorded (a token but no market cap) or none (records no token). */
  function tokenStatus(p) {
    if (p.mcap_usd !== null && p.mcap_usd > 0) return 'trades';
    if (p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null) return 'recorded';
    return 'none';
  }

  function nameStem(name, generic) {
    const w = firstWord(name).replace(/\.(fi|io|xyz|money|finance)$/, '');
    return w.length >= 3 && !generic.has(w) ? w : null;
  }

  /** Why a no-token protocol is kept off the ranks; null for a launch still to come. */
  function setAsideReason(p, stems, generic) {
    if (PRODUCT_CATEGORIES.includes(p.category)) return `${p.category}: usually a product of a token that trades`;
    if (VERSIONED.test(p.name)) return 'versioned name: a release of another protocol';
    if (WRAP_WORD.test(p.name)) return 'wrapped or staked product';
    if (EXCHANGE_NAME.test(p.name)) return "starts with an exchange's name";
    const stem = nameStem(p.name, generic);
    if (stem && stems.has(stem)) return `shares its name with ${stems.get(stem)}, which records a token`;
    if (CHAIN_VENUE.test(p.name) || p.chains.some((c) => firstWord(c) === firstWord(p.name))) return 'named for its chain, whose coin may be its token';
    return null;
  }

  /** Split the snapshot: ranked, traded (the fit), set aside, recorded. */
  function selectUniverse(snap) {
    const watch = new Set(snap.watchlist);
    const generic = new Set(GENERIC_WORDS);
    for (const p of snap.protocols) for (const c of p.chains) generic.add(firstWord(c));
    const stems = new Map();
    for (const p of snap.protocols) {
      const s = tokenStatus(p) !== 'none' ? nameStem(p.name, generic) : null;
      if (s && !stems.has(s)) stems.set(s, p.name);
    }
    const ranked = [], traded = [], setAside = [];
    let recorded = 0;
    for (const p of snap.protocols) {
      const status = tokenStatus(p);
      if (status === 'trades') traded.push(p);
      else if (status === 'recorded') recorded++;
      else {
        const on = watch.has(p.slug), why = setAsideReason(p, stems, generic);
        const parent = !why && !on && p.tvl_usd >= snap.floor_usd ? `above the ${usd(snap.floor_usd)} floor yet off the house watchlist; the house rule leaves out protocols DefiLlama files under a parent, which this snapshot does not name` : null;
        if (why === null || on) ranked.push({ p, watch: on, note: why || parent });
        else setAside.push({ slug: p.slug, name: p.name, tvl_usd: p.tvl_usd, reason: why });
      }
    }
    return { ranked, traded, setAside, recorded };
  }

  // -- the value model

  function growthTilt(change7d) {
    const g = change7d === null ? 0 : change7d / 100;
    return clamp(1 + MODEL.growthWeight * g, MODEL.growthMin, MODEL.growthMax);
  }
  function seasonTilt(days) {
    return 1 - MODEL.seasonDepth * Math.exp(-(days === null ? MODEL.unknownDays : days) / MODEL.seasonDays);
  }

  const FULL = { slope: true, families: true, priors: true };

  /** Per traded token: x = log10(TVL / $100M), y = log10(market cap) less the priors when asked. */
  function fitPoints(traded, asOf, priors) {
    return traded.map((p) => {
      const prior = priors ? log10(growthTilt(p.change_7d) * seasonTilt(daysSince(p.listed_at, asOf))) : 0;
      return { slug: p.slug, x: log10(p.tvl_usd) - MODEL.centerLogTvl, y: log10(p.mcap_usd) - prior, prior, fam: familyOf(p.category) };
    });
  }

  /** Least squares y = a + b*x (b = 1 without a slope), then shrunk family means of the misses. */
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
        // Each miss is clipped at 10x (1 in log10), so one odd token cannot set its family's offset.
        sum[pt.fam] = (sum[pt.fam] || 0) + clamp(pt.y - a - b * pt.x, -1, 1);
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

  // -- honesty: out-of-sample checks and the bootstrap

  // Nested variants: [key, label, slope, families, priors].
  const VARIANTS = [['multiple', 'TVL x one multiple', 0, 0, 0], ['curve', '+ size curve (slope b)', 1, 0, 0],
    ['family', '+ category family', 1, 1, 0], ['full', '+ growth & seasoning priors', 1, 1, 1]]
    .map(([key, label, slope, families, priors]) => ({ key, label, slope: !!slope, families: !!families, priors: !!priors }));

  /** Spearman's rho from ranks (the values are continuous, so ties do not arise). */
  function spearman(a, b) {
    const ranks = (v) => { const r = []; v.map((x, i) => i).sort((i, j) => v[i] - v[j]).forEach((i, k) => (r[i] = k)); return r; };
    const ra = ranks(a), rb = ranks(b), n = a.length;
    return 1 - (6 * ra.reduce((s, x, i) => s + (x - rb[i]) ** 2, 0)) / (n * (n * n - 1));
  }

  /** Each traded token predicted by a fit that never saw it, for each nested variant of the model. */
  function looCheck(traded, asOf) {
    return VARIANTS.map((v) => {
      const pts = fitPoints(traded, asOf, v.priors);
      const miss = pts.map((pt, i) => Math.abs(pt.y - predictLog(fitCurve(pts.filter((_, j) => j !== i), v), pt.x, pt.fam)));
      // The ranking itself, out of sample: Spearman's rho inside each of 8 fixed held-out folds, averaged.
      let rankCorr = 0;
      for (let f = 0; f < 8; f++) {
        const fit = fitCurve(pts.filter((_, j) => j % 8 !== f), v), held = pts.filter((_, j) => j % 8 === f);
        rankCorr += spearman(held.map((pt) => predictLog(fit, pt.x, pt.fam) + pt.prior), held.map((pt) => pt.y + pt.prior)) / 8;
      }
      return {
        rankCorr,
        key: v.key, label: v.label, n: pts.length,
        medianMiss: Math.pow(10, quantile(miss, 0.5)),
        meanLogMiss: miss.reduce((s, m) => s + m, 0) / miss.length,
        within3x: miss.filter((m) => m <= log10(3)).length / miss.length,
      };
    });
  }

  /** 200 seeded refits on resampled traded tokens: P25-P75 of value x one resampled miss (the band), P10-P90 of rank (refits only). */
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

  /** Comparables: same-family traded tokens closest in TVL, among those within 10x of the curve (wilder is often a parent's cap). */
  function nearestPeers(p, traded, k, fit, asOf) {
    const fam = familyOf(p.category), x = log10(p.tvl_usd);
    const typical = traded.filter((t) => Math.abs(log10(t.mcap_usd / impliedValue(t, fit, asOf).value)) <= 1);
    const same = typical.filter((t) => familyOf(t.category) === fam);
    return (same.length >= k ? same : typical)
      .map((t) => ({ t, d: Math.abs(log10(t.tvl_usd) - x) }))
      .sort((u, v) => u.d - v.d || cmp(u.t.slug, v.t.slug))
      .slice(0, k)
      .map(({ t }) => ({ slug: t.slug, name: t.name, tvl_usd: t.tvl_usd, mcap_usd: t.mcap_usd, multiple: t.mcap_usd / t.tvl_usd, implied: Math.round(p.tvl_usd * (t.mcap_usd / t.tvl_usd)) }));
  }

  // -- the farm plan

  function gasOn(chain) {
    return Object.prototype.hasOwnProperty.call(ASSUME.gas, chain) ? ASSUME.gas[chain] : ASSUME.gasDefault;
  }
  /** Chains come by TVL: the cheapest of the top three; ties go to the first. */
  function cheapestChain(chains) {
    let best = chains[0] || 'Ethereum';
    for (const c of chains.slice(0, 3)) if (gasOn(c) < gasOn(best)) best = c;
    return best;
  }
  const holdWeeks = (days) => 6 + Math.round(6 * (1 - Math.min(days === null ? MODEL.unknownDays : days, 730) / 730));
  const stopDropPct = (change7d) => (change7d === null ? 20 : clamp(Math.round(2 * Math.abs(change7d)), 10, 35));
  const roundDeposit = (x) => (x < 1000 ? Math.round(x / 50) * 50 : Math.round(x / 100) * 100);

  // Chain labels a reader could take for a company.
  const CHAIN_NAME = { Binance: 'BNB Chain', Ripple: 'XRP Ledger', xDai: 'Gnosis' };
  const chainName = (c) => CHAIN_NAME[c] || c;
  // Chains with no dollar stablecoin, and staking, use the native coin.
  const NATIVE_COIN = { Bitcoin: 'BTC', CORE: 'BTC', BSquared: 'BTC', Mezo: 'BTC', 'Babylon Genesis': 'BTC', Stacks: 'BTC', RSK: 'BTC', Bittensor: 'TAO', Qubic: 'QUBIC' };
  function fundingAsset(p, chain) {
    if (/BTC$/.test(p.category || '')) return 'BTC';
    if (familyOf(p.category) === 'stake') return NATIVE_COIN[chain] || `${chainName(chain)}'s native coin`;
    return NATIVE_COIN[chain] || 'USDC';
  }
  const STABLES = 'Dual-Token Stablecoin|Stablecoin Wrapper|Algo-Stables|Stablecoin Issuer|Reserve Currency'.split('|');

  /** The deposit action by category: text, minutes, exit wait, extra cost. */
  function depositAction(p, deposit, chain, asset, exitDay) {
    const c = p.category || '', fam = familyOf(c), d = `${usd(deposit)} of ${asset}`, n = p.name, on = `on ${chainName(chain)}`, swap = deposit * 0.0005;
    const act = (text, minutes, wait, extra = 0, flag = {}) => Object.assign({ text, minutes, wait, extra }, flag);
    if (c === 'Dexs') return asset === 'USDC'
      ? act(`Add ${d} to ${n}'s deepest stablecoin pool ${on} (USDC with another dollar stablecoin); if it takes no outside liquidity, skip it.`, 15, 'usually no lock; check the app', swap)
      : act(`Add ${d} to ${n}'s deepest ${asset} pool ${on}; the position keeps ${asset}'s price risk.`, 15, 'pool exits can take a day', swap);
    if (c === 'Derivatives' || c === 'Options') return act(`Deposit ${d} into ${n}'s liquidity vault ${on}; it takes the other side of traders and can lose in sharp moves.`, 15, 'vault lockups often run 1 to 4 days');
    if (c === 'Prediction Market' || c === 'OTC Marketplace') return act(`Fund ${n} ${on} with ${d}; post only resting quotes, as a filled quote is a position with the market's risk.`, 15, 'usually no lock; check the app', 0, { terms: true });
    if (c === 'Chain') return act(`On ${n}, put ${d} into the largest app DefiLlama lists for the chain; if none, holding the bridged ${asset} is the position.`, 25, 'the bridge back can take 7 days');
    if (c === 'Payments') return act(`Open a payment channel of ${d} on ${n} with a well-connected node and keep it open.`, 30, 'a channel close settles on-chain in about an hour');
    if (c === 'Insurance') return act(`Provide ${d} of cover capital to ${n}'s pool ${on}; a paid claim can draw it down.`, 20, 'cover pools often hold capital 7 to 30 days');
    if (c === 'CDP') return act(`Swap ${d} for ${n}'s stablecoin ${on} (it can trade below $1) into its savings pool; open no vault, mint nothing.`, 15, 'savings pools usually exit at once', swap);
    if (c === 'Collateral Markets') return act(`Deposit ${d} into ${n}'s largest vault that takes it ${on}; read the vault's withdrawal epoch first.`, 20, 'exits wait for the vault epoch, often 7 days');
    if (c === 'Governance Incentives') return act(`Deposit ${d} into ${n}'s earn vault ${on}; take a vote-escrow lock only if it ends before day ${exitDay}.`, 15, 'locks must end before the exit');
    if (fam === 'lend' && c !== 'CDP Manager') return act(`Supply ${d} to ${n}'s main market ${on} and do not borrow against it.`, 10, 'waits only if the market is fully borrowed');
    if (STABLES.includes(c)) return act(`Mint ${n}'s stable token with ${d} (the stable side, never its volatile token) and hold it in its savings vault ${on}.`, 15, 'redeeming to USDC usually settles at once', swap);
    if (fam === 'rwa') return act(`Put ${d} into ${n}'s main yield fund ${on}, after checking its minimum; if it only sells single property or other tokens, skip it.`, 20, 'redemptions often settle in 1 to 5 business days', 0, { kyc: true });
    if (fam === 'stake') return act(`Stake the ${d} through ${n}.`, 15, 'unbonding follows the chain, often 7 to 21 days', 0, { unbond: true });
    if (fam === 'vault' || c === 'CDP Manager') return act(`Deposit ${d} into ${n}'s largest ${asset} vault ${on}; read its withdrawal delay before you sign.`, 15, 'vault queues can hold a withdrawal 1 to 7 days');
    return act(`Deposit ${d} into ${n} ${on} through its own app.`, 15, 'check the app for a lock');
  }

  /**
   * A costed timeline from the protocol's own record (chains, TVL, value, 7-day change, seasoning). Break-even
   * odds = the launch chance at which the slice pays the costs; we never guess that chance.
   */
  function farmPlan(p, value, asOf) {
    const days = daysSince(p.listed_at, asOf);
    const chain = cheapestChain(p.chains), cn = chainName(chain);
    const gas = gasOn(chain);
    const weeks = holdWeeks(days), exitDay = weeks * 7;
    const slicePerDollar = (ASSUME.airdropShare * value) / p.tvl_usd;
    const asset = fundingAsset(p, chain);
    const bridge = asset === 'USDC' ? ASSUME.bridgeFee : 0; // a native coin is one you already hold there: no bridge, no buying
    const deposit = clamp(roundDeposit(Math.max(p.tvl_usd * ASSUME.depositPerTvl, (3 * (8 * gas + 2 * bridge)) / slicePerDollar)), ASSUME.depositMin, ASSUME.depositMax);
    const drop = stopDropPct(p.change_7d);
    const stopTvl = p.tvl_usd * (1 - drop / 100);
    const act = depositAction(p, deposit, chain, asset, exitDay);
    const d0 = act.kyc ? 3 : 0;
    const steps = [
      { day: 0, kind: 'verify', text: `Open ${p.name} from its DefiLlama listing, bookmark that domain, and read its docs on rewards and withdrawals.`, cost: 0, minutes: 20 },
      act.kyc && { day: 0, kind: 'kyc', text: `Pass ${p.name}'s KYC if it asks for one; allow 1 to 3 days before you deposit.`, cost: 0, minutes: 30 },
      act.terms && { day: 0, kind: 'terms', text: `Confirm ${p.name}'s terms allow users in your country; if not, stop here.`, cost: 0, minutes: 10 },
      { day: d0, kind: 'fund', text: bridge ? `Move ${usd(deposit)} of ${asset} and about ${usd(10 * gas)} of gas to your one wallet on ${cn}${p.chains.length > 1 ? `, the cheapest of its top ${Math.min(3, p.chains.length)} chains by TVL` : ''}.` : `Use ${usd(deposit)} of ${asset} you already hold (do not buy it for this), plus ${usd(10 * gas)} of gas, in your one wallet on ${cn}; it keeps ${asset}'s price risk.`, cost: bridge + gas, minutes: 15 },
      { day: d0, kind: 'deposit', text: act.text, cost: 2 * gas + act.extra, minutes: act.minutes },
      { day: d0 + 1, kind: 'record', text: `Check the ${usd(deposit)} position shows in ${p.name}'s app on ${cn}; log the transaction hash, date and amount.`, cost: 0, minutes: 5 },
      { day: 7, kind: 'watch', text: `Every week, check its TVL on DefiLlama against the stop level ${usd(stopTvl)} (${drop}% under today's ${usd(p.tvl_usd)}).`, cost: 0, minutes: 5 * weeks, every: 7 },
      { day: Math.round(exitDay / 2), kind: 'recheck', text: `Midway, re-read the rewards page; do any qualifying action it names once (a lock only if it ends by day ${exitDay}).`, cost: gas, minutes: 10 },
      { day: null, kind: 'stop', text: `Stop rule: if TVL closes below ${usd(stopTvl)} or withdrawals pause, withdraw at once and end the plan.`, cost: gas + bridge, minutes: 15 },
      act.unbond && { day: exitDay - 14, kind: 'unbond', text: `Start unbonding on day ${exitDay - 14} so the coin is free by day ${exitDay}.`, cost: gas, minutes: 10 },
      { day: exitDay, kind: 'exit', text: `After ${weeks} weeks, withdraw the ${usd(deposit)} (${act.wait})${bridge ? ` and move it back off ${cn}` : ''}.`, cost: gas + bridge, minutes: 15 },
      { day: exitDay, kind: 'claim', text: `If a token launches during or after the hold, claim only through the domain bookmarked on day 0, never through a link sent to you.`, cost: gas, minutes: 10 },
    ].filter(Boolean);
    // The stop step replaces the exit when it fires, so it is not added to the totals.
    const counted = steps.filter((s) => s.kind !== 'stop');
    const costs = counted.reduce((sum, s) => sum + s.cost, 0);
    const minutes = counted.reduce((sum, s) => sum + s.minutes, 0);
    // The capital's cost: T-bill income forgone, less what the deposit itself is assumed to earn.
    const carry = Math.max(0, ASSUME.tbillRate - (ASSUME.depositYield[familyOf(p.category)] || 0));
    const capitalCost = (deposit * carry * exitDay) / 365;
    const slice = slicePerDollar * deposit;
    const net = slice - costs - capitalCost;
    const breakEven = (costs + capitalCost) / slice;
    const odds = Math.round(breakEven * 100); // the verdict reads the odds as shown
    const byOdds = odds <= ASSUME.farmOdds * 100 ? 'farm' : odds <= ASSUME.marginalOdds * 100 ? 'marginal' : 'skip';
    const capped = byOdds === 'farm' && p.change_7d < ASSUME.capDrop; // null (no 7-day figure) never caps
    const verdict = capped ? 'marginal' : byOdds;
    return { chain: cn, gas, asset, deposit, weeks, drop, stopTvl, steps, costs, minutes, carry, capitalCost, slice, net, breakEven, verdict, capped, perHour: net / (minutes / 60) };
  }

  const VERDICT_LABEL = { farm: 'Worth farming', marginal: 'Marginal', skip: 'Skip' };

  /** What the break-even odds mean for this plan. */
  function oddsText(plan, value) {
    return plan.breakEven > 1 ? `no launch chance covers it (it would need a launch worth ${usd(value * plan.breakEven)})` : `the chance a token launches, with a snapshot, inside the ${plan.weeks}-week hold`;
  }

  // -- the whole board

  /** The whole board from the snapshot alone. */
  function buildRadar(snap) {
    const u = selectUniverse(snap);
    const fit = fitCurve(fitPoints(u.traded, snap.as_of, true), FULL);
    const scored = u.ranked.map((r) => ({ r, iv: impliedValue(r.p, fit, snap.as_of) }));
    scored.sort((x, y) => y.iv.value - x.iv.value || cmp(x.r.p.slug, y.r.p.slug));
    const boot = bootstrapRanks(u.traded, scored.map((s) => s.r.p), snap.as_of, MODEL.bootstrapRuns, MODEL.seed);
    const rows = scored.map((s, i) => ({
      rank: i + 1, p: s.r.p, watch: s.r.watch, note: s.r.note, iv: s.iv, band: boot[i],
      peers: nearestPeers(s.r.p, u.traded, 3, fit, snap.as_of), plan: farmPlan(s.r.p, s.iv.value, snap.as_of),
    }));
    // Ranks the two priors move: each row's rank with them against without.
    const plain = scored.map((s, i) => [s.iv.value / (s.iv.growth * s.iv.season), i]).sort((x, y) => y[0] - x[0] || x[1] - y[1]);
    const moved = (n) => plain.filter(([, i], k) => Math.abs(k - i) >= n).length;
    return { universe: u, fit, rows, loo: looCheck(u.traded, snap.as_of), moves: { five: moved(5), ten: moved(10) } };
  }

  const api = {
    MODEL, ASSUME, FAMILY_LABEL, VERDICT_LABEL, VARIANTS,
    usd, quantile, mulberry32, daysSince, familyOf, tokenStatus, nameStem, selectUniverse,
    growthTilt, seasonTilt, fitPoints, fitCurve, predictLog, impliedValue, looCheck, bootstrapRanks,
    nearestPeers, cheapestChain, gasOn, chainName, farmPlan, oddsText, buildRadar,
  };
  root.Launchscope = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
