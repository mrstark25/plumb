import { formatUnits, type Address } from 'viem';
import { planApproval } from '@/lib/erc20';
import { isNative } from '@/lib/tokens';
import type { SupportedChainId } from '@/lib/chains';
import { publicClientFor } from '@/lib/viem';
import { ProviderError, requestJson } from './http';
import type { SwapQuoteParams, SwapQuoteResult } from './swap-types';

const BASE_URL = 'https://open-api.openocean.finance/v4';

/** OpenOcean addresses chains by slug, not id. */
const CHAIN_SLUGS: Record<number, string> = {
  1: 'eth',
  8453: 'base',
  42161: 'arbitrum',
};

interface OpenOceanSwap {
  to: Address;
  data: `0x${string}`;
  value: string;
  chainId: number;
  estimatedGas: number | string;
  outAmount: string;
  minOutAmount: string;
  price_impact?: string;
}

/**
 * Zero-signup swap fallback used when no Uniswap key is configured.
 *
 * Two quirks are normalised here so they cannot leak into the rest of the app:
 * request amounts are human-readable while every response amount is in wei,
 * and Cloudflare rejects the request outright without a Referer header.
 */
export async function quoteSwap(params: SwapQuoteParams): Promise<SwapQuoteResult> {
  const { chainId, tokenIn, tokenOut, tokenInDecimals, amountIn, swapper, slippageBps } = params;

  const slug = CHAIN_SLUGS[chainId];
  if (!slug) throw new ProviderError('OpenOcean', `Chain ${chainId} is not supported.`);

  const gasPriceGwei = await currentGasPriceGwei(chainId as SupportedChainId);

  const query = new URLSearchParams({
    inTokenAddress: tokenIn,
    outTokenAddress: tokenOut,
    // Human-readable units on the way in — the one place this is true.
    amount: formatUnits(BigInt(amountIn), tokenInDecimals),
    gasPrice: gasPriceGwei,
    slippage: String(slippageBps / 100),
    account: swapper,
  });

  const body = await requestJson<{ code: number; data: OpenOceanSwap; message?: string }>(
    `${BASE_URL}/${slug}/swap?${query}`,
    {
      provider: 'OpenOcean',
      // Cloudflare returns 403 without this; a User-Agent alone is not enough.
      headers: { referer: 'https://openocean.finance/', origin: 'https://openocean.finance' },
    },
  );

  if (body.code !== 200 || !body.data) {
    throw new ProviderError('OpenOcean', body.message ?? 'No route found for this pair.');
  }

  const swap = body.data;
  const approval = isNative(tokenIn)
    ? {}
    : await planApproval({
        chainId: chainId as SupportedChainId,
        token: tokenIn,
        symbol: params.tokenInSymbol,
        owner: swapper,
        spender: swap.to,
        amount: BigInt(amountIn),
      });

  return {
    provider: 'OpenOcean',
    route: 'OpenOcean aggregated route',
    toAmount: swap.outAmount,
    minToAmount: swap.minOutAmount,
    ...(swap.price_impact ? { priceImpactPct: parsePriceImpact(swap.price_impact) } : {}),
    ...(approval.resetTx ? { cancelTx: approval.resetTx } : {}),
    ...(approval.approvalTx ? { approvalTx: approval.approvalTx } : {}),
    swapTx: {
      chainId,
      to: swap.to,
      data: swap.data,
      value: swap.value ?? '0',
      gasLimit: String(swap.estimatedGas),
    },
  };
}

async function currentGasPriceGwei(chainId: SupportedChainId): Promise<string> {
  try {
    const wei = await publicClientFor(chainId).getGasPrice();
    return formatUnits(wei, 9);
  } catch {
    return '1';
  }
}

/** Returned as a string that may or may not carry a percent sign. */
function parsePriceImpact(raw: string): number {
  const parsed = Number.parseFloat(raw.replace('%', ''));
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}
