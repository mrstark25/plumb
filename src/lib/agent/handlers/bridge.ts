import { getAddress, isAddress, type Address } from 'viem';
import { chainName, resolveChain } from '@/lib/chains';
import { formatTokenAmount, parseAmount } from '@/lib/format';
import { readBalance } from '@/lib/erc20';
import { quoteBridge as quoteViaLifi } from '@/lib/providers/lifi';
import { isUniswapConfigured, quoteBridge as quoteViaUniswap } from '@/lib/providers/uniswap';
import type { BridgeQuoteParams, BridgeQuoteResult } from '@/lib/providers/bridge-types';
import type { TxProposal, TxStep } from '@/types/tx';
import { resolveToken } from '../resolve';
import { DEFAULT_SLIPPAGE_BPS, QUOTE_TTL_MS, warningsForBridge } from './shared';

export interface BridgeArgs {
  fromChain: string;
  toChain: string;
  fromToken: string;
  toToken?: string;
  amount: string;
  recipient?: string;
  slippageBps?: number;
}

export async function buildBridgeProposal(
  args: BridgeArgs,
  wallet: Address,
): Promise<TxProposal> {
  const fromChainId = resolveChain(args.fromChain);
  const toChainId = resolveChain(args.toChain);

  if (fromChainId === toChainId) {
    throw new Error(
      'Source and destination chains are the same — you want a swap, not a bridge.',
    );
  }

  const from = await resolveToken(fromChainId, args.fromToken);
  // Bridging keeps the same asset unless the user explicitly asked otherwise.
  const to = await resolveToken(toChainId, args.toToken ?? from.symbol);

  const amountIn = parseAmount(args.amount, from.decimals);
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  const balance = await readBalance({ chainId: fromChainId, token: from.address, owner: wallet });
  if (balance < amountIn) {
    throw new Error(
      `Your ${from.symbol} balance on ${chainName(fromChainId)} is ${formatTokenAmount(balance, from.decimals)} — not enough to bridge ${args.amount}.`,
    );
  }

  const recipient = resolveRecipient(args.recipient, wallet);
  const isSelfCustody = recipient.toLowerCase() === wallet.toLowerCase();

  const quote = await routeBridge({
    fromChainId,
    toChainId,
    fromToken: from.address,
    toToken: to.address,
    fromTokenSymbol: from.symbol,
    fromAmount: amountIn.toString(),
    fromAddress: wallet,
    toAddress: recipient,
    slippageBps,
  });

  const steps: TxStep[] = [];
  if (quote.cancelTx) {
    steps.push({
      id: 'bridge-reset',
      kind: 'approve',
      label: `Reset ${from.symbol} allowance`,
      detail: `${from.symbol} requires clearing an existing allowance first.`,
      execute: { via: 'transaction', tx: quote.cancelTx },
    });
  }
  if (quote.approvalTx) {
    steps.push({
      id: 'bridge-approve',
      kind: 'approve',
      label: `Approve ${from.symbol}`,
      detail: `Lets ${quote.toolName} move exactly ${args.amount} ${from.symbol}.`,
      execute: { via: 'transaction', tx: quote.approvalTx },
    });
  }
  steps.push({
    id: 'bridge-send',
    kind: 'bridge',
    label: `Bridge to ${chainName(toChainId)}`,
    detail: isSelfCustody
      ? `Routed via ${quote.toolName}. Funds arrive at your own address.`
      : `Routed via ${quote.toolName}. Funds arrive at ${recipient} — NOT your wallet.`,
    execute: { via: 'transaction', tx: quote.bridgeTx },
  });

  return {
    id: crypto.randomUUID(),
    kind: 'bridge',
    from: {
      symbol: from.symbol,
      address: from.address,
      chainId: fromChainId,
      decimals: from.decimals,
      amount: amountIn.toString(),
      ...(quote.fromAmountUsd !== undefined ? { amountUsd: quote.fromAmountUsd } : {}),
    },
    to: {
      symbol: to.symbol,
      address: to.address,
      chainId: toChainId,
      decimals: to.decimals,
      amount: quote.toAmount,
      ...(quote.toAmountUsd !== undefined ? { amountUsd: quote.toAmountUsd } : {}),
    },
    recipient,
    isSelfCustody,
    minReceived: quote.toAmountMin,
    slippageBps,
    ...(quote.gasUsd !== undefined || quote.bridgeFeeUsd !== undefined
      ? { estimatedGasUsd: (quote.gasUsd ?? 0) + (quote.bridgeFeeUsd ?? 0) }
      : {}),
    estimatedSeconds: quote.executionSeconds,
    route: `${quote.toolName} · ${chainName(fromChainId)} → ${chainName(toChainId)}`,
    provider: quote.provider,
    steps,
    warnings: warningsForBridge({
      executionSeconds: quote.executionSeconds,
      toolName: quote.toolName,
      slippageBps,
      hasApproval: Boolean(quote.approvalTx),
      isSelfCustody,
      recipient,
    }),
    expiresAt: Date.now() + QUOTE_TTL_MS,
  };
}

/**
 * Uniswap's Trading API bridges through Across without an aggregator's margin,
 * so it prices better than LI.FI on nearly every pair we support — but it only
 * covers assets Uniswap routes, and it always settles to the sender's own
 * address. LI.FI is the coverage fallback: more tokens, more bridges, and the
 * only one of the two that can send to a third-party recipient.
 */
async function routeBridge(params: BridgeQuoteParams): Promise<BridgeQuoteResult> {
  if (!isUniswapConfigured()) return quoteViaLifi(params);
  try {
    return await quoteViaUniswap(params);
  } catch {
    return quoteViaLifi(params);
  }
}

/**
 * The recipient arrives as free-form text in the model's tool call, and the
 * model's context includes third-party strings (pool names, token symbols).
 * A poisoned one could try to redirect a bridge, so the address is validated
 * and checksummed here, and anything that is not the connected wallet is
 * surfaced as an alert on the proposal card rather than buried in prose.
 */
export function resolveRecipient(requested: string | undefined, wallet: Address): Address {
  if (requested === undefined || requested.trim() === '') return wallet;

  const candidate = requested.trim();
  if (!isAddress(candidate)) {
    throw new Error(
      `"${candidate}" is not a valid address, so I will not build a bridge to it. Leave the recipient out to send to your own wallet.`,
    );
  }
  return getAddress(candidate);
}
