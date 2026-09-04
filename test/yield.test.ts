import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

/** A pool shaped exactly like DefiLlama's, overridable per case. */
function pool(overrides: Record<string, unknown> = {}) {
  return {
    chain: 'Base', project: 'aave-v3', symbol: 'USDC',
    tvlUsd: 50_000_000, apy: 6, apyBase: 6, apyReward: null, apyMean30d: 5.8,
    apyPct30D: 0.2, pool: `id-${Math.random()}`, poolMeta: null,
    stablecoin: true, ilRisk: 'no', exposure: 'single', outlier: false, sigma: 0.1,
    predictions: { predictedClass: 'Stable/Up', predictedProbability: 72, binnedConfidence: 2 },
    ...overrides,
  };
}

function mockPools(pools: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ status: 'success', data: pools }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
}

/** The provider memoises for 20 minutes, so each case needs a fresh module. */
async function loadFinder() {
  vi.resetModules();
  return (await import('@/lib/agent/handlers/yield')).findYields;
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('findYields', () => {
  it('ranks by APY and projects returns against the stated principal', async () => {
    mockPools([
      pool({ apy: 4, symbol: 'LOW' }),
      pool({ apy: 12, symbol: 'HIGH' }),
      pool({ apy: 8, symbol: 'MID' }),
    ]);
    const findYields = await loadFinder();
    const { pools } = await findYields({ amountUsd: 1000 });

    assert.deepEqual(pools.map((p) => p.symbol), ['HIGH', 'MID', 'LOW']);
    assert.equal(pools[0]?.projectedYearlyUsd, 120);
  });

  it('drops the unenterable four-digit APY pools that would otherwise top the list', async () => {
    mockPools([pool({ apy: 4000, symbol: 'DEGEN' }), pool({ apy: 6, symbol: 'REAL' })]);
    const findYields = await loadFinder();
    const { pools } = await findYields({ riskTolerance: 'medium' });

    assert.deepEqual(pools.map((p) => p.symbol), ['REAL']);
  });

  it('excludes pools DefiLlama itself marks as outliers', async () => {
    mockPools([pool({ outlier: true, symbol: 'SUSPECT' }), pool({ symbol: 'CLEAN' })]);
    const findYields = await loadFinder();
    const { pools } = await findYields({});

    assert.deepEqual(pools.map((p) => p.symbol), ['CLEAN']);
  });

  it('enforces a TVL floor that tightens as risk tolerance drops', async () => {
    mockPools([pool({ tvlUsd: 2_000_000, symbol: 'SMALL' }), pool({ tvlUsd: 80_000_000, symbol: 'LARGE' })]);

    const cautious = await (await loadFinder())({ riskTolerance: 'low' });
    assert.deepEqual(cautious.pools.map((p) => p.symbol), ['LARGE']);

    mockPools([pool({ tvlUsd: 2_000_000, symbol: 'SMALL' }), pool({ tvlUsd: 80_000_000, symbol: 'LARGE' })]);
    const permissive = await (await loadFinder())({ riskTolerance: 'high' });
    assert.deepEqual(permissive.pools.map((p) => p.symbol).sort(), ['LARGE', 'SMALL']);
  });

  it('filters to stablecoins when the user wants no price exposure', async () => {
    mockPools([pool({ stablecoin: false, symbol: 'ETH-USDC' }), pool({ symbol: 'USDC' })]);
    const findYields = await loadFinder();
    const { pools } = await findYields({ stablecoinsOnly: true });

    assert.deepEqual(pools.map((p) => p.symbol), ['USDC']);
  });

  it('warns when the headline APY is mostly incentives that can be cut', async () => {
    mockPools([pool({ apy: 20, apyBase: 4, apyReward: 16 })]);
    const findYields = await loadFinder();
    const { pools } = await findYields({});

    assert.ok(pools[0]?.riskNotes.some((n) => n.includes('incentive rewards')));
  });

  it('warns when the current rate is a spike well above its 30-day mean', async () => {
    mockPools([pool({ apy: 30, apyMean30d: 5 })]);
    const findYields = await loadFinder();
    const { pools } = await findYields({});

    assert.ok(pools[0]?.riskNotes.some((n) => n.includes('spike, not a run rate')));
  });

  it('warns about impermanent loss on two-sided pools', async () => {
    mockPools([pool({ ilRisk: 'yes', exposure: 'multi', stablecoin: false })]);
    const findYields = await loadFinder();
    const { pools } = await findYields({});

    assert.ok(pools[0]?.riskNotes.some((n) => n.includes('Impermanent loss')));
  });

  it('reads predictedProbability as a percentage, not a fraction', async () => {
    mockPools([pool({ predictions: { predictedClass: 'Down', predictedProbability: 64, binnedConfidence: 2 } })]);
    const findYields = await loadFinder();
    const { pools } = await findYields({});

    assert.equal(pools[0]?.outlook, 'Down (64% confidence)');
  });

  it('builds a title that reflects the filters actually applied', async () => {
    mockPools([pool()]);
    const findYields = await loadFinder();
    const { title } = await findYields({ amountUsd: 1000, stablecoinsOnly: true, asset: 'USDC' });

    assert.equal(title, 'Stablecoin USDC yield opportunities for $1,000');
  });
});
