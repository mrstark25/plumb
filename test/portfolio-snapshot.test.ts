import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';

/*
 * The orchestration, with every boundary stubbed.
 *
 * What is being tested here is not the reads — those are exercised against the
 * live chain by `npm run smoke` — but what the aggregator does with what comes
 * back: which rows survive, which totals they feed, and whether one failing
 * source takes the rest of the portfolio down with it.
 */
const readBalance = vi.fn();
const getMarketPrices = vi.fn();
const getUsdPrice = vi.fn();
const readAllAaveAccounts = vi.fn();
const readAllMorphoPositions = vi.fn();
const readSkyPosition = vi.fn();

vi.mock('@/lib/erc20', () => ({ readBalance: (...args: unknown[]) => readBalance(...args) }));
vi.mock('@/lib/providers/coingecko', () => ({
  getMarketPrices: (...args: unknown[]) => getMarketPrices(...args),
}));
vi.mock('@/lib/providers/prices', () => ({
  getUsdPrice: (...args: unknown[]) => getUsdPrice(...args),
}));
vi.mock('@/lib/providers/aave', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers/aave')>()),
  readAllAaveAccounts: (...args: unknown[]) => readAllAaveAccounts(...args),
}));
vi.mock('@/lib/providers/morpho-positions', () => ({
  readAllMorphoPositions: (...args: unknown[]) => readAllMorphoPositions(...args),
}));
vi.mock('@/lib/providers/sky', () => ({
  readSkyPosition: (...args: unknown[]) => readSkyPosition(...args),
}));

const { readPortfolioSnapshot } = await import('@/lib/portfolio/snapshot');

const WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as const;

/** One USDC on Base and nothing else, unless a test says otherwise. */
function onlyBaseUsdc(usd = 1) {
  readBalance.mockImplementation(async ({ chainId, token }: { chainId: number; token: string }) =>
    chainId === 8453 && token.toLowerCase().startsWith('0x833589') ? 1_000_000n : 0n,
  );
  getMarketPrices.mockResolvedValue({
    prices: [{ symbol: 'USDC', id: 'usd-coin', usd, change24hPct: 0, marketCapUsd: null, updatedAt: null }],
    unknown: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  readBalance.mockResolvedValue(0n);
  getMarketPrices.mockResolvedValue({ prices: [], unknown: [] });
  getUsdPrice.mockResolvedValue(undefined);
  readAllAaveAccounts.mockResolvedValue([]);
  readAllMorphoPositions.mockResolvedValue([]);
  readSkyPosition.mockResolvedValue(null);
});

describe('readPortfolioSnapshot', () => {
  it('returns an empty snapshot rather than throwing for an unused address', async () => {
    const snapshot = await readPortfolioSnapshot(WALLET);

    assert.deepEqual(snapshot.holdings, []);
    assert.deepEqual(snapshot.positions, []);
    assert.equal(snapshot.totals.netWorthUsd, 0);
    assert.equal(snapshot.hasCostBasis, false);
  });

  it('never claims a cost basis', async () => {
    // Typed as the literal `false`, so a future change here fails to compile
    // rather than quietly enabling a PnL figure with nothing behind it.
    const snapshot = await readPortfolioSnapshot(WALLET);

    assert.equal(snapshot.hasCostBasis, false);
  });

  it('drops dust positions from the table and from the totals alike', async () => {
    onlyBaseUsdc();
    readAllMorphoPositions.mockResolvedValue([
      { chainId: 8453, vault: WALLET, name: 'Real', shares: 1n, assets: 1n, assetSymbol: 'USDC', decimals: 6, assetsUsd: 500, apyPct: 4 },
      { chainId: 8453, vault: WALLET, name: 'Dust', shares: 1n, assets: 1n, assetSymbol: 'USDC', decimals: 6, assetsUsd: 0.0001, apyPct: 4 },
    ]);

    const snapshot = await readPortfolioSnapshot(WALLET);

    assert.equal(snapshot.positions.length, 1);
    assert.equal(snapshot.positions[0]?.name, 'Real');
    assert.equal(snapshot.totals.dustCount, 1);
    // The hidden row must not still be inside the total it was hidden from.
    assert.equal(snapshot.totals.earningUsd, 500);
  });

  it('keeps an unpriced holding, which is not the same as dust', async () => {
    readBalance.mockImplementation(async ({ chainId }: { chainId: number }) =>
      chainId === 8453 ? 1_000_000n : 0n,
    );
    getMarketPrices.mockResolvedValue({ prices: [], unknown: ['USDC'] });
    getUsdPrice.mockResolvedValue(undefined);

    const snapshot = await readPortfolioSnapshot(WALLET);

    assert.ok(snapshot.holdings.length > 0, 'unpriced holdings must survive');
    assert.equal(snapshot.totals.dustCount, 0);
    assert.ok(snapshot.totals.unpricedCount > 0);
  });

  it('survives a protocol that is down', async () => {
    onlyBaseUsdc();
    readAllMorphoPositions.mockRejectedValue(new Error('indexer unavailable'));
    readSkyPosition.mockRejectedValue(new Error('rpc unavailable'));
    readAllAaveAccounts.mockRejectedValue(new Error('rpc unavailable'));

    const snapshot = await readPortfolioSnapshot(WALLET);

    // The wallet half still renders. A portfolio missing one protocol is
    // useful; one that renders nothing because an indexer blinked is not.
    assert.equal(snapshot.holdings.length, 1);
    assert.equal(snapshot.positions.length, 0);
    assert.equal(snapshot.totals.walletUsd, 1);
  });

  it('falls back to contract-level pricing when the market call misses', async () => {
    readBalance.mockImplementation(async ({ chainId }: { chainId: number }) =>
      chainId === 8453 ? 1_000_000n : 0n,
    );
    getMarketPrices.mockResolvedValue({ prices: [], unknown: ['USDC'] });
    getUsdPrice.mockResolvedValue(2);

    const snapshot = await readPortfolioSnapshot(WALLET);

    assert.ok(snapshot.totals.walletUsd > 0);
    assert.ok(getUsdPrice.mock.calls.length > 0);
  });

  it('folds Aave collateral and debt into net worth', async () => {
    onlyBaseUsdc();
    readAllAaveAccounts.mockResolvedValue([
      { chainId: 1, suppliedUsd: 1000, borrowedUsd: 250, netUsd: 750, healthFactor: 2.5, ltvPct: 70, liquidationThresholdPct: 80 },
    ]);

    const snapshot = await readPortfolioSnapshot(WALLET);

    assert.equal(snapshot.totals.suppliedUsd, 1000);
    assert.equal(snapshot.totals.borrowedUsd, 250);
    assert.equal(snapshot.totals.netWorthUsd, 1 + 750);
  });

  it('carries a Sky savings position through as an earning row', async () => {
    onlyBaseUsdc();
    readSkyPosition.mockResolvedValue({
      chainId: 1,
      vault: WALLET,
      shares: 10n ** 18n,
      assets: 100n * 10n ** 18n,
      assetSymbol: 'USDS',
      decimals: 18,
      apyPct: 3.5,
    });

    const snapshot = await readPortfolioSnapshot(WALLET);
    const sky = snapshot.positions.find((position) => position.protocol === 'Sky');

    assert.ok(sky, 'expected a Sky position');
    assert.equal(sky.usd, 100);
    // 3.5% of $100 over a year.
    assert.ok(Math.abs((sky.projectedYearlyUsd ?? 0) - 3.5) < 1e-9);
  });
});
