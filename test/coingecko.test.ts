import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { knownPriceSymbols, resolveCoinId } from '@/lib/providers/coingecko';

afterEach(() => vi.unstubAllGlobals());

describe('resolveCoinId', () => {
  it('maps common tickers to CoinGecko ids', () => {
    assert.equal(resolveCoinId('BTC'), 'bitcoin');
    assert.equal(resolveCoinId('ETH'), 'ethereum');
    assert.equal(resolveCoinId('USDC'), 'usd-coin');
  });

  it('is case and whitespace insensitive', () => {
    assert.equal(resolveCoinId('  eth '), 'ethereum');
    assert.equal(resolveCoinId('Btc'), 'bitcoin');
  });

  it('refuses an unknown ticker rather than guessing an id', () => {
    // Dozens of tokens share a ticker. Searching for one would happily return
    // a scam coin's price for a legitimate symbol.
    assert.equal(resolveCoinId('NOTAREALCOIN'), undefined);
    assert.equal(resolveCoinId(''), undefined);
  });

  it('publishes the list it can price, for the error message', () => {
    const symbols = knownPriceSymbols();
    assert.ok(symbols.includes('BTC'));
    assert.ok(symbols.includes('MORPHO'));
    assert.ok(symbols.length > 20);
  });
});

describe('getMarketPrices', () => {
  function stubFetch(body: unknown) {
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function load() {
    vi.resetModules();
    return (await import('@/lib/providers/coingecko')).getMarketPrices;
  }

  it('normalises a CoinGecko response', async () => {
    stubFetch({ bitcoin: { usd: 78091, usd_24h_change: 0.5857, usd_market_cap: 1.5e12, last_updated_at: 1788065990 } });
    const getMarketPrices = await load();
    const { prices } = await getMarketPrices(['BTC']);

    assert.equal(prices[0]?.symbol, 'BTC');
    assert.equal(prices[0]?.usd, 78091);
    assert.equal(prices[0]?.change24hPct, 0.5857);
    // Reported in seconds; stored as milliseconds.
    assert.equal(prices[0]?.updatedAt, 1788065990000);
  });

  it('reports unknown symbols instead of dropping them silently', async () => {
    stubFetch({ bitcoin: { usd: 78091 } });
    const getMarketPrices = await load();
    const { prices, unknown } = await getMarketPrices(['BTC', 'MADEUPCOIN']);

    assert.equal(prices.length, 1);
    assert.deepEqual(unknown, ['MADEUPCOIN']);
  });

  it('treats a priced-but-empty entry as unknown, not as zero', async () => {
    // A missing price must never become $0.00 on a card.
    stubFetch({ bitcoin: {} });
    const getMarketPrices = await load();
    const { prices, unknown } = await getMarketPrices(['BTC']);

    assert.equal(prices.length, 0);
    assert.deepEqual(unknown, ['BTC']);
  });

  it('de-duplicates symbols so one asset is not requested twice', async () => {
    const fetchMock = stubFetch({ ethereum: { usd: 2454 } });
    const getMarketPrices = await load();
    const { prices } = await getMarketPrices(['ETH', 'eth', ' ETH ']);

    assert.equal(prices.length, 1);
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  it('makes no network call when nothing resolves', async () => {
    const fetchMock = stubFetch({});
    const getMarketPrices = await load();
    const { prices, unknown } = await getMarketPrices(['NOPE']);

    assert.equal(prices.length, 0);
    assert.deepEqual(unknown, ['NOPE']);
    assert.equal(fetchMock.mock.calls.length, 0, 'should not call the API for an unresolvable symbol');
  });

  it('caches, so a repeat within the window does not spend the rate limit', async () => {
    const fetchMock = stubFetch({ bitcoin: { usd: 78091 } });
    const getMarketPrices = await load();

    await getMarketPrices(['BTC']);
    await getMarketPrices(['BTC']);
    assert.equal(fetchMock.mock.calls.length, 1, 'second call should be served from cache');
  });

  it('requests 24h change and market cap, which the card renders', async () => {
    const fetchMock = stubFetch({ bitcoin: { usd: 1 } });
    const getMarketPrices = await load();
    await getMarketPrices(['BTC']);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    assert.ok(url.includes('include_24hr_change=true'));
    assert.ok(url.includes('include_market_cap=true'));
    assert.ok(url.includes('vs_currencies=usd'));
  });
});

describe('getSpotPrices fallback', () => {
  async function load() {
    vi.resetModules();
    return (await import('@/lib/providers/prices')).getSpotPrices;
  }

  it('uses CoinGecko when it answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      assert.ok(String(url).includes('coingecko.com'));
      return new Response(JSON.stringify({ bitcoin: { usd: 78091, usd_24h_change: 1.2 } }), { status: 200 });
    }));

    const getSpotPrices = await load();
    const result = await getSpotPrices(['BTC']);

    assert.equal(result.source, 'CoinGecko');
    assert.equal(result.prices[0]?.usd, 78091);
    assert.equal(result.prices[0]?.change24hPct, 1.2);
  });

  it('falls back to DefiLlama when CoinGecko rate-limits', async () => {
    // A 429 should slow the answer down, not remove it.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('coingecko.com')) return new Response('rate limited', { status: 429 });
      return new Response(
        JSON.stringify({ coins: { 'coingecko:bitcoin': { price: 78100, timestamp: 1788066350 } } }),
        { status: 200 },
      );
    }));

    const getSpotPrices = await load();
    const result = await getSpotPrices(['BTC']);

    assert.equal(result.source, 'DefiLlama');
    assert.equal(result.prices[0]?.usd, 78100);
    // The fallback has no 24h data, and must say so rather than invent it.
    assert.equal(result.prices[0]?.change24hPct, null);
    assert.equal(result.prices[0]?.marketCapUsd, null);
  });

  it('reports unknown symbols even when both sources are down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })));

    const getSpotPrices = await load();
    const result = await getSpotPrices(['BTC']);

    assert.equal(result.prices.length, 0);
    assert.deepEqual(result.unknown, ['BTC']);
  });

  it('never asks either source about an unresolvable symbol', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const getSpotPrices = await load();
    const result = await getSpotPrices(['NOTACOIN']);

    assert.deepEqual(result.unknown, ['NOTACOIN']);
    assert.equal(fetchMock.mock.calls.length, 0);
  });
});
