import type { TxRequest } from '@/types/tx';

/** What every swap venue must produce, whatever its native response looks like. */
export interface SwapQuoteResult {
  readonly provider: string;
  /** Human-readable route, e.g. "Uniswap v3 · ETH → USDC". */
  readonly route: string;
  /** Expected output, base units. */
  readonly toAmount: string;
  /** Guaranteed output after slippage, base units. */
  readonly minToAmount: string;
  readonly priceImpactPct?: number;
  readonly gasUsd?: number;
  /** Some tokens (USDT) require zeroing an existing allowance first. */
  readonly cancelTx?: TxRequest;
  readonly approvalTx?: TxRequest;
  readonly swapTx: TxRequest;
}

export interface SwapQuoteParams {
  readonly chainId: number;
  readonly tokenIn: `0x${string}`;
  readonly tokenOut: `0x${string}`;
  readonly tokenInDecimals: number;
  readonly tokenInSymbol: string;
  /** Base units. */
  readonly amountIn: string;
  readonly swapper: `0x${string}`;
  readonly slippageBps: number;
}
