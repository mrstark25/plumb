import type { TxRequest } from '@/types/tx';

/** What every bridge venue must produce, whatever its native response looks like. */
export interface BridgeQuoteResult {
  readonly provider: string;
  /** The underlying bridge, e.g. "Across", "Eco". Shown to the user. */
  readonly toolName: string;
  /** Expected output on the destination chain, base units. */
  readonly toAmount: string;
  readonly toAmountMin: string;
  readonly fromAmountUsd?: number;
  readonly toAmountUsd?: number;
  readonly executionSeconds: number;
  readonly gasUsd?: number;
  readonly bridgeFeeUsd?: number;
  /** Some tokens (USDT) need an existing allowance zeroed first. */
  readonly cancelTx?: TxRequest;
  readonly approvalTx?: TxRequest;
  readonly bridgeTx: TxRequest;
}

export interface BridgeQuoteParams {
  readonly fromChainId: number;
  readonly toChainId: number;
  readonly fromToken: `0x${string}`;
  readonly toToken: `0x${string}`;
  readonly fromTokenSymbol: string;
  /** Base units. */
  readonly fromAmount: string;
  readonly fromAddress: `0x${string}`;
  readonly toAddress: `0x${string}`;
  readonly slippageBps: number;
}
