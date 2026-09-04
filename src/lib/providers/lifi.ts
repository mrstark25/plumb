import type { Address } from 'viem';
import { planApproval } from '@/lib/erc20';
import type { SupportedChainId } from '@/lib/chains';
import { hexToDecimalString, ProviderError, requestJson } from './http';
import type { BridgeQuoteParams, BridgeQuoteResult } from './bridge-types';

const BASE_URL = 'https://li.quest/v1';

/** Identifies this app to LI.FI; attribution only, no key required. */
const INTEGRATOR = 'liberty-ai';

interface LifiQuote {
  tool: string;
  toolDetails: { key: string; name: string };
  action: {
    fromChainId: number;
    toChainId: number;
    fromToken: { address: Address; symbol: string; decimals: number; priceUSD?: string };
    toToken: { address: Address; symbol: string; decimals: number; priceUSD?: string };
  };
  estimate: {
    approvalAddress: Address;
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    fromAmountUSD?: string;
    toAmountUSD?: string;
    executionDuration: number;
    gasCosts?: { amountUSD?: string }[];
    feeCosts?: { name: string; amountUSD?: string; included?: boolean }[];
  };
  transactionRequest?: {
    to: Address;
    data: `0x${string}`;
    value: string;
    chainId: number;
    gasLimit?: string;
    gasPrice?: string;
  };
}

function headers(): Record<string, string> {
  const key = process.env.LIFI_API_KEY;
  // The key is optional and only raises rate limits.
  return key ? { 'x-lifi-api-key': key } : {};
}

export async function quoteBridge(params: BridgeQuoteParams): Promise<BridgeQuoteResult> {
  const query = new URLSearchParams({
    fromChain: String(params.fromChainId),
    toChain: String(params.toChainId),
    fromToken: params.fromToken,
    toToken: params.toToken,
    fromAmount: params.fromAmount,
    fromAddress: params.fromAddress,
    toAddress: params.toAddress,
    // LI.FI expresses slippage as a decimal fraction, not basis points.
    slippage: String(params.slippageBps / 10_000),
    integrator: INTEGRATOR,
    order: 'CHEAPEST',
  });

  const quote = await requestJson<LifiQuote>(`${BASE_URL}/quote?${query}`, {
    provider: 'LI.FI',
    headers: headers(),
    timeoutMs: 25_000,
  });

  if (!quote.transactionRequest) {
    throw new ProviderError('LI.FI', 'The route returned no executable transaction.');
  }

  const { estimate, transactionRequest: tx } = quote;

  // LI.FI names the contract to approve separately from the call target; they
  // are often but not always the same address.
  const approval = await planApproval({
    chainId: params.fromChainId as SupportedChainId,
    token: params.fromToken,
    symbol: params.fromTokenSymbol,
    owner: params.fromAddress,
    spender: estimate.approvalAddress,
    amount: BigInt(params.fromAmount),
  });

  return {
    provider: 'LI.FI',
    toolName: quote.toolDetails?.name ?? quote.tool,
    ...(approval.resetTx ? { cancelTx: approval.resetTx } : {}),
    ...(approval.approvalTx ? { approvalTx: approval.approvalTx } : {}),
    toAmount: estimate.toAmount,
    toAmountMin: estimate.toAmountMin,
    ...(estimate.fromAmountUSD ? { fromAmountUsd: Number(estimate.fromAmountUSD) } : {}),
    ...(estimate.toAmountUSD ? { toAmountUsd: Number(estimate.toAmountUSD) } : {}),
    executionSeconds: estimate.executionDuration,
    ...(sumUsd(estimate.gasCosts) !== undefined ? { gasUsd: sumUsd(estimate.gasCosts) } : {}),
    ...(sumUsd(estimate.feeCosts?.filter((f) => !f.included)) !== undefined
      ? { bridgeFeeUsd: sumUsd(estimate.feeCosts?.filter((f) => !f.included)) }
      : {}),
    bridgeTx: {
      chainId: tx.chainId,
      to: tx.to,
      data: tx.data,
      // value and gasLimit arrive as 0x-hex while every amount above is decimal.
      value: hexToDecimalString(tx.value),
      ...(tx.gasLimit ? { gasLimit: hexToDecimalString(tx.gasLimit) } : {}),
    },
  };
}

export type BridgeStatus = 'NOT_FOUND' | 'INVALID' | 'PENDING' | 'DONE' | 'FAILED';

export interface BridgeStatusResult {
  readonly status: BridgeStatus;
  readonly substatus?: string;
  readonly explorerLink?: string;
  readonly receivingTxHash?: string;
}

export async function getBridgeStatus(input: {
  txHash: string;
  fromChainId?: number;
  toChainId?: number;
  bridge?: string;
}): Promise<BridgeStatusResult> {
  const query = new URLSearchParams({ txHash: input.txHash });
  if (input.fromChainId) query.set('fromChain', String(input.fromChainId));
  if (input.toChainId) query.set('toChain', String(input.toChainId));
  if (input.bridge) query.set('bridge', input.bridge);

  try {
    const body = await requestJson<{
      status: BridgeStatus;
      substatus?: string;
      lifiExplorerLink?: string;
      receiving?: { txHash?: string };
    }>(`${BASE_URL}/status?${query}`, { provider: 'LI.FI', headers: headers() });

    return {
      status: body.status,
      ...(body.substatus ? { substatus: body.substatus } : {}),
      ...(body.lifiExplorerLink ? { explorerLink: body.lifiExplorerLink } : {}),
      ...(body.receiving?.txHash ? { receivingTxHash: body.receiving.txHash } : {}),
    };
  } catch (cause) {
    // An unknown hash comes back as an error body, not a 200 with NOT_FOUND.
    if (cause instanceof ProviderError && cause.status === 404) return { status: 'NOT_FOUND' };
    throw cause;
  }
}

function sumUsd(costs: { amountUSD?: string }[] | undefined): number | undefined {
  if (!costs || costs.length === 0) return undefined;
  const total = costs.reduce((sum, cost) => sum + (Number(cost.amountUSD) || 0), 0);
  return total > 0 ? total : undefined;
}
