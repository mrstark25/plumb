import type { Address } from 'viem';
import { chainName } from '@/lib/chains';
import { formatTokenAmount, formatUsd } from '@/lib/format';
import { readPortfolioSnapshot, type PortfolioSnapshot } from '@/lib/portfolio/snapshot';

/** How many holdings and positions the model is told about by name. */
const PROSE_LIMIT = 8;

export interface PortfolioResult {
  readonly snapshot: PortfolioSnapshot;
  /** A compact rendering for the model to reason over. */
  readonly summary: string;
}

/**
 * The whole picture: wallet balances, Morpho vaults, Sky savings and Aave.
 *
 * Returns both a snapshot and prose, because the two audiences want different
 * things. The panel is for the user and can afford every row; the summary is
 * for the model, which needs enough to size a trade or answer "what should I
 * do with this?" without spending the request's token budget on a table it
 * will only repeat back.
 */
export async function buildPortfolio(wallet: Address): Promise<PortfolioResult> {
  const snapshot = await readPortfolioSnapshot(wallet);
  return { snapshot, summary: summarise(snapshot) };
}

export function summarise(snapshot: PortfolioSnapshot): string {
  const { totals, holdings, positions, aave } = snapshot;

  if (holdings.length === 0 && positions.length === 0 && aave.length === 0) {
    return 'This wallet holds none of the tokens in the registry and has no Morpho, Sky or Aave positions.';
  }

  const lines: string[] = [`Net worth ${formatUsd(totals.netWorthUsd)}.`];

  const move =
    totals.change24hUsd !== undefined && totals.change24hPct !== undefined
      ? ` (24h ${totals.change24hUsd >= 0 ? '+' : ''}${totals.change24hPct.toFixed(2)}%)`
      : '';
  lines.push(`Wallet ${formatUsd(totals.walletUsd)}${move}.`);

  if (totals.earningUsd > 0) {
    lines.push(
      `Earning ${formatUsd(totals.earningUsd)}, projected ${formatUsd(totals.projectedYearlyUsd)}/yr at current rates.`,
    );
  }

  const byValue = [...holdings].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  for (const holding of byValue.slice(0, PROSE_LIMIT)) {
    const usd = holding.usd === undefined ? 'unpriced' : formatUsd(holding.usd);
    lines.push(
      `- ${formatTokenAmount(BigInt(holding.amount), holding.decimals)} ${holding.symbol} on ${chainName(holding.chainId)} (${usd})`,
    );
  }
  if (byValue.length > PROSE_LIMIT) {
    lines.push(`- and ${byValue.length - PROSE_LIMIT} smaller holdings`);
  }

  for (const position of positions.slice(0, PROSE_LIMIT)) {
    const usd = position.usd === undefined ? 'unpriced' : formatUsd(position.usd);
    lines.push(
      `- ${position.protocol}: ${position.name}, ${usd} at ${position.apyPct.toFixed(2)}% APY`,
    );
  }

  for (const account of aave) {
    const health =
      account.healthFactor === null
        ? 'no debt'
        : `health factor ${account.healthFactor.toFixed(2)}`;
    lines.push(
      `- Aave on ${chainName(account.chainId)}: supplied ${formatUsd(account.suppliedUsd)}, borrowed ${formatUsd(account.borrowedUsd)}, ${health}`,
    );
  }

  if (totals.dustCount > 0) {
    lines.push(`${totals.dustCount} dust position(s) under a cent are hidden and excluded.`);
  }

  if (totals.unpricedCount > 0) {
    lines.push(
      `${totals.unpricedCount} holding(s) could not be priced; they are excluded from every total above.`,
    );
  }

  /*
   * The model is told plainly what it does not have. Left unsaid, it will
   * cheerfully answer "how am I doing?" with a profit figure derived from
   * nothing — the failure mode this whole app is built to avoid.
   */
  lines.push(
    'No cost basis is available, so state 24h movement and yield only. Never state profit, loss or return since purchase.',
  );

  return lines.join('\n');
}
