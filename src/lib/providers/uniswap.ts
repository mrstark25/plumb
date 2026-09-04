import { zeroAddress, type Address } from 'viem';
import { isNative } from '@/lib/tokens';
import type { TxRequest } from '@/types/tx';
import { hexToDecimalString, ProviderError, requestJson } from './http';
import type { SwapQuoteParams, SwapQuoteResult } from './swap-types';
import type { BridgeQuoteParams, BridgeQuoteResult } from './bridge-types';

const BASE_URL = 'https://trade-api.gateway.uniswap.org/v1';

interface UniswapTx {
  to: Address;
  from: Address;
  data: `0x${string}`;
  value: string;
  chainId: number;
  gasLimit?: string;
}

interface QuoteResponse {
  routing: string;
  quote: {
    input: { amount: string; token: Address };
    output: { amount: string; token: Address; minimumAmount?: string };
    gasFeeUSD?: string;
    priceImpact?: number;
    routeString?: string;
    /** Present on BRIDGE routing only. */
    estimatedFillTimeMs?: number;
  };
  permitData: unknown | null;
}

interface SwapResponse {
  swap: UniswapTx;
}

interface ApprovalResponse {
  approval: UniswapTx | null;
  cancel: UniswapTx | null;
}

export function isUniswapConfigured(): boolean {
  return Boolean(process.env.UNISWAP_API_KEY);
}

function headers(): Record<string, string> {
  const key = process.env.UNISWAP_API_KEY;
  if (!key) throw new ProviderError('Uniswap', 'UNISWAP_API_KEY is not configured.');
  return {
    'x-api-key': key,
    // Permit2 would require an EIP-712 signature collected between the quote
    // and the swap call. We deliberately opt into plain ERC-20 approvals so the
    // whole flow is a linear sequence of transactions the wallet can sign.
    'x-permit2-disabled': 'true',
  };
}

export async function quoteSwap(params: SwapQuoteParams): Promise<SwapQuoteResult> {
  const { chainId, tokenIn, tokenOut, amountIn, swapper, slippageBps } = params;

  // The Trading API represents native assets as the zero address, unlike the
  // 0xEeee… sentinel the aggregators use.
  const inToken = isNative(tokenIn) ? zeroAddress : tokenIn;
  const outToken = isNative(tokenOut) ? zeroAddress : tokenOut;

  const quoteBody = await requestJson<QuoteResponse>(`${BASE_URL}/quote`, {
    provider: 'Uniswap',
    method: 'POST',
    headers: headers(),
    body: {
      type: 'EXACT_INPUT',
      amount: amountIn,
      tokenInChainId: chainId,
      tokenOutChainId: chainId,
      tokenIn: inToken,
      tokenOut: outToken,
      swapper,
      // The API takes slippage as a percentage number, not basis points.
      slippageTolerance: slippageBps / 100,
      routingPreference: 'BEST_PRICE',
      urgency: 'normal',
    },
  });

  if (quoteBody.permitData) {
    throw new ProviderError(
      'Uniswap',
      'This route requires a Permit2 signature, which Plumb does not use.',
    );
  }
  if (!['CLASSIC', 'WRAP', 'UNWRAP'].includes(quoteBody.routing)) {
    throw new ProviderError('Uniswap', `Unsupported routing type "${quoteBody.routing}".`);
  }

  const swapBody = await requestJson<SwapResponse>(`${BASE_URL}/swap`, {
    provider: 'Uniswap',
    method: 'POST',
    headers: headers(),
    // The quote object must be passed back verbatim; any edit invalidates it.
    body: { quote: quoteBody.quote, simulateTransaction: false },
  });

  const approval = isNative(tokenIn)
    ? { approval: null, cancel: null }
    : await checkApproval({ chainId, token: inToken, amount: amountIn, walletAddress: swapper });

  const output = quoteBody.quote.output;

  return {
    provider: 'Uniswap',
    route: describeRoute(quoteBody.quote.routeString, quoteBody.routing),
    toAmount: output.amount,
    minToAmount: output.minimumAmount ?? output.amount,
    ...(quoteBody.quote.priceImpact !== undefined
      ? { priceImpactPct: Math.abs(quoteBody.quote.priceImpact) }
      : {}),
    ...(quoteBody.quote.gasFeeUSD ? { gasUsd: Number(quoteBody.quote.gasFeeUSD) } : {}),
    ...(approval.cancel ? { cancelTx: toTxRequest(approval.cancel) } : {}),
    ...(approval.approval ? { approvalTx: toTxRequest(approval.approval) } : {}),
    swapTx: toTxRequest(swapBody.swap),
  };
}

async function checkApproval(input: {
  chainId: number;
  token: Address;
  amount: string;
  walletAddress: Address;
}): Promise<ApprovalResponse> {
  // Note the field is `chainId` here, not `tokenInChainId` as on /quote.
  return requestJson<ApprovalResponse>(`${BASE_URL}/check_approval`, {
    provider: 'Uniswap',
    method: 'POST',
    headers: headers(),
    body: {
      walletAddress: input.walletAddress,
      token: input.token,
      amount: input.amount,
      chainId: input.chainId,
    },
  });
}

/**
 * Uniswap nests the transaction under `swap` and names the gas field
 * `gasLimit`. `value` comes back decimal for swaps but 0x-hex for bridges, so
 * it is normalised here rather than at each call site.
 */
function toTxRequest(tx: UniswapTx): TxRequest {
  return {
    chainId: tx.chainId,
    to: tx.to,
    data: tx.data,
    value: hexToDecimalString(tx.value ?? '0'),
    ...(tx.gasLimit ? { gasLimit: String(tx.gasLimit) } : {}),
  };
}

/**
 * Cross-chain transfers through the same Trading API. `routing: BRIDGE` is
 * Across underneath, quoted without an aggregator's margin on top, which is
 * why it prices better than a router on almost every pair we support.
 *
 * Coverage is the trade-off: only assets Uniswap bridges are routable here, so
 * callers fall back to a full aggregator when this throws.
 */
export async function quoteBridge(params: BridgeQuoteParams): Promise<BridgeQuoteResult> {
  const { fromChainId, toChainId, fromToken, toToken, fromAmount, fromAddress, slippageBps } = params;

  if (params.toAddress.toLowerCase() !== fromAddress.toLowerCase()) {
    // The Trading API settles a bridge to the swapper's own address; it has no
    // separate recipient field. Refusing here sends the request to LI.FI,
    // which does support one, rather than silently misdirecting funds.
    throw new ProviderError('Uniswap', 'Bridging to a third-party address is not supported.');
  }

  const quoteBody = await requestJson<QuoteResponse>(`${BASE_URL}/quote`, {
    provider: 'Uniswap',
    method: 'POST',
    headers: headers(),
    body: {
      type: 'EXACT_INPUT',
      amount: fromAmount,
      tokenInChainId: fromChainId,
      tokenOutChainId: toChainId,
      tokenIn: isNative(fromToken) ? zeroAddress : fromToken,
      tokenOut: isNative(toToken) ? zeroAddress : toToken,
      swapper: fromAddress,
      slippageTolerance: slippageBps / 100,
      urgency: 'normal',
    },
  });

  if (quoteBody.routing !== 'BRIDGE') {
    throw new ProviderError('Uniswap', `Expected a bridge route, got "${quoteBody.routing}".`);
  }
  if (quoteBody.permitData) {
    throw new ProviderError('Uniswap', 'This route requires a Permit2 signature, which Plumb does not use.');
  }

  const swapBody = await requestJson<SwapResponse>(`${BASE_URL}/swap`, {
    provider: 'Uniswap',
    method: 'POST',
    headers: headers(),
    body: { quote: quoteBody.quote, simulateTransaction: false },
  });

  const approval = isNative(fromToken)
    ? { approval: null, cancel: null }
    : await checkApproval({
        chainId: fromChainId,
        token: fromToken,
        amount: fromAmount,
        walletAddress: fromAddress,
      });

  const output = quoteBody.quote.output;

  return {
    provider: 'Uniswap',
    toolName: 'Across via Uniswap',
    toAmount: output.amount,
    toAmountMin: output.minimumAmount ?? output.amount,
    executionSeconds: Math.max(1, Math.round((quoteBody.quote.estimatedFillTimeMs ?? 0) / 1000)),
    ...(quoteBody.quote.gasFeeUSD ? { gasUsd: Number(quoteBody.quote.gasFeeUSD) } : {}),
    ...(approval.cancel ? { cancelTx: toTxRequest(approval.cancel) } : {}),
    ...(approval.approval ? { approvalTx: toTxRequest(approval.approval) } : {}),
    bridgeTx: toTxRequest(swapBody.swap),
  };
}

/**
 * Uniswap's `routeString` is a routing-engine artefact — it embeds raw pool
 * addresses, which mean nothing to a user reading a confirmation card. We keep
 * only the parts that carry meaning: the protocol version and the fee tier.
 */
function describeRoute(routeString: string | undefined, routing: string): string {
  if (routing === 'WRAP') return 'Wrap ETH';
  if (routing === 'UNWRAP') return 'Unwrap WETH';

  const version = routeString?.match(/\[(v\d)\]/i)?.[1]?.toLowerCase();
  const feeTier = routeString?.match(/\[(\d+(?:\.\d+)?%)\]/)?.[1];

  const parts = ['Uniswap'];
  if (version) parts.push(version);
  const label = parts.join(' ');
  return feeTier ? `${label} · ${feeTier} pool` : label;
}
