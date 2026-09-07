import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

const getMarketPrices = vi.fn();
vi.mock('@/lib/providers/coingecko', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers/coingecko')>()),
  getMarketPrices: (...args: unknown[]) => getMarketPrices(...args),
}));

const { getSpotPrices } = await import('@/lib/providers/prices');

const originalFetch = globalThis.fetch;
let calls: string[] = [];

/** Stands in for both DefiLlama endpoints. */
function llama(body: { prices?: Record<string, unknown>; changes?: Record<string, number> }) {
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const isChange = String(url).includes('/percentage/');
    return {
      ok: true,
      status: 200,
      json: async () => ({ coins: isChange ? (body.changes ?? {}) : (body.prices ?? {}) }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  vi.clearAllMocks();
  // Force the fallback path: CoinGecko rate-limited.
  getMarketPrices.mockRejectedValue(new Error('429 Too Many Requests'));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('DefiLlama fallback', () => {
  it('carries 24h movement, not just a price', async () => {
    /*
     * The whole point of this integration. Before it, a CoinGecko 429 returned
     * prices with a null change, which emptied the headline number on the
     * portfolio panel without anything visibly failing.
     */
    llama({
      prices: { 'coingecko:ethereum': { price: 2478.71, confidence: 0.99, timestamp: 1788766920 } },
      changes: { 'coingecko:ethereum': -0.677 },
    });

    const result = await getSpotPrices(['ETH']);

    assert.equal(result.source, 'DefiLlama');
    assert.equal(result.prices[0]?.usd, 2478.71);
    assert.ok(Math.abs((result.prices[0]?.change24hPct ?? 0) + 0.677) < 1e-9);
    assert.ok(calls.some((u) => u.includes('/percentage/')), 'should ask for the change');
  });

  it('rejects a price DefiLlama itself is not confident in', async () => {
    // Its own quality signal. A thin or stale market scores low, and a figure
    // nobody can stand behind is worse than a blank.
    llama({ prices: { 'coingecko:ethereum': { price: 2478.71, confidence: 0.4 } } });

    const result = await getSpotPrices(['ETH']);

    assert.equal(result.prices.length, 0);
    assert.deepEqual(result.unknown, ['ETH']);
  });

  it('accepts a price with no confidence field at all', async () => {
    // Absent is not low; older entries simply omit it.
    llama({ prices: { 'coingecko:ethereum': { price: 2478.71 } } });

    const result = await getSpotPrices(['ETH']);

    assert.equal(result.prices.length, 1);
  });

  it('still returns the price when the change lookup fails', async () => {
    llama({ prices: { 'coingecko:ethereum': { price: 2478.71, confidence: 0.99 } }, changes: {} });

    const result = await getSpotPrices(['ETH']);

    assert.equal(result.prices[0]?.usd, 2478.71);
    assert.equal(result.prices[0]?.change24hPct, null);
  });

  it('never invents a market cap, which DefiLlama does not serve', async () => {
    llama({ prices: { 'coingecko:ethereum': { price: 2478.71, confidence: 0.99 } } });

    const result = await getSpotPrices(['ETH']);

    assert.equal(result.prices[0]?.marketCapUsd, null);
  });

  it('prefers CoinGecko when it answers', async () => {
    getMarketPrices.mockResolvedValue({
      prices: [{ symbol: 'ETH', id: 'ethereum', usd: 2500, change24hPct: 1, marketCapUsd: 3e11, updatedAt: null }],
      unknown: [],
    });

    const result = await getSpotPrices(['ETH']);

    assert.equal(result.source, 'CoinGecko');
    assert.equal(result.prices[0]?.marketCapUsd, 3e11);
    assert.equal(calls.length, 0, 'must not call DefiLlama when CoinGecko answered');
  });
});
