import { findYieldOpportunities, type YieldOpportunity } from '@/lib/providers/defillama';

export interface YieldArgs {
  amountUsd?: number;
  stablecoinsOnly?: boolean;
  asset?: string;
  riskTolerance?: 'low' | 'medium' | 'high';
  limit?: number;
}

/**
 * Risk tolerance is expressed as filter thresholds rather than a vibe: what
 * changes is the minimum TVL we will surface and the APY above which we assume
 * the number is unsustainable.
 */
const RISK_PROFILES = {
  low: { minTvlUsd: 50_000_000, maxApy: 25 },
  medium: { minTvlUsd: 5_000_000, maxApy: 80 },
  high: { minTvlUsd: 500_000, maxApy: 400 },
} as const;

export interface YieldResult {
  readonly pools: YieldOpportunity[];
  readonly title: string;
}

export async function findYields(args: YieldArgs): Promise<YieldResult> {
  const profile = RISK_PROFILES[args.riskTolerance ?? 'medium'];

  const pools = await findYieldOpportunities({
    ...(args.amountUsd !== undefined ? { amountUsd: args.amountUsd } : {}),
    ...(args.stablecoinsOnly !== undefined ? { stablecoinsOnly: args.stablecoinsOnly } : {}),
    ...(args.asset ? { symbol: args.asset } : {}),
    minTvlUsd: profile.minTvlUsd,
    maxApy: profile.maxApy,
    limit: args.limit ?? 6,
  });

  return { pools, title: buildTitle(args) };
}

function buildTitle(args: YieldArgs): string {
  const parts: string[] = [];
  if (args.stablecoinsOnly) parts.push('Stablecoin');
  if (args.asset) parts.push(args.asset.toUpperCase());
  parts.push('yield opportunities');
  if (args.amountUsd) parts.push(`for $${args.amountUsd.toLocaleString('en-US')}`);

  const title = parts.join(' ');
  return title.charAt(0).toUpperCase() + title.slice(1);
}
