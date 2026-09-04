'use client';

import { chainName } from '@/lib/chains';
import { formatPercent, formatTokenAmount, formatUsd } from '@/lib/format';
import { healthBand, type AaveAccount } from '@/lib/providers/aave';
import type { EarnPosition, Holding, PortfolioSnapshot } from '@/lib/portfolio/snapshot';
import './portfolio.css';

/**
 * The portfolio, as one instrument rather than a wall of cards.
 *
 * Three bands, in the order the questions get asked: what am I worth, where is
 * it, and what is it doing. Net worth is the only figure at display scale —
 * everything else is deliberately quieter, because a screen where six numbers
 * are all shouting has no hierarchy at all.
 */
export function PortfolioPanel({ snapshot }: { snapshot: PortfolioSnapshot }) {
  const { totals, holdings, positions, aave } = snapshot;
  const isEmpty = holdings.length === 0 && positions.length === 0 && aave.length === 0;

  if (isEmpty) {
    return (
      <section className="pf" aria-label="Portfolio">
        <p className="pf-empty">
          Nothing here yet — no tracked tokens, and no Morpho, Sky or Aave positions on
          Ethereum, Base, Arbitrum or Polygon.
        </p>
      </section>
    );
  }

  const allocation = buildAllocation(holdings, positions, aave);

  return (
    <section className="pf" aria-label="Portfolio">
      <header className="pf-head">
        <div className="pf-worth">
          <span className="pf-eyebrow">Net worth</span>
          <strong className="pf-worth-value num">{formatUsd(totals.netWorthUsd)}</strong>
          <Change usd={totals.change24hUsd} pct={totals.change24hPct} />
        </div>

        <dl className="pf-stats">
          <Stat label="Wallet" value={formatUsd(totals.walletUsd)} />
          <Stat label="Earning" value={formatUsd(totals.earningUsd)} />
          {totals.borrowedUsd > 0 && (
            <Stat label="Borrowed" value={formatUsd(totals.borrowedUsd)} tone="down" />
          )}
          {totals.projectedYearlyUsd > 0 && (
            <Stat
              label="Yield / yr"
              value={formatUsd(totals.projectedYearlyUsd)}
              tone="up"
              hint="At today's rates, which are variable."
            />
          )}
        </dl>
      </header>

      {allocation.length > 1 && <Allocation slices={allocation} total={totals.netWorthUsd} />}

      {positions.length > 0 && (
        <Band title="Earning" note="Deposited and accruing">
          <table className="pf-table">
            <thead>
              <tr>
                <th scope="col">Position</th>
                <th scope="col">Network</th>
                <th scope="col" className="col-num">APY</th>
                <th scope="col" className="col-num">Value</th>
              </tr>
            </thead>
            <tbody>
              {[...positions]
                .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
                .map((position, index) => (
                  <PositionRow key={`${position.protocol}-${index}`} position={position} />
                ))}
            </tbody>
          </table>
        </Band>
      )}

      {aave.length > 0 && (
        <Band title="Borrowing" note="Aave v3">
          <div className="pf-aave">
            {aave.map((account) => (
              <AaveCard key={account.chainId} account={account} />
            ))}
          </div>
        </Band>
      )}

      {holdings.length > 0 && (
        <Band title="Wallet" note={`${holdings.length} asset${holdings.length === 1 ? '' : 's'}`}>
          <table className="pf-table">
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col">Network</th>
                <th scope="col" className="col-num">Balance</th>
                <th scope="col" className="col-num">24h</th>
                <th scope="col" className="col-num">Value</th>
              </tr>
            </thead>
            <tbody>
              {[...holdings]
                .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
                .map((holding) => (
                  <HoldingRow
                    key={`${holding.chainId}-${holding.symbol}`}
                    holding={holding}
                  />
                ))}
            </tbody>
          </table>
        </Band>
      )}

      <footer className="pf-foot">
        {/*
         * Said plainly rather than omitted. Profit and loss needs to know what
         * was paid, which needs transaction history this app does not keep —
         * and a portfolio screen with no PnL invites the assumption that it is
         * flat, which would be worse than saying nothing.
         */}
        <p>
          <strong>No profit-and-loss figure.</strong> That needs a cost basis — what you
          paid and when — which means transaction history. Plumb keeps none: there is
          no account and no indexer behind it. Everything above is a live reading, and
          the 24h move covers priced wallet holdings only.
        </p>
        {totals.dustCount > 0 && (
          <p className="pf-unpriced">
            {totals.dustCount} position{totals.dustCount === 1 ? '' : 's'} worth under a cent
            {totals.dustCount === 1 ? ' is' : ' are'} hidden, and excluded from the totals.
          </p>
        )}
        {totals.unpricedCount > 0 && (
          <p className="pf-unpriced">
            {totals.unpricedCount} holding{totals.unpricedCount === 1 ? '' : 's'} could not be
            priced and {totals.unpricedCount === 1 ? 'is' : 'are'} excluded from every total.
          </p>
        )}
      </footer>
    </section>
  );
}

/**
 * One labelled section. Tables scroll inside their own container so a narrow
 * viewport never makes the whole page scroll sideways.
 */
function Band({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="pf-band">
      <header className="pf-band-head">
        <h4>{title}</h4>
        <span className="pf-band-note">{note}</span>
      </header>
      <div className="pf-scroll">{children}</div>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down';
  hint?: string;
}) {
  return (
    <div className="pf-stat">
      <dt>{label}</dt>
      <dd className={`num${tone ? ` is-${tone}` : ''}`} title={hint}>
        {value}
      </dd>
    </div>
  );
}

function Change({ usd, pct }: { usd: number | undefined; pct: number | undefined }) {
  if (usd === undefined || pct === undefined) {
    return <span className="pf-change is-flat">24h unavailable</span>;
  }
  const direction = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const sign = usd >= 0 ? '+' : '−';
  return (
    <span className={`pf-change is-${direction} num`}>
      {sign}
      {formatUsd(Math.abs(usd)).replace('$', '$')} · {sign}
      {formatPercent(Math.abs(pct))}
      <span className="pf-change-window"> 24h</span>
    </span>
  );
}

/**
 * A single proportional bar rather than a donut.
 *
 * Allocation is one question — how is this split — and a bar answers it in the
 * width of the panel without a legend, a hover target, or a colour wheel that
 * would fight the rest of the design system for attention.
 */
function Allocation({
  slices,
  total,
}: {
  slices: readonly { label: string; usd: number; tone: string }[];
  total: number;
}) {
  if (total <= 0) return null;

  return (
    <div className="pf-alloc">
      <div className="pf-alloc-bar" role="img" aria-label={describeAllocation(slices, total)}>
        {slices.map((slice) => (
          <span
            key={slice.label}
            className={`pf-alloc-slice is-${slice.tone}`}
            style={{ flexGrow: Math.max(slice.usd, 0) }}
          />
        ))}
      </div>
      <ul className="pf-alloc-key">
        {slices.map((slice) => (
          <li key={slice.label}>
            <span className={`pf-dot is-${slice.tone}`} aria-hidden="true" />
            {slice.label}
            <span className="num pf-alloc-pct">
              {formatPercent((slice.usd / total) * 100, 0)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PositionRow({ position }: { position: EarnPosition }) {
  return (
    <tr>
      <th scope="row">
        <span className="pf-protocol">{position.protocol}</span>
        <span className="pf-name">{position.name}</span>
      </th>
      <td className="pf-muted">{chainName(position.chainId)}</td>
      <td className="col-num num is-up">{formatPercent(position.apyPct)}</td>
      <td className="col-num num">
        {position.usd === undefined
          ? `${formatTokenAmount(BigInt(position.amount), position.decimals)} ${position.assetSymbol}`
          : formatUsd(position.usd)}
      </td>
    </tr>
  );
}

function HoldingRow({ holding }: { holding: Holding }) {
  const direction =
    holding.change24hPct === null
      ? 'flat'
      : holding.change24hPct > 0
        ? 'up'
        : holding.change24hPct < 0
          ? 'down'
          : 'flat';

  return (
    <tr>
      <th scope="row" className="pf-symbol">
        {holding.symbol}
      </th>
      <td className="pf-muted">{chainName(holding.chainId)}</td>
      <td className="col-num num">
        {formatTokenAmount(BigInt(holding.amount), holding.decimals)}
      </td>
      <td className={`col-num num pf-delta is-${direction}`}>
        {holding.change24hPct === null
          ? '—'
          : `${holding.change24hPct > 0 ? '+' : ''}${formatPercent(holding.change24hPct)}`}
      </td>
      <td className="col-num num">
        {holding.usd === undefined ? <span className="pf-muted">unpriced</span> : formatUsd(holding.usd)}
      </td>
    </tr>
  );
}

/**
 * Health factor is the loudest thing on this card, for the same reason the
 * liquidation price is the loudest thing on a perps card: it is the number
 * that decides whether the position survives the week.
 */
function AaveCard({ account }: { account: AaveAccount }) {
  const band = healthBand(account.healthFactor);

  return (
    <article className={`pf-aave-card is-${band}`}>
      <header>
        <span className="pf-eyebrow">Aave v3 · {chainName(account.chainId)}</span>
      </header>
      <dl>
        <div>
          <dt>Supplied</dt>
          <dd className="num">{formatUsd(account.suppliedUsd)}</dd>
        </div>
        <div>
          <dt>Borrowed</dt>
          <dd className="num is-down">{formatUsd(account.borrowedUsd)}</dd>
        </div>
        <div>
          <dt>Net</dt>
          <dd className="num">{formatUsd(account.netUsd)}</dd>
        </div>
      </dl>
      <p className="pf-health">
        {account.healthFactor === null ? (
          <>
            <span className="pf-health-value num">No debt</span>
            <span className="pf-health-note">Nothing here can be liquidated.</span>
          </>
        ) : (
          <>
            <span className="pf-health-value num">{account.healthFactor.toFixed(2)}</span>
            <span className="pf-health-note">
              Health factor. Aave liquidates below 1.00
              {band === 'danger'
                ? ' — this position is close.'
                : band === 'watch'
                  ? ' — a sharp move could reach it.'
                  : '.'}
            </span>
          </>
        )}
      </p>
    </article>
  );
}

/** Wallet / earning / borrowed, as proportions of net worth. */
function buildAllocation(
  holdings: readonly Holding[],
  positions: readonly EarnPosition[],
  aave: readonly AaveAccount[],
): { label: string; usd: number; tone: string }[] {
  const wallet = holdings.reduce((total, holding) => total + (holding.usd ?? 0), 0);
  const earning = positions.reduce((total, position) => total + (position.usd ?? 0), 0);
  const supplied = aave.reduce((total, account) => total + account.suppliedUsd, 0);

  return [
    { label: 'Wallet', usd: wallet, tone: 'wallet' },
    { label: 'Earning', usd: earning, tone: 'earning' },
    { label: 'Aave supplied', usd: supplied, tone: 'supplied' },
  ].filter((slice) => slice.usd > 0);
}

function describeAllocation(
  slices: readonly { label: string; usd: number }[],
  total: number,
): string {
  return slices
    .map((slice) => `${slice.label} ${formatPercent((slice.usd / total) * 100, 0)}`)
    .join(', ');
}
