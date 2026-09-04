import type { Address } from 'viem';
import { CHAIN_IDS, type SupportedChainId } from '@/lib/chains';
import { knownTokens } from '@/lib/tokens';
import { readBalance } from '@/lib/erc20';
import { getMarketPrices } from '@/lib/providers/coingecko';
import { getUsdPrice } from '@/lib/providers/prices';
import { readAllAaveAccounts, type AaveAccount } from '@/lib/providers/aave';
import { readAllMorphoPositions, type MorphoPosition } from '@/lib/providers/morpho-positions';
import { readSkyPosition, type SkyPosition } from '@/lib/providers/sky';

export type ProtocolName = 'Morpho' | 'Sky' | 'Aave';

/**
 * Below this, a row costs more attention than it carries information.
 *
 * Real wallets accumulate dust — a test deposit, a leftover fraction after an
 * exit, an airdrop nobody claimed. An address checked during development held
 * 27 Morpho positions, of which most were worth under a cent; listing them all
 * would bury the three that matter. Anything dropped is counted and disclosed,
 * and an *unpriced* holding is never treated as dust: not knowing a value is
 * not the same as knowing it is negligible.
 */
const DUST_USD = 0.01;

function isDust(usd: number | undefined): boolean {
  return usd !== undefined && usd < DUST_USD;
}

export interface Holding {
  readonly chainId: SupportedChainId;
  readonly symbol: string;
  readonly amount: string;
  readonly decimals: number;
  readonly usd: number | undefined;
  /** Null when the price source reports no 24h figure, as DefiLlama does. */
  readonly change24hPct: number | null;
}

export interface EarnPosition {
  readonly protocol: ProtocolName;
  readonly chainId: SupportedChainId;
  readonly name: string;
  readonly assetSymbol: string;
  readonly amount: string;
  readonly decimals: number;
  readonly usd: number | undefined;
  readonly apyPct: number;
  /** What that APY is worth over a year at the current size. */
  readonly projectedYearlyUsd: number | undefined;
}

export interface PortfolioTotals {
  readonly walletUsd: number;
  readonly earningUsd: number;
  readonly suppliedUsd: number;
  readonly borrowedUsd: number;
  /** Wallet + earning + Aave net. What the account is worth right now. */
  readonly netWorthUsd: number;
  /** Movement of the priced wallet holdings over 24h, in dollars. */
  readonly change24hUsd: number | undefined;
  readonly change24hPct: number | undefined;
  readonly projectedYearlyUsd: number;
  /**
   * Value this app could not price, in dollars it does know about — always
   * zero here by construction, so the count is what matters.
   */
  readonly unpricedCount: number;
  /** Rows dropped as dust, disclosed so the totals are not silently short. */
  readonly dustCount: number;
}

export interface PortfolioSnapshot {
  readonly address: Address;
  readonly holdings: readonly Holding[];
  readonly positions: readonly EarnPosition[];
  readonly aave: readonly AaveAccount[];
  readonly totals: PortfolioTotals;
  readonly asOf: number;
  /**
   * Whether a cost basis was available for any of this.
   *
   * Always false today, and stated rather than omitted. Profit and loss needs
   * to know what was paid, which needs transaction history this app does not
   * have — there is no account system and no indexer behind it yet. Showing a
   * number derived from anything else would be inventing one.
   */
  readonly hasCostBasis: false;
}

/**
 * Everything an address holds, in one pass.
 *
 * Wallet balances, Morpho vaults, Sky savings and Aave are read in parallel
 * and each is allowed to fail alone: a portfolio missing one protocol is
 * useful, and a portfolio that renders nothing because one indexer is down is
 * not. Balance reads within a chain are batched by viem's multicall.
 */
export async function readPortfolioSnapshot(address: Address): Promise<PortfolioSnapshot> {
  const [holdings, morpho, sky, aave] = await Promise.all([
    readHoldings(address),
    readAllMorphoPositions(address).catch(() => [] as MorphoPosition[]),
    readSkyPosition(address).catch(() => null),
    readAllAaveAccounts(address).catch(() => [] as AaveAccount[]),
  ]);

  const allPositions = [...morphoPositions(morpho), ...skyPositions(sky)];

  // Dropped from the totals as well as the table: hiding a row while still
  // counting it produces a panel whose numbers do not add up.
  const positions = allPositions.filter((position) => !isDust(position.usd));
  const visibleHoldings = holdings.filter((holding) => !isDust(holding.usd));
  const dustCount =
    allPositions.length - positions.length + (holdings.length - visibleHoldings.length);

  return {
    address,
    holdings: visibleHoldings,
    positions,
    aave,
    totals: { ...totalsFor(visibleHoldings, positions, aave), dustCount },
    asOf: Date.now(),
    hasCostBasis: false,
  };
}

/** Wallet balances for the vetted registry, across every supported chain. */
async function readHoldings(owner: Address): Promise<Holding[]> {
  const perChain = await Promise.all(
    CHAIN_IDS.map(async (chainId) => {
      const tokens = knownTokens(chainId);
      const balances = await Promise.all(
        tokens.map((token) =>
          readBalance({ chainId, token: token.address, owner }).catch(() => 0n),
        ),
      );
      return tokens
        .map((token, index) => ({ token, amount: balances[index] ?? 0n }))
        .filter((entry) => entry.amount > 0n);
    }),
  );

  const found = perChain.flat();
  if (found.length === 0) return [];

  /*
   * One market call for every symbol at once, rather than a price lookup per
   * holding. It is fewer requests against a tier that rate-limits readily, and
   * it is the only source here that carries a 24h change — which is the
   * difference between a list of balances and a portfolio.
   */
  const symbols = [...new Set(found.map((entry) => entry.token.symbol))];
  const market = await getMarketPrices(symbols).catch(() => ({ prices: [], unknown: symbols }));
  const bySymbol = new Map(market.prices.map((price) => [price.symbol.toUpperCase(), price]));

  return Promise.all(
    found.map(async ({ token, amount }) => {
      const quoted = bySymbol.get(token.symbol.toUpperCase());
      const units = Number(amount) / 10 ** token.decimals;

      // Anything the market endpoint does not know still gets a price attempt
      // through the contract-level path, which reaches further down the tail.
      const usdPrice =
        quoted?.usd ?? (await getUsdPrice(token.chainId, token.address).catch(() => undefined));

      return {
        chainId: token.chainId,
        symbol: token.symbol,
        amount: amount.toString(),
        decimals: token.decimals,
        usd: usdPrice === undefined ? undefined : units * usdPrice,
        change24hPct: quoted?.change24hPct ?? null,
      } satisfies Holding;
    }),
  );
}

function morphoPositions(positions: readonly MorphoPosition[]): EarnPosition[] {
  return positions.map((position) => ({
    protocol: 'Morpho' as const,
    chainId: position.chainId,
    name: position.name,
    assetSymbol: position.assetSymbol,
    amount: position.assets.toString(),
    decimals: position.decimals,
    usd: position.assetsUsd,
    apyPct: position.apyPct,
    projectedYearlyUsd:
      position.assetsUsd === undefined ? undefined : position.assetsUsd * (position.apyPct / 100),
  }));
}

function skyPositions(position: SkyPosition | null): EarnPosition[] {
  if (position === null) return [];
  // USDS is a dollar stablecoin, so its unit count is its dollar value. This
  // is the one place that equivalence is assumed, and it is assumed knowingly.
  const usd = Number(position.assets) / 10 ** position.decimals;

  return [
    {
      protocol: 'Sky' as const,
      chainId: position.chainId,
      name: 'Sky Savings Rate',
      assetSymbol: position.assetSymbol,
      amount: position.assets.toString(),
      decimals: position.decimals,
      usd,
      apyPct: position.apyPct,
      projectedYearlyUsd: usd * (position.apyPct / 100),
    },
  ];
}

/**
 * Rolls everything into the figures at the top of the panel.
 *
 * The 24h move is computed only over holdings that have both a price and a
 * change, and the percentage is taken against that same subset — mixing a
 * partial dollar move into a whole-portfolio denominator would understate it
 * and look like a calmer day than it was.
 */
export function totalsFor(
  holdings: readonly Holding[],
  positions: readonly EarnPosition[],
  aave: readonly AaveAccount[],
): PortfolioTotals {
  const walletUsd = sum(holdings.map((holding) => holding.usd));
  const earningUsd = sum(positions.map((position) => position.usd));
  const suppliedUsd = aave.reduce((total, account) => total + account.suppliedUsd, 0);
  const borrowedUsd = aave.reduce((total, account) => total + account.borrowedUsd, 0);

  /*
   * A 24h change is measured against yesterday's value, not today's. Holding
   * $110 after a 10% rise means it was $100 and moved $10 — multiplying the
   * current value by the percentage would report $11 and overstate every
   * gain, and understate every loss, by the size of the move itself.
   */
  const movers = holdings.filter(
    (holding): holding is Holding & { usd: number; change24hPct: number } =>
      holding.usd !== undefined && holding.change24hPct !== null && holding.change24hPct > -100,
  );
  const previous = movers.reduce(
    (total, holding) => total + holding.usd / (1 + holding.change24hPct / 100),
    0,
  );
  const change24hUsd = movers.reduce((total, holding) => total + holding.usd, 0) - previous;

  return {
    walletUsd,
    earningUsd,
    suppliedUsd,
    borrowedUsd,
    netWorthUsd: walletUsd + earningUsd + (suppliedUsd - borrowedUsd),
    change24hUsd: movers.length > 0 ? change24hUsd : undefined,
    change24hPct: movers.length > 0 && previous > 0 ? (change24hUsd / previous) * 100 : undefined,
    projectedYearlyUsd: sum(positions.map((position) => position.projectedYearlyUsd)),
    unpricedCount: holdings.filter((holding) => holding.usd === undefined).length,
    dustCount: 0,
  };
}

function sum(values: readonly (number | undefined)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
