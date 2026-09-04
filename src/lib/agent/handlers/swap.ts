import type { Address } from 'viem';
import { chainName, resolveChain } from '@/lib/chains';
import { formatTokenAmount, parseAmount } from '@/lib/format';
import { readBalance } from '@/lib/erc20';
import { isUniswapConfigured, quoteSwap as quoteUniswap } from '@/lib/providers/uniswap';
import { quoteSwap as quoteOpenOcean } from '@/lib/providers/openocean';
import { getUsdPrice } from '@/lib/providers/prices';
import type { SwapQuoteResult } from '@/lib/providers/swap-types';
import type { TxProposal, TxStep } from '@/types/tx';
import { resolveToken } from '../resolve';
import { clampSlippage, QUOTE_TTL_MS, warningsForSwap } from './shared';

export interface SwapArgs {
  chain: string;
  fromToken: string;
  toToken: string;
  amount: string;
  slippageBps?: number;
}

export async function buildSwapProposal(
  args: SwapArgs,
  wallet: Address,
): Promise<TxProposal> {
  const chainId = resolveChain(args.chain);
  const [from, to] = await Promise.all([
    resolveToken(chainId, args.fromToken),
    resolveToken(chainId, args.toToken),
  ]);

  if (from.address.toLowerCase() === to.address.toLowerCase()) {
    throw new Error('Those are the same token — nothing to swap.');
  }

  const amountIn = parseAmount(args.amount, from.decimals);
  const slippageBps = clampSlippage(args.slippageBps);

  // Fail on insufficient balance before spending a quote, so the user gets a
  // straight answer instead of a route they cannot execute.
  const balance = await readBalance({ chainId, token: from.address, owner: wallet });
  if (balance < amountIn) {
    throw new Error(
      `Your ${from.symbol} balance on ${chainName(chainId)} is ${formatTokenAmount(balance, from.decimals)}, which is less than the ${args.amount} you asked to swap.`,
    );
  }

  const quote = await routeSwap({
    chainId,
    tokenIn: from.address,
    tokenOut: to.address,
    tokenInDecimals: from.decimals,
    tokenInSymbol: from.symbol,
    amountIn: amountIn.toString(),
    swapper: wallet,
    slippageBps,
  });

  const [fromPrice, toPrice] = await Promise.all([
    getUsdPrice(chainId, from.address),
    getUsdPrice(chainId, to.address),
  ]);

  const steps: TxStep[] = [];
  if (quote.cancelTx) {
    steps.push({
      id: `${quote.provider}-reset`,
      kind: 'approve',
      label: `Reset ${from.symbol} allowance`,
      detail: `${from.symbol} requires clearing an existing allowance before setting a new one.`,
      execute: { via: 'transaction', tx: quote.cancelTx },
    });
  }
  if (quote.approvalTx) {
    steps.push({
      id: `${quote.provider}-approve`,
      kind: 'approve',
      label: `Approve ${from.symbol}`,
      detail: `Lets the router move exactly ${args.amount} ${from.symbol} — not an unlimited allowance.`,
      execute: { via: 'transaction', tx: quote.approvalTx },
    });
  }
  steps.push({
    id: `${quote.provider}-swap`,
    kind: 'swap',
    label: `Swap ${from.symbol} → ${to.symbol}`,
    detail: quote.route,
    execute: { via: 'transaction', tx: quote.swapTx },
  });

  const outAmount = BigInt(quote.toAmount);

  return {
    id: crypto.randomUUID(),
    kind: 'swap',
    from: {
      symbol: from.symbol,
      address: from.address,
      chainId,
      decimals: from.decimals,
      amount: amountIn.toString(),
      ...(fromPrice ? { amountUsd: toUsd(amountIn, from.decimals, fromPrice) } : {}),
    },
    to: {
      symbol: to.symbol,
      address: to.address,
      chainId,
      decimals: to.decimals,
      amount: quote.toAmount,
      ...(toPrice ? { amountUsd: toUsd(outAmount, to.decimals, toPrice) } : {}),
    },
    // A same-chain swap always settles to the swapper's own address.
    recipient: wallet,
    isSelfCustody: true,
    minReceived: quote.minToAmount,
    slippageBps,
    ...(quote.priceImpactPct !== undefined ? { priceImpactPct: quote.priceImpactPct } : {}),
    ...(quote.gasUsd !== undefined ? { estimatedGasUsd: quote.gasUsd } : {}),
    route: quote.route,
    provider: quote.provider,
    steps,
    warnings: warningsForSwap({ quote, slippageBps, fromSymbol: from.symbol }),
    expiresAt: Date.now() + QUOTE_TTL_MS,
  };
}

/**
 * Uniswap is the primary venue. Its Trading API needs a (free) key, so when one
 * is not configured — or the route needs a Permit2 signature we deliberately
 * don't use — we fall back to a no-signup aggregator rather than failing.
 */
async function routeSwap(params: Parameters<typeof quoteOpenOcean>[0]): Promise<SwapQuoteResult> {
  if (!isUniswapConfigured()) return quoteOpenOcean(params);
  try {
    return await quoteUniswap(params);
  } catch {
    return quoteOpenOcean(params);
  }
}

function toUsd(amount: bigint, decimals: number, price: number): number {
  return (Number(amount) / 10 ** decimals) * price;
}
