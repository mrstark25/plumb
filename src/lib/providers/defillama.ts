import { createTtlCache, requestJson } from './http';

const POOLS_URL = 'https://yields.llama.fi/pools';

/** DefiLlama edge-caches /pools for ~30 min, so polling faster than this gains nothing. */
const CACHE_TTL_MS = 20 * 60 * 1000;

/** Raw pool shape. Every key is present on every pool; absence is expressed as null. */
interface RawPool {
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number;
  apyPct30D: number | null;
  pool: string;
  poolMeta: string | null;
  stablecoin: boolean;
  ilRisk: 'no' | 'yes';
  exposure: 'single' | 'multi';
  outlier: boolean;
  sigma: number;
  predictions: {
    predictedClass: 'Stable/Up' | 'Down' | null;
    predictedProbability: number | null;
    binnedConfidence: 1 | 2 | 3 | null;
  };
}

export interface YieldOpportunity {
  readonly id: string;
  readonly project: string;
  readonly chain: string;
  readonly symbol: string;
  /** Percent, e.g. 4.19 means 4.19%. */
  readonly apy: number;
  readonly apyBase: number | null;
  readonly apyReward: number | null;
  readonly apyMean30d: number;
  readonly tvlUsd: number;
  readonly isStablecoin: boolean;
  readonly ilRisk: 'no' | 'yes';
  readonly exposure: 'single' | 'multi';
  readonly outlook: string | null;
  readonly riskNotes: readonly string[];
  /** Naive linear projection for a stated principal; not compounded. */
  readonly projectedYearlyUsd?: number;
}

export interface YieldQuery {
  readonly amountUsd?: number;
  readonly chains?: readonly string[];
  readonly stablecoinsOnly?: boolean;
  readonly minTvlUsd?: number;
  readonly maxApy?: number;
  readonly symbol?: string;
  readonly limit?: number;
}

const loadPools = createTtlCache<RawPool[]>(CACHE_TTL_MS);

async function fetchPools(): Promise<RawPool[]> {
  return loadPools(async () => {
    const body = await requestJson<{ status: string; data: RawPool[] }>(POOLS_URL, {
      provider: 'DefiLlama',
      timeoutMs: 25_000,
    });
    return body.data ?? [];
  });
}

/**
 * Defaults are deliberately conservative. Unfiltered, the top of this list is
 * always sub-$100k pools printing four-digit APYs that no one can actually
 * enter — surfacing those as "best yield" would be actively misleading.
 */
const DEFAULT_MIN_TVL_USD = 1_000_000;
const DEFAULT_MAX_APY = 200;
const DEFAULT_LIMIT = 6;

export async function findYieldOpportunities(query: YieldQuery): Promise<YieldOpportunity[]> {
  const pools = await fetchPools();

  const minTvl = query.minTvlUsd ?? DEFAULT_MIN_TVL_USD;
  const maxApy = query.maxApy ?? DEFAULT_MAX_APY;
  const chains = query.chains?.map((c) => c.toLowerCase());
  const symbol = query.symbol?.toLowerCase();

  const matches = pools.filter((pool) => {
    if (pool.outlier) return false;
    if (pool.tvlUsd < minTvl) return false;
    if (!Number.isFinite(pool.apy) || pool.apy <= 0 || pool.apy > maxApy) return false;
    if (query.stablecoinsOnly && !pool.stablecoin) return false;
    if (chains && !chains.includes(pool.chain.toLowerCase())) return false;
    if (symbol && !pool.symbol.toLowerCase().includes(symbol)) return false;
    return true;
  });

  matches.sort((a, b) => b.apy - a.apy);

  return matches
    .slice(0, query.limit ?? DEFAULT_LIMIT)
    .map((pool) => toOpportunity(pool, query.amountUsd));
}

function toOpportunity(pool: RawPool, amountUsd?: number): YieldOpportunity {
  return {
    id: pool.pool,
    project: pool.project,
    chain: pool.chain,
    symbol: pool.poolMeta ? `${pool.symbol} (${pool.poolMeta})` : pool.symbol,
    apy: pool.apy,
    apyBase: pool.apyBase,
    apyReward: pool.apyReward,
    apyMean30d: pool.apyMean30d,
    tvlUsd: pool.tvlUsd,
    isStablecoin: pool.stablecoin,
    ilRisk: pool.ilRisk,
    exposure: pool.exposure,
    outlook: describeOutlook(pool),
    riskNotes: riskNotesFor(pool),
    ...(amountUsd !== undefined ? { projectedYearlyUsd: amountUsd * (pool.apy / 100) } : {}),
  };
}

function describeOutlook(pool: RawPool): string | null {
  const { predictedClass, predictedProbability } = pool.predictions;
  if (!predictedClass || predictedProbability === null) return null;
  // predictedProbability is 0-100, not a fraction.
  return `${predictedClass} (${Math.round(predictedProbability)}% confidence)`;
}

function riskNotesFor(pool: RawPool): string[] {
  const notes: string[] = [];

  if (pool.ilRisk === 'yes') {
    notes.push('Impermanent loss: the pool holds two assets that can diverge in price.');
  }
  if (pool.apyReward !== null && pool.apyReward > pool.apy * 0.5) {
    notes.push('Most of this APY is incentive rewards, which can be cut at any time.');
  }
  if (pool.apyMean30d > 0 && pool.apy > pool.apyMean30d * 2) {
    notes.push(
      `Current APY (${pool.apy.toFixed(1)}%) is well above its 30-day mean (${pool.apyMean30d.toFixed(1)}%) — likely a spike, not a run rate.`,
    );
  }
  if (pool.sigma > 1) {
    notes.push('Yield has been highly volatile historically.');
  }
  if (pool.tvlUsd < 5_000_000) {
    notes.push('Relatively thin TVL — exiting a large position may move the price.');
  }
  return notes;
}
