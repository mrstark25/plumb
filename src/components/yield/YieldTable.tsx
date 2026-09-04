'use client';

import { formatCompactUsd, formatPercent, formatUsd } from '@/lib/format';
import type { YieldOpportunity } from '@/lib/providers/defillama';
import './yield.css';

interface YieldTableProps {
  readonly title: string;
  readonly pools: readonly YieldOpportunity[];
}

/**
 * A real table, because this is tabular data and people compare down columns.
 * Numerals are tabular and right-aligned so magnitudes line up on sight.
 */
export function YieldTable({ title, pools }: YieldTableProps) {
  if (pools.length === 0) return null;

  const showsProjection = pools.some((p) => p.projectedYearlyUsd !== undefined);

  return (
    <section className="yield-panel" aria-label={title}>
      <header className="yield-head">
        <h3>{title}</h3>
        <span className="yield-source">DefiLlama · live</span>
      </header>

      <div className="yield-scroll">
        <table className="yield-table">
          <thead>
            <tr>
              <th scope="col">Pool</th>
              <th scope="col" className="col-num">APY</th>
              <th scope="col" className="col-num">TVL</th>
              {showsProjection && <th scope="col" className="col-num">Est. / yr</th>}
              <th scope="col">Risk</th>
            </tr>
          </thead>
          <tbody>
            {pools.map((pool) => (
              <tr key={pool.id}>
                <th scope="row">
                  <span className="pool-symbol">{pool.symbol}</span>
                  <span className="pool-venue">
                    {pool.project} · {pool.chain}
                  </span>
                </th>

                <td className="col-num">
                  <span className="num apy">{formatPercent(pool.apy)}</span>
                  {pool.apyReward !== null && pool.apyReward > 0 && (
                    <span className="apy-split num">
                      {formatPercent(pool.apyBase ?? 0, 1)} base
                    </span>
                  )}
                </td>

                <td className="col-num num tvl">{formatCompactUsd(pool.tvlUsd)}</td>

                {showsProjection && (
                  <td className="col-num num projection">
                    {pool.projectedYearlyUsd !== undefined
                      ? formatUsd(pool.projectedYearlyUsd)
                      : '—'}
                  </td>
                )}

                <td>
                  <span className="tags">
                    {pool.isStablecoin && <span className="tag tag--stable">Stable</span>}
                    {pool.ilRisk === 'yes' && <span className="tag tag--il">IL</span>}
                    {pool.apyReward !== null && pool.apyReward > 0 && (
                      <span className="tag tag--incentive">Incentivised</span>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="yield-foot">
        APY is variable and backward-looking. Incentive rewards can end without
        notice, and TVL is not a safety guarantee.
      </footer>
    </section>
  );
}
