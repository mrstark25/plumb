import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { formatTokenAmount, formatCompactUsd, formatDuration, formatFeeUsd, parseAmount } from '@/lib/format';
import { resolveChain, isSupportedChainId } from '@/lib/chains';
import { findToken, isNative, NATIVE_ADDRESS } from '@/lib/tokens';
import { clampSlippage, warningsForBridge, warningsForSwap } from '@/lib/agent/handlers/shared';

const OWNER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const ATTACKER = '0x000000000000000000000000000000000000dEaD';

describe('parseAmount', () => {
  it('converts a plain decimal to base units', () => {
    assert.equal(parseAmount('1.5', 18), 1_500_000_000_000_000_000n);
    assert.equal(parseAmount('100', 6), 100_000_000n);
  });

  it('rejects scientific notation, which would silently become the wrong number', () => {
    assert.throws(() => parseAmount('1e18', 18), /Invalid amount/);
  });

  it('rejects thousands separators rather than truncating at the comma', () => {
    assert.throws(() => parseAmount('1,000', 6), /Invalid amount/);
  });

  it('rejects vague quantities the model might emit', () => {
    assert.throws(() => parseAmount('all', 18), /Invalid amount/);
    assert.throws(() => parseAmount('', 18), /Invalid amount/);
  });

  it('rejects negatives', () => {
    assert.throws(() => parseAmount('-5', 18), /Invalid amount/);
  });

  it('rejects zero', () => {
    assert.throws(() => parseAmount('0', 18), /greater than zero/);
  });

  it('refuses precision the token cannot represent instead of rounding it away', () => {
    assert.throws(() => parseAmount('1.1234567', 6), /more precision/);
    assert.equal(parseAmount('1.123456', 6), 1_123_456n);
  });
});

describe('resolveChain', () => {
  it('accepts names, aliases, and numeric ids', () => {
    assert.equal(resolveChain('ethereum'), 1);
    assert.equal(resolveChain('ETH'), 1);
    assert.equal(resolveChain('  Base '), 8453);
    assert.equal(resolveChain('polygon'), 137);
    assert.equal(resolveChain('arbitrum one'), 42161);
    assert.equal(resolveChain(8453), 8453);
    assert.equal(resolveChain('42161'), 42161);
  });

  it('refuses unsupported chains rather than defaulting to mainnet', () => {
    assert.throws(() => resolveChain('solana'), /Unknown chain/);
    assert.throws(() => resolveChain(10), /Unsupported chain/, 'Optimism is not supported');
  });

  it('reports support correctly', () => {
    assert.equal(isSupportedChainId(1), true);
    assert.equal(isSupportedChainId(137), true, 'Polygon is supported');
    assert.equal(isSupportedChainId(10), false, 'Optimism is not');
  });
});

describe('findToken', () => {
  it('resolves known symbols case-insensitively, per chain', () => {
    assert.equal(findToken('base', 'usdc')?.address, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    assert.equal(findToken(1, 'USDC')?.decimals, 6);
    assert.equal(findToken('arbitrum', 'ARB')?.decimals, 18);
  });

  it('does not leak a token from one chain into another', () => {
    assert.equal(findToken('base', 'ARB'), undefined);
    assert.equal(findToken('base', 'USDT'), undefined);
  });

  it('returns undefined for unknown symbols so callers must handle it explicitly', () => {
    assert.equal(findToken('base', 'NOTAREALTOKEN'), undefined);
  });

  it('identifies the native sentinel', () => {
    assert.equal(isNative(NATIVE_ADDRESS), true);
    assert.equal(isNative(NATIVE_ADDRESS.toLowerCase()), true);
    assert.equal(isNative('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), false);
  });
});

describe('formatTokenAmount', () => {
  it('scales precision to magnitude', () => {
    assert.equal(formatTokenAmount(1_500_000_000_000_000_000n, 18), '1.5');
    assert.equal(formatTokenAmount(0n, 18), '0');
  });

  it('never rounds dust up to a balance the user does not hold', () => {
    assert.equal(formatTokenAmount(1n, 18), '<0.000001');
  });

  it('groups large balances', () => {
    assert.equal(formatTokenAmount(1_234_567_000_000n, 6), '1,234,567');
  });
});

describe('display helpers', () => {
  it('compacts large USD values', () => {
    assert.equal(formatCompactUsd(2_400_000_000), '$2.4B');
    assert.equal(formatCompactUsd(15_300_000), '$15.3M');
    assert.equal(formatCompactUsd(999), '$999.00');
  });

  it('renders durations at a sensible unit', () => {
    assert.equal(formatDuration(45), '45s');
    assert.equal(formatDuration(600), '10 min');
    assert.equal(formatDuration(0), '—');
  });
});

describe('clampSlippage', () => {
  it('defaults to 0.5% when the model omits it', () => {
    assert.equal(clampSlippage(undefined), 50);
    assert.equal(clampSlippage(Number.NaN), 50);
  });

  it('caps at 5%, above which a swap is an invitation to be sandwiched', () => {
    assert.equal(clampSlippage(5000), 500);
  });

  it('floors at 0.1% so a quote can still fill', () => {
    assert.equal(clampSlippage(0), 10);
    assert.equal(clampSlippage(1), 10);
  });

  it('passes sensible values through', () => {
    assert.equal(clampSlippage(100), 100);
  });
});

describe('swap warnings', () => {
  const baseQuote = {
    provider: 'Test', route: 'r', toAmount: '1', minToAmount: '1',
    swapTx: { chainId: 8453, to: '0x0' as const, data: '0x' as const, value: '0' },
  };

  it('flags material price impact', () => {
    const warnings = warningsForSwap({
      quote: { ...baseQuote, priceImpactPct: 3.2 }, slippageBps: 50, fromSymbol: 'USDC',
    });
    assert.ok(warnings.some((w) => w.includes('3.20%')));
  });

  it('stays quiet when impact is negligible', () => {
    const warnings = warningsForSwap({
      quote: { ...baseQuote, priceImpactPct: 0.03 }, slippageBps: 50, fromSymbol: 'USDC',
    });
    assert.equal(warnings.length, 0);
  });

  it('warns about loose slippage', () => {
    const warnings = warningsForSwap({ quote: baseQuote, slippageBps: 300, fromSymbol: 'USDC' });
    assert.ok(warnings.some((w) => w.includes('sandwich')));
  });

  it('tells the user when an extra approval signature is coming', () => {
    const warnings = warningsForSwap({
      quote: { ...baseQuote, approvalTx: baseQuote.swapTx }, slippageBps: 50, fromSymbol: 'USDC',
    });
    assert.ok(warnings.some((w) => w.includes('two transactions')));
  });
});

describe('bridge warnings', () => {
  const selfCustody = { isSelfCustody: true, recipient: OWNER };

  it('always states the bridge risk, because it is the largest one', () => {
    const warnings = warningsForBridge({
      executionSeconds: 30, toolName: 'Across', slippageBps: 50, hasApproval: false, ...selfCustody,
    });
    assert.ok(warnings[0]?.includes('Across'));
    assert.ok(warnings[0]?.includes('exploited'));
  });

  it('calls out slow routes where the quote is not locked in', () => {
    const warnings = warningsForBridge({
      executionSeconds: 1800, toolName: 'Hop', slippageBps: 50, hasApproval: false, ...selfCustody,
    });
    assert.ok(warnings.some((w) => w.includes('15 minutes')));
  });

  it('leads with the destination when funds are not going to the user', () => {
    // A redirected bridge is what a prompt injection would be aiming for, so
    // it must outrank every other warning in the list.
    const warnings = warningsForBridge({
      executionSeconds: 30, toolName: 'Across', slippageBps: 50, hasApproval: false,
      isSelfCustody: false, recipient: ATTACKER,
    });
    assert.ok(warnings[0]?.includes(ATTACKER));
    assert.ok(warnings[0]?.includes('NOT your connected wallet'));
  });

  it('says nothing about the destination when it is the connected wallet', () => {
    const warnings = warningsForBridge({
      executionSeconds: 30, toolName: 'Across', slippageBps: 50, hasApproval: false, ...selfCustody,
    });
    assert.ok(!warnings.some((w) => w.includes('NOT your connected wallet')));
  });
});

describe('formatFeeUsd', () => {
  it('does not render an unpriced fee as free', () => {
    // "$0.00" reads as "this costs nothing", which is never what a missing
    // gas estimate means.
    assert.equal(formatFeeUsd(undefined), 'Not available');
    assert.equal(formatFeeUsd(0), 'Not available');
    assert.equal(formatFeeUsd(Number.NaN), 'Not available');
  });

  it('distinguishes a sub-cent fee from no fee', () => {
    assert.equal(formatFeeUsd(0.004), '<$0.01');
  });

  it('formats a normal fee as currency', () => {
    assert.equal(formatFeeUsd(2.5), '$2.50');
  });
});
