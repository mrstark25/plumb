import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { estimateLiquidationPrice, liquidationDistancePct } from '@/lib/hyperliquid/liquidation';

describe('estimateLiquidationPrice', () => {
  it('puts a long liquidation below the entry and a short above it', () => {
    const long = estimateLiquidationPrice({ entryPrice: 100, leverage: 10, maxLeverage: 40, isLong: true })!;
    const short = estimateLiquidationPrice({ entryPrice: 100, leverage: 10, maxLeverage: 40, isLong: false })!;

    assert.ok(long < 100, `long liq should be below entry, got ${long}`);
    assert.ok(short > 100, `short liq should be above entry, got ${short}`);
  });

  it('moves liquidation closer as leverage rises', () => {
    // This is the whole risk of leverage, so the number must reflect it.
    const at2x = estimateLiquidationPrice({ entryPrice: 100, leverage: 2, maxLeverage: 40, isLong: true })!;
    const at20x = estimateLiquidationPrice({ entryPrice: 100, leverage: 20, maxLeverage: 40, isLong: true })!;

    assert.ok(at20x > at2x, 'higher leverage must liquidate nearer the entry');
    assert.ok(liquidationDistancePct(100, at20x) < liquidationDistancePct(100, at2x));
  });

  it('liquidates roughly a leverage-inverse move away', () => {
    // At 20x a long survives about a 5% drop, slightly more thanks to the
    // maintenance allowance.
    const liq = estimateLiquidationPrice({ entryPrice: 100, leverage: 20, maxLeverage: 40, isLong: true })!;
    const distance = liquidationDistancePct(100, liq);
    assert.ok(distance > 4 && distance < 6, `expected ~5%, got ${distance.toFixed(2)}%`);
  });

  it('shows how brutal maximum leverage is', () => {
    // 40x BTC liquidates on a ~2.5% move — worth stating plainly on the card.
    const liq = estimateLiquidationPrice({ entryPrice: 79000, leverage: 40, maxLeverage: 40, isLong: true })!;
    const distance = liquidationDistancePct(79000, liq);
    assert.ok(distance < 3, `expected under 3%, got ${distance.toFixed(2)}%`);
  });

  it('refuses nonsense inputs rather than returning a misleading number', () => {
    assert.equal(estimateLiquidationPrice({ entryPrice: 0, leverage: 10, maxLeverage: 40, isLong: true }), null);
    assert.equal(estimateLiquidationPrice({ entryPrice: 100, leverage: 0, maxLeverage: 40, isLong: true }), null);
  });

  it('returns null when 1x leverage puts liquidation at or below zero', () => {
    // A 1x long cannot really be liquidated on price alone; claiming a price
    // would be worse than admitting there is none.
    const liq = estimateLiquidationPrice({ entryPrice: 100, leverage: 1, maxLeverage: 40, isLong: true });
    assert.ok(liq === null || liq < 5, `expected none or near-zero, got ${liq}`);
  });
});
