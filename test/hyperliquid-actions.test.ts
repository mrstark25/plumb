import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  buildApproveBuilderFee, buildMarketOrder, buildUpdateLeverage,
  MAX_BUILDER_FEE_TENTHS_BP, nextNonce,
} from '@/lib/hyperliquid/actions';
import { actionHash } from '@/lib/hyperliquid/sign';

const BTC = { index: 0, name: 'BTC', szDecimals: 5, maxLeverage: 40, isDelisted: false };

describe('buildMarketOrder', () => {
  it('emits an IoC order with a price through the book', () => {
    const action = buildMarketOrder({
      asset: BTC, isBuy: true, size: 0.126, midPrice: 79140.5,
      slippageBps: 500, reduceOnly: false,
    });

    const order = action.orders[0]!;
    assert.equal(order.a, 0, 'asset index');
    assert.equal(order.b, true, 'isBuy');
    assert.deepEqual(order.t, { limit: { tif: 'Ioc' } }, 'market = IoC');
    assert.equal(order.r, false);
    assert.ok(Number(order.p) > 79140.5, 'buy must price above the mid to fill');
  });

  it('prices a sell below the mid', () => {
    const action = buildMarketOrder({
      asset: BTC, isBuy: false, size: 0.1, midPrice: 79140.5,
      slippageBps: 500, reduceOnly: false,
    });
    assert.ok(Number(action.orders[0]!.p) < 79140.5);
  });

  it('sends sizes and prices as strings without trailing zeros', () => {
    // The wire format rejects "100.0"; it must be "100".
    const action = buildMarketOrder({
      asset: BTC, isBuy: true, size: 0.126, midPrice: 79000,
      slippageBps: 500, reduceOnly: false,
    });
    const order = action.orders[0]!;
    assert.equal(typeof order.p, 'string');
    assert.equal(typeof order.s, 'string');
    assert.ok(!order.s.endsWith('0'), `trailing zero in size: ${order.s}`);
  });

  it('omits the builder key entirely when none is configured', () => {
    // An absent key and an empty object hash differently once msgpack-encoded.
    const action = buildMarketOrder({
      asset: BTC, isBuy: true, size: 0.1, midPrice: 79000,
      slippageBps: 500, reduceOnly: false, builder: null,
    });
    assert.ok(!('builder' in action));
  });

  it('lowercases the builder address, which the signature depends on', () => {
    const action = buildMarketOrder({
      asset: BTC, isBuy: true, size: 0.1, midPrice: 79000, slippageBps: 500, reduceOnly: false,
      builder: { address: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01', feeTenthsBp: 10 },
    });
    assert.equal(
      (action as { builder: { b: string } }).builder.b,
      '0xabcdef0123456789abcdef0123456789abcdef01',
    );
  });

  it('refuses a size that rounds away to nothing', () => {
    assert.throws(
      () => buildMarketOrder({
        asset: BTC, isBuy: true, size: 0.000001, midPrice: 79000,
        slippageBps: 500, reduceOnly: false,
      }),
      /rounds to zero/,
    );
  });

  it('produces a stable hash for identical inputs', () => {
    const make = () => buildMarketOrder({
      asset: BTC, isBuy: true, size: 0.1, midPrice: 79000, slippageBps: 500, reduceOnly: false,
    });
    assert.equal(actionHash({ action: make(), nonce: 1 }), actionHash({ action: make(), nonce: 1 }));
  });
});

describe('buildUpdateLeverage', () => {
  it('builds a cross-margin leverage change', () => {
    assert.deepEqual(buildUpdateLeverage({ asset: BTC, leverage: 20, isCross: true }), {
      type: 'updateLeverage', asset: 0, isCross: true, leverage: 20,
    });
  });

  it('refuses leverage beyond what the asset allows', () => {
    assert.throws(() => buildUpdateLeverage({ asset: BTC, leverage: 100, isCross: true }), /1x to 40x/);
    assert.throws(() => buildUpdateLeverage({ asset: BTC, leverage: 0, isCross: true }), /1x to 40x/);
  });
});

describe('buildApproveBuilderFee', () => {
  it('quotes the cap as a percent string and lowercases the builder', () => {
    const action = buildApproveBuilderFee({
      builderAddress: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01',
      maxFeeRate: '0.01%', nonce: 5, isMainnet: true, signatureChainId: '0xa4b1',
    });
    assert.equal(action.maxFeeRate, '0.01%');
    assert.equal(action.builder, '0xabcdef0123456789abcdef0123456789abcdef01');
    assert.equal(action.hyperliquidChain, 'Mainnet');
  });
});

describe('nextNonce', () => {
  it('strictly increases, so two orders in one millisecond cannot collide', () => {
    const nonces = Array.from({ length: 50 }, () => nextNonce());
    for (let i = 1; i < nonces.length; i += 1) {
      assert.ok(nonces[i]! > nonces[i - 1]!, 'nonces must strictly increase');
    }
  });
});

describe('builder fee cap', () => {
  it('matches Hyperliquid perps maximum of 0.1%', () => {
    assert.equal(MAX_BUILDER_FEE_TENTHS_BP, 100);
  });
});
