import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';

const getFiatPrice = vi.fn();
vi.mock('@/lib/providers/coingecko', () => ({
  getFiatPrice: (...args: unknown[]) => getFiatPrice(...args),
}));

const { planFunding, withLiveRate, formatRate } = await import('@/lib/agent/handlers/funding');

beforeEach(() => {
  vi.clearAllMocks();
  getFiatPrice.mockResolvedValue(undefined);
});

describe('withLiveRate', () => {
  it('attaches the live rate and converts the amount', async () => {
    // The real figure, checked against CoinGecko while writing this.
    getFiatPrice.mockResolvedValue(94.6);
    const plan = await withLiveRate(planFunding({ currency: 'inr', amount: '5000' }));

    assert.equal(plan.rate, 94.6);
    assert.ok(plan.estimate !== null);
    // 5000 / 94.6 ≈ 52.85 USDC — not 5000/83 ≈ 60.2, which is what a
    // remembered rate produced and why this exists.
    assert.ok(Math.abs(plan.estimate - 52.854) < 0.01, `got ${plan.estimate}`);
  });

  it('leaves the rate null when the source has no answer', async () => {
    // Null, never a dollar-converted approximation. Ten of the currencies the
    // on-ramp accepts cannot be priced, and a made-up rate is the bug.
    getFiatPrice.mockResolvedValue(undefined);
    const plan = await withLiveRate(planFunding({ currency: 'inr', amount: '5000' }));

    assert.equal(plan.rate, null);
    assert.equal(plan.estimate, null);
  });

  it('survives the price source failing outright', async () => {
    getFiatPrice.mockRejectedValue(new Error('429'));
    const plan = await withLiveRate(planFunding({ currency: 'inr' }));

    assert.equal(plan.rate, null);
  });

  it('does not call out at all when no currency was named', async () => {
    const plan = await withLiveRate(planFunding({}));

    assert.equal(plan.rate, null);
    assert.equal(getFiatPrice.mock.calls.length, 0);
  });

  it('gives no estimate without an amount', async () => {
    getFiatPrice.mockResolvedValue(94.6);
    const plan = await withLiveRate(planFunding({ currency: 'inr' }));

    assert.equal(plan.rate, 94.6);
    assert.equal(plan.estimate, null);
  });
});

describe('formatRate', () => {
  it('renders money to two places with separators', () => {
    assert.equal(formatRate(94.6), '94.60');
    assert.equal(formatRate(155.8231), '155.82');
    assert.equal(formatRate(1234567.891), '1,234,567.89');
  });
});
