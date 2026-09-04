import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

function market(overrides: Record<string, unknown> = {}) {
  return {
    question: 'Will X happen?',
    slug: 'will-x-happen',
    conditionId: '0xabc',
    outcomes: JSON.stringify(['Yes', 'No']),
    outcomePrices: JSON.stringify(['0.42', '0.58']),
    clobTokenIds: JSON.stringify(['111', '222']),
    volumeNum: 1_000_000,
    liquidityNum: 50_000,
    endDate: '2026-12-01T00:00:00Z',
    closed: false,
    active: true,
    acceptingOrders: true,
    enableOrderBook: true,
    negRisk: false,
    orderPriceMinTickSize: 0.01,
    ...overrides,
  };
}

function stubGamma(markets: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify(markets), { status: 200, headers: { 'content-type': 'application/json' } })));
}

async function load() {
  vi.resetModules();
  return import('@/lib/providers/polymarket');
}

afterEach(() => vi.unstubAllGlobals());

describe('findMarkets', () => {
  it('parses the JSON-encoded string arrays Gamma returns', async () => {
    // outcomes, outcomePrices and clobTokenIds arrive as strings, not arrays.
    stubGamma([market()]);
    const { findMarkets } = await load();
    const [m] = await findMarkets();

    assert.equal(m?.outcomes.length, 2);
    assert.equal(m?.outcomes[0]?.name, 'Yes');
    assert.equal(m?.outcomes[0]?.price, 0.42);
    assert.equal(m?.outcomes[0]?.tokenId, '111');
  });

  it('drops closed and inactive markets', async () => {
    stubGamma([market({ closed: true }), market({ active: false }), market({ question: 'Live?' })]);
    const { findMarkets } = await load();
    const found = await findMarkets();

    assert.equal(found.length, 1);
    assert.equal(found[0]?.question, 'Live?');
  });

  it('reports whether a market is actually tradeable, not merely listed', async () => {
    // "active" means listed; orders can still be paused.
    stubGamma([market({ acceptingOrders: false })]);
    const { findMarkets } = await load();
    assert.equal((await findMarkets())[0]?.isAcceptingOrders, false);
  });

  it('surfaces the neg-risk flag, which selects a different exchange', async () => {
    stubGamma([market({ negRisk: true })]);
    const { findMarkets } = await load();
    assert.equal((await findMarkets())[0]?.isNegRisk, true);
  });

  it('skips malformed rows rather than rendering broken odds', async () => {
    stubGamma([
      market({ outcomePrices: JSON.stringify(['not-a-number', '0.5']) }),
      market({ outcomes: 'garbage' }),
      market({ question: 'Good' }),
    ]);
    const { findMarkets } = await load();
    const found = await findMarkets();

    assert.equal(found.length, 1);
    assert.equal(found[0]?.question, 'Good');
  });

  it('builds a link back to the market', async () => {
    stubGamma([market()]);
    const { findMarkets } = await load();
    assert.equal((await findMarkets())[0]?.url, 'https://polymarket.com/market/will-x-happen');
  });

  it('filters by keyword when a topic is given', async () => {
    stubGamma([market({ question: 'Will the Fed cut rates?' }), market({ question: 'Who wins the election?' })]);
    const { searchMarkets } = await load();
    const found = await searchMarkets('election');

    assert.equal(found.length, 1);
    assert.ok(found[0]?.question.includes('election'));
  });
});
