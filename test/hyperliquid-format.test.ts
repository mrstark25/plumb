import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  marketablePrice, roundPerpPrice, roundPerpSize, toWireNumber,
} from '@/lib/providers/hyperliquid-format';

describe('roundPerpPrice', () => {
  it('caps at five significant figures', () => {
    // BTC has szDecimals 5, so decimals are also capped at 1.
    assert.equal(roundPerpPrice(79120.567, 5), 79121);
    assert.equal(roundPerpPrice(2479.2567, 4), 2479.3);
  });

  it('allows an integer price even beyond five significant figures', () => {
    // 100000 is six figures and still valid; cutting it would move the price.
    assert.equal(roundPerpPrice(100000, 5), 100000);
    assert.equal(roundPerpPrice(123456, 4), 123456);
  });

  it('respects the per-asset decimal cap', () => {
    // szDecimals 4 leaves 2 decimal places (6 - 4).
    assert.equal(roundPerpPrice(1.23456, 4), 1.23);
    // szDecimals 1 leaves 5, but five significant figures binds first.
    assert.equal(roundPerpPrice(1.234567, 1), 1.2346);
  });

  it('refuses a nonsensical price rather than sending it', () => {
    assert.throws(() => roundPerpPrice(0, 5), /Invalid price/);
    assert.throws(() => roundPerpPrice(-1, 5), /Invalid price/);
    assert.throws(() => roundPerpPrice(Number.NaN, 5), /Invalid price/);
  });
});

describe('roundPerpSize', () => {
  it('rounds to the asset decimals', () => {
    assert.equal(roundPerpSize(0.123456789, 5), 0.12345);
    assert.equal(roundPerpSize(1.98765, 2), 1.98);
  });

  it('rounds down, never up', () => {
    // Rounding up could size a position larger than the margin backing it.
    assert.equal(roundPerpSize(0.999999, 2), 0.99);
    assert.equal(roundPerpSize(5.6, 0), 5);
  });

  it('refuses a non-positive size', () => {
    assert.throws(() => roundPerpSize(0, 2), /Invalid size/);
    assert.throws(() => roundPerpSize(-3, 2), /Invalid size/);
  });
});

describe('toWireNumber', () => {
  it('never emits exponent notation', () => {
    assert.equal(toWireNumber(0.00001), '0.00001');
    assert.ok(!toWireNumber(0.00000001).includes('e'));
  });

  it('strips trailing zeros', () => {
    assert.equal(toWireNumber(1.5), '1.5');
    assert.equal(toWireNumber(2479.3), '2479.3');
  });

  it('keeps integers integral', () => {
    assert.equal(toWireNumber(79121), '79121');
    assert.equal(toWireNumber(40), '40');
  });
});

describe('marketablePrice', () => {
  it('prices a buy above the mid so it crosses the book', () => {
    const price = marketablePrice({ midPrice: 2479.25, isBuy: true, slippageBps: 50, szDecimals: 4 });
    assert.ok(price > 2479.25, `expected above mid, got ${price}`);
    assert.ok(price < 2479.25 * 1.01);
  });

  it('prices a sell below the mid', () => {
    const price = marketablePrice({ midPrice: 2479.25, isBuy: false, slippageBps: 50, szDecimals: 4 });
    assert.ok(price < 2479.25, `expected below mid, got ${price}`);
  });

  it('bounds how far through the book it will reach', () => {
    // The slippage cap is what stops "fills immediately" becoming "at any price".
    const wide = marketablePrice({ midPrice: 100, isBuy: true, slippageBps: 100, szDecimals: 4 });
    assert.ok(wide <= 101.01, `slippage bound exceeded: ${wide}`);
  });

  it('returns a tick-valid price', () => {
    const price = marketablePrice({ midPrice: 79120.5, isBuy: true, slippageBps: 50, szDecimals: 5 });
    assert.equal(price, roundPerpPrice(price, 5), 'must already be on a valid tick');
  });
});
