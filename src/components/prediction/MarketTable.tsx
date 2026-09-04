'use client';

import { formatCompactUsd } from '@/lib/format';
import type { PredictionMarket } from '@/lib/providers/polymarket';
import './prediction.css';

interface MarketTableProps {
  readonly title: string;
  readonly markets: readonly PredictionMarket[];
}

/**
 * Prediction markets, led by the implied probability of each outcome — that is
 * the number people come for, and a bare price in cents obscures it.
 */
export function MarketTable({ title, markets }: MarketTableProps) {
  if (markets.length === 0) return null;

  return (
    <section className="market-panel" aria-label={title}>
      <header className="market-head">
        <h3>{title}</h3>
        <span className="market-source">Polymarket · live</span>
      </header>

      <ul className="market-list">
        {markets.map((market) => (
          <li key={market.conditionId} className="market-row">
            <div className="market-question">
              <a href={market.url} target="_blank" rel="noreferrer noopener">
                {market.question}
              </a>
              <span className="market-meta">
                <span className="num">{formatCompactUsd(market.volumeUsd)}</span> volume
                {market.endDate && <> · closes {formatEndDate(market.endDate)}</>}
                {!market.isAcceptingOrders && <span className="tag tag--paused">Not trading</span>}
              </span>
            </div>

            <ul className="market-outcomes">
              {[...market.outcomes]
                .sort((a, b) => b.price - a.price)
                .slice(0, 4)
                .map((outcome) => (
                  <li key={outcome.name} className="market-outcome">
                    <span className="outcome-name">{outcome.name}</span>
                    <span className="outcome-odds num">{formatOdds(outcome.price)}</span>
                    {/* The bar makes relative confidence readable without reading. */}
                    <span
                      className="outcome-bar"
                      style={{ '--fill': `${Math.min(100, outcome.price * 100)}%` } as React.CSSProperties}
                      aria-hidden="true"
                    />
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ul>

      <footer className="market-foot">
        Prices are what the market is paying, not a forecast — they move with
        sentiment and can be thin in low-volume markets.
      </footer>
    </section>
  );
}

/**
 * Implied probability.
 *
 * Rounded to whole percent, except near the extremes where that would erase
 * the distinction: a 0.4% chance is not "0%", and a 99.6% chance is not
 * certainty. Outcomes need not sum to 100 — the bid/ask spread is real, and
 * flattening it would misstate the market.
 */
function formatOdds(price: number): string {
  const pct = price * 100;
  if (!Number.isFinite(pct)) return '—';
  if (pct > 0 && pct < 1) return '<1%';
  if (pct > 99 && pct < 100) return '>99%';
  return `${Math.round(pct)}%`;
}

function formatEndDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
