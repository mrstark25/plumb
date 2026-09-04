import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { planFunding, describeFunding, detectFundingIntent } from '@/lib/agent/handlers/funding';
import { toFiatCurrency } from '@/lib/wallet-session';

describe('toFiatCurrency', () => {
  it('accepts a currency the on-ramp actually supports', async () => {
    // The case this was built for.
    assert.equal(toFiatCurrency('INR'), 'inr');
    assert.equal(toFiatCurrency('inr'), 'inr');
  });

  it('normalises what a model is likely to emit', async () => {
    assert.equal(toFiatCurrency('  Inr '), 'inr');
    assert.equal(toFiatCurrency('₹INR'), 'inr');
  });

  it('rejects anything not in the supported set', async () => {
    // Never passed through to the SDK on a guess.
    assert.equal(toFiatCurrency('rupees'), null);
    assert.equal(toFiatCurrency('XYZ'), null);
    assert.equal(toFiatCurrency(''), null);
    assert.equal(toFiatCurrency(null), null);
  });
});

describe('planFunding', () => {
  it('defaults to USDC on Base', async () => {
    const plan = planFunding({});
    assert.equal(plan.chainId, 8453);
    assert.equal(plan.asset, 'USDC');
  });

  it('carries a supported currency through', async () => {
    const plan = planFunding({ currency: 'INR', amount: '5000' });
    assert.equal(plan.currency, 'inr');
    assert.equal(plan.amount, '5000');
    assert.equal(plan.unsupportedCurrency, null);
  });

  it('flags an unsupported currency instead of silently using dollars', async () => {
    /*
     * Someone who asked to pay in a currency the on-ramp cannot take needs to
     * be told before the payment sheet opens, not inside it.
     */
    const plan = planFunding({ currency: 'ZWL' });
    assert.equal(plan.currency, null);
    assert.equal(plan.unsupportedCurrency, 'ZWL');
    assert.match(describeFunding(plan), /not one of the currencies/i);
  });

  it('refuses an asset it has no verified address for', async () => {
    // Same rule as every other path: never approximate a token address.
    assert.throws(() => planFunding({ asset: 'SCAMCOIN' }), /verified/i);
  });

  it('resolves a known asset on the named chain', async () => {
    const plan = planFunding({ chain: 'polygon', asset: 'usdt' });
    assert.equal(plan.chainId, 137);
    assert.equal(plan.asset, 'USDT');
  });

  it('drops an unusable amount rather than passing it on', async () => {
    assert.equal(planFunding({ amount: 'a lot' }).amount, null);
    assert.equal(planFunding({ amount: '-5' }).amount, '5');
    assert.equal(planFunding({ amount: '0' }).amount, null);
    assert.equal(planFunding({ amount: '5,000' }).amount, '5000');
  });

  it('tells the model not to promise the purchase will work', async () => {
    // Availability depends on the user's country and provider; neither is
    // knowable from the server.
    assert.match(describeFunding(planFunding({ currency: 'inr' })), /do not promise/i);
  });
});

describe('detectFundingIntent', () => {
  const hit = (text: string) => detectFundingIntent(text);

  it('catches the phrasing that used to be refused outright', async () => {
    const found = await hit('i want to buy USDC with INR');
    assert.ok(found, 'expected a funding intent');
    assert.equal(found.plan.currency, 'inr');
    assert.equal(found.plan.asset, 'USDC');
  });

  it('understands a currency by name and pulls out the amount', async () => {
    const found = await hit('buy 5000 rupees of USDC');
    assert.equal(found?.plan.currency, 'inr');
    assert.equal(found?.plan.amount, '5000');
  });

  it('reads the rupee symbol', async () => {
    assert.equal((await hit('buy ₹2000 of usdc'))?.plan.currency, 'inr');
  });

  it('fires on a named payment method with no currency at all', async () => {
    assert.ok(await hit('add funds'));
    assert.ok(await hit('top up my wallet'));
    assert.ok(await hit('I want to pay with card'));
  });

  it('honours a named chain and asset', async () => {
    const found = await hit('buy USDT on polygon with rupees');
    assert.equal(found?.plan.chainId, 137);
    assert.equal(found?.plan.asset, 'USDT');
  });

  /*
   * The failure that actually matters. Sending someone to a payment sheet
   * when they asked for a trade is far worse than letting the model handle a
   * phrasing this misses, so every one of these must fall through.
   */
  it('never mistakes a swap for a purchase', async () => {
    assert.equal(await hit('buy ETH with USDC'), null);
    assert.equal(await hit('buy 0.1 ETH with USDT on Base'), null);
    assert.equal(await hit('swap 100 USDC to ETH'), null);
    assert.equal(await hit('buy WBTC'), null);
  });

  it('does not fire on dollars, which this app prices everything in', async () => {
    // "buy $500 of USDC" reads as much like a dollar-sized swap as a card
    // purchase, so it goes to the model rather than being guessed at.
    assert.equal(await hit('buy $500 of USDC'), null);
    assert.equal(await hit('buy 500 usd of usdc'), null);
  });

  it('leaves ordinary questions alone', async () => {
    assert.equal(await hit('what is the best yield for USDC?'), null);
    assert.equal(await hit('what is my portfolio worth'), null);
    assert.equal(await hit('deposit 10 USDC into morpho'), null);
    assert.equal(await hit('bridge 500 USDC from arbitrum to base'), null);
    assert.equal(await hit(''), null);
  });

  it('writes its own reply, since no model runs on this path', async () => {
    const found = await hit('buy USDC with INR');
    assert.match(found!.reply, /INR/);
    // Still refuses to promise an outcome it cannot know.
    assert.match(found!.reply, /cannot promise|depends on your country/i);
  });
});
