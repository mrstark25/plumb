'use client';

import { formatCompactUsd, formatPercent } from '@/lib/format';
import type { CoinPrice } from '@/lib/providers/coingecko';
import './price.css';

interface PriceTableProps {
  readonly title: string;
  readonly prices: readonly CoinPrice[];
  readonly source?: string;
}

/**
 * Spot prices. A single asset gets a headline treatment because that is the
 * whole answer to "what's ETH at?"; several get a table so they compare down
 * the column.
 */
export function PriceTable({ title, prices, source = 'CoinGecko' }: PriceTableProps) {
  if (prices.length === 0) return null;
  const single = prices.length === 1 ? prices[0] : undefined;

  return (
    <section className="price-panel" aria-label={title}>
      <header className="price-head">
        <h3>{title}</h3>
        <span className="price-source">{source} · live</span>
      </header>

      {single ? (
        <div className="price-hero">
          <span className="price-hero-symbol">{single.symbol}</span>
          <span className="price-hero-value num">{formatPrice(single.usd)}</span>
          <Change value={single.change24hPct} />
          {single.marketCapUsd !== null && (
            <span className="price-hero-cap num">
              {formatCompactUsd(single.marketCapUsd)} market cap
            </span>
          )}
        </div>
      ) : (
        <div className="price-scroll">
          <table className="price-table">
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col" className="col-num">Price</th>
                <th scope="col" className="col-num">24h</th>
                <th scope="col" className="col-num">Market cap</th>
              </tr>
            </thead>
            <tbody>
              {prices.map((price) => (
                <tr key={price.id}>
                  <th scope="row" className="price-symbol">{price.symbol}</th>
                  <td className="col-num num">{formatPrice(price.usd)}</td>
                  <td className="col-num"><Change value={price.change24hPct} /></td>
                  <td className="col-num num price-cap">
                    {price.marketCapUsd !== null ? formatCompactUsd(price.marketCapUsd) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="price-change is-flat num">—</span>;

  const direction = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  const sign = value > 0 ? '+' : '';
  return (
    <span className={`price-change is-${direction} num`}>
      {sign}
      {formatPercent(value)}
    </span>
  );
}

/**
 * Precision scales to magnitude: a sub-cent token needs more decimals than
 * bitcoin, and rounding one to two places would show it as $0.00.
 */
function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const digits = value >= 1000 ? 0 : value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}
