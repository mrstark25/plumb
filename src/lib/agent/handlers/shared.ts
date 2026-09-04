import type { SwapQuoteResult } from '@/lib/providers/swap-types';

/** 0.5% — the same default the major front-ends use. */
export const DEFAULT_SLIPPAGE_BPS = 50;

/**
 * Quotes go stale quickly. Two minutes is long enough to read the card and
 * sign, short enough that the price cannot drift far before it does.
 */
export const QUOTE_TTL_MS = 120_000;

/**
 * Transfers are not quoted, so nothing goes stale: the amount and destination
 * are exactly what the user asked for. They get a longer window so the card
 * does not expire while someone is checking an address character by character.
 */
export const TRANSFER_TTL_MS = 900_000;

/**
 * Bounds whatever the model asked for. A floor of 0.1% avoids quotes that can
 * never fill; a ceiling of 5% is where a swap stops being a trade and becomes
 * an invitation to be sandwiched.
 */
export function clampSlippage(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_SLIPPAGE_BPS;
  return Math.min(Math.max(Math.round(requested), 10), 500);
}

export function warningsForSwap(input: {
  quote: SwapQuoteResult;
  slippageBps: number;
  fromSymbol: string;
}): string[] {
  const warnings: string[] = [];
  const { quote, slippageBps } = input;

  if (quote.priceImpactPct !== undefined && quote.priceImpactPct >= 1) {
    warnings.push(
      `Price impact is ${quote.priceImpactPct.toFixed(2)}% — this trade is large relative to the pool. Splitting it into smaller swaps would cost less.`,
    );
  }
  if (slippageBps > 100) {
    warnings.push(
      `Slippage tolerance is set to ${(slippageBps / 100).toFixed(1)}%. Anything above 1% leaves real room for an MEV sandwich.`,
    );
  }
  if (quote.approvalTx) {
    warnings.push(
      `You will sign two transactions: an approval for ${input.fromSymbol}, then the swap itself.`,
    );
  }
  return warnings;
}

export function warningsForBridge(input: {
  executionSeconds: number;
  toolName: string;
  slippageBps: number;
  hasApproval: boolean;
  isSelfCustody: boolean;
  recipient: string;
}): string[] {
  const warnings: string[] = [];

  // Leads the list deliberately: sending to an address that is not the user's
  // own is the single most expensive thing that can go wrong here, and it is
  // the outcome a prompt injection would be aiming for.
  if (!input.isSelfCustody) {
    warnings.push(
      `These funds will arrive at ${input.recipient}, which is NOT your connected wallet. If you did not deliberately ask to send to that address, reject this and start over.`,
    );
  }

  warnings.push(
    `Funds route through ${input.toolName}. Bridges are the single most exploited component in DeFi — only bridge what you can afford to have stuck.`,
  );

  if (input.executionSeconds > 900) {
    warnings.push(
      'This route can take more than 15 minutes. The destination amount is not locked in until it settles.',
    );
  }
  if (input.hasApproval) {
    warnings.push('You will sign an approval before the bridge transaction itself.');
  }
  return warnings;
}
