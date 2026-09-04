import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  totalsFor,
  type EarnPosition,
  type Holding,
  type PortfolioSnapshot,
} from '@/lib/portfolio/snapshot';
import { summarise } from '@/lib/agent/handlers/portfolio';
import { healthBand, type AaveAccount } from '@/lib/providers/aave';
import { annualisedFromSsr } from '@/lib/providers/sky';
import { parseMorphoAmount } from '@/lib/providers/morpho-positions';

const holding = (over: Partial<Holding> = {}): Holding => ({
  chainId: 8453,
  symbol: 'USDC',
  amount: '1000000',
  decimals: 6,
  usd: 100,
  change24hPct: 0,
  ...over,
});

const position = (over: Partial<EarnPosition> = {}): EarnPosition => ({
  protocol: 'Morpho',
  chainId: 8453,
  name: 'Steakhouse USDC',
  assetSymbol: 'USDC',
  amount: '1000000',
  decimals: 6,
  usd: 1000,
  apyPct: 5,
  projectedYearlyUsd: 50,
  ...over,
});

const aave = (over: Partial<AaveAccount> = {}): AaveAccount => ({
  chainId: 1,
  suppliedUsd: 1000,
  borrowedUsd: 400,
  netUsd: 600,
  healthFactor: 2,
  ltvPct: 70,
  liquidationThresholdPct: 80,
  ...over,
});

describe('totalsFor', () => {
  it('nets borrowing out of net worth', () => {
    // Supplied collateral is still the user's; the debt against it is not.
    const totals = totalsFor([holding({ usd: 500 })], [position({ usd: 1000 })], [aave()]);

    assert.equal(totals.walletUsd, 500);
    assert.equal(totals.earningUsd, 1000);
    assert.equal(totals.borrowedUsd, 400);
    assert.equal(totals.netWorthUsd, 500 + 1000 + (1000 - 400));
  });

  it('computes the 24h move against the previous value, not the current one', () => {
    // $110 now after +10% means $100 yesterday and $10 of movement — not $11.
    const totals = totalsFor([holding({ usd: 110, change24hPct: 10 })], [], []);

    assert.ok(totals.change24hUsd !== undefined);
    assert.ok(Math.abs(totals.change24hUsd - 10) < 1e-9);
    assert.ok(totals.change24hPct !== undefined);
    assert.ok(Math.abs(totals.change24hPct - 10) < 1e-9);
  });

  it('takes the 24h percentage over only the holdings that moved', () => {
    /*
     * One holding has a change and one does not. Spreading the dollar move
     * across both would halve the reported percentage and make a volatile day
     * look calm.
     */
    const totals = totalsFor(
      [holding({ usd: 110, change24hPct: 10 }), holding({ symbol: 'DAI', usd: 900, change24hPct: null })],
      [],
      [],
    );

    assert.ok(totals.change24hPct !== undefined);
    assert.ok(Math.abs(totals.change24hPct - 10) < 1e-9);
  });

  it('reports no 24h figure at all when nothing carries one', () => {
    // Undefined, never zero: "we do not know" and "it did not move" differ.
    const totals = totalsFor([holding({ usd: 100, change24hPct: null })], [], []);

    assert.equal(totals.change24hUsd, undefined);
    assert.equal(totals.change24hPct, undefined);
  });

  it('counts unpriced holdings instead of valuing them at zero', () => {
    const totals = totalsFor([holding({ usd: 100 }), holding({ symbol: 'XYZ', usd: undefined })], [], []);

    assert.equal(totals.walletUsd, 100);
    assert.equal(totals.unpricedCount, 1);
  });

  it('sums projected yield across protocols', () => {
    const totals = totalsFor(
      [],
      [position({ projectedYearlyUsd: 50 }), position({ protocol: 'Sky', projectedYearlyUsd: 30 })],
      [],
    );

    assert.equal(totals.projectedYearlyUsd, 80);
  });

  it('produces zeroes rather than NaN for an empty portfolio', () => {
    const totals = totalsFor([], [], []);

    assert.equal(totals.netWorthUsd, 0);
    assert.equal(totals.change24hPct, undefined);
    assert.equal(totals.projectedYearlyUsd, 0);
  });
});

describe('healthBand', () => {
  it('treats a debt-free account as having no band, not a safe one', () => {
    // There is nothing to liquidate, which is different from being far from it.
    assert.equal(healthBand(null), 'none');
  });

  it('escalates as the account approaches liquidation', () => {
    assert.equal(healthBand(3), 'safe');
    assert.equal(healthBand(1.5), 'safe');
    assert.equal(healthBand(1.49), 'watch');
    assert.equal(healthBand(1.1), 'watch');
    assert.equal(healthBand(1.09), 'danger');
    // Aave liquidates below 1.0, so at-or-under is the loudest state.
    assert.equal(healthBand(0.98), 'danger');
  });
});

describe('annualisedFromSsr', () => {
  it('compounds the per-second rate rather than multiplying it', () => {
    /*
     * Pinned against a rate read from the live sUSDS contract on Ethereum.
     * Simple multiplication would give ~3.46%; compounding gives ~3.52%.
     */
    const apy = annualisedFromSsr(1_000_000_001_096_988_989_836_188_433n);

    assert.ok(apy > 3.4 && apy < 3.6, `expected ~3.5%, got ${apy}`);
  });

  it('reports zero when the rate is unreadable', () => {
    // A failed read must not become a negative or infinite APY on the card.
    assert.equal(annualisedFromSsr(0n), 0);
  });
});

describe('parseMorphoAmount', () => {
  it('accepts both encodings the API returns in one response', () => {
    // Small positions come back as numbers, large ones as decimal strings.
    assert.equal(parseMorphoAmount(1_000_000_000), 1_000_000_000n);
    assert.equal(parseMorphoAmount('1000000000000000000'), 1_000_000_000_000_000_000n);
  });

  it('does not throw on a fractional value', () => {
    // BigInt() rejects a decimal point; an exception here would drop the
    // whole portfolio rather than one field.
    assert.equal(parseMorphoAmount('1.5'), 0n);
    assert.equal(parseMorphoAmount(1.5), 2n);
  });

  it('treats missing and malformed values as zero', () => {
    assert.equal(parseMorphoAmount(undefined), 0n);
    assert.equal(parseMorphoAmount(''), 0n);
    assert.equal(parseMorphoAmount('not-a-number'), 0n);
  });

  it('never returns a negative balance', () => {
    assert.equal(parseMorphoAmount('-5'), 0n);
  });
});

describe('summarise', () => {
  const snapshot = (over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot => {
    const holdings = over.holdings ?? [holding({ usd: 500, change24hPct: 2 })];
    const positions = over.positions ?? [];
    const accounts = over.aave ?? [];
    return {
      address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      holdings,
      positions,
      aave: accounts,
      totals: { ...totalsFor(holdings, positions, accounts), dustCount: 0 },
      asOf: 0,
      hasCostBasis: false,
      ...over,
    } as PortfolioSnapshot;
  };

  it('always tells the model it has no cost basis', () => {
    /*
     * The single most important line in this string. Without it the model
     * answers "how am I doing?" with a profit figure derived from nothing.
     */
    const text = summarise(snapshot());

    assert.match(text, /No cost basis/i);
    assert.match(text, /Never state profit, loss or return/i);
  });

  it('says so plainly when there is nothing to report', () => {
    const text = summarise(snapshot({ holdings: [], positions: [], aave: [] }));

    assert.match(text, /holds none of the tokens/i);
  });

  it('reports an Aave account with no debt as such, not as a health factor', () => {
    const text = summarise(snapshot({ aave: [aave({ borrowedUsd: 0, healthFactor: null })] }));

    assert.match(text, /no debt/i);
    assert.doesNotMatch(text, /health factor/i);
  });

  it('names the health factor when there is debt', () => {
    const text = summarise(snapshot({ aave: [aave({ healthFactor: 1.23 })] }));

    assert.match(text, /health factor 1\.23/);
  });

  it('caps the holdings it names and counts the rest', () => {
    // The summary shares a token budget with the system prompt and every tool
    // schema; an unbounded list would crowd out the reply itself.
    const many = Array.from({ length: 14 }, (_, index) =>
      holding({ symbol: `TK${index}`, usd: 100 - index }),
    );
    const text = summarise(snapshot({ holdings: many }));

    assert.match(text, /and 6 smaller holdings/);
  });

  it('discloses dust and unpriced rows rather than quietly dropping them', () => {
    const base = snapshot({ holdings: [holding({ usd: undefined })] });
    const text = summarise({
      ...base,
      totals: { ...base.totals, dustCount: 3, unpricedCount: 1 },
    } as PortfolioSnapshot);

    assert.match(text, /3 dust position/);
    assert.match(text, /1 holding\(s\) could not be priced/);
  });
});
