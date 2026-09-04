import { getAddress, type Address } from 'viem';
import type { SupportedChainId } from '@/lib/chains';
import { requestJson } from './http';

const BASE_URL = 'https://api.coingecko.com/api/v3';

/**
 * A free Demo key is optional but worth having: the keyless tier is limited
 * to a handful of calls per minute and 429s readily, while a demo key gets a
 * far larger allowance. Get one at coingecko.com/en/developers/dashboard.
 */
function headers(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { 'x-cg-demo-api-key': key } : {};
}

/**
 * The public tier allows only a handful of calls per minute, so responses are
 * cached briefly. Spot prices move far less than that window in practice, and
 * being rate-limited would blank the USD figures on every card.
 */
const CACHE_TTL_MS = 60_000;

/** CoinGecko's own platform slugs for the chains this app supports. */
const PLATFORM_IDS: Record<SupportedChainId, string> = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum-one',
  137: 'polygon-pos',
};

/**
 * Symbol to CoinGecko id, hand-checked.
 *
 * Resolved from a vetted map rather than by searching: dozens of tokens share
 * a ticker, and a search would happily return a scam coin's price for "USDC".
 * Same reasoning as the token registry — never guess an identity from a symbol.
 */
const COIN_IDS: Record<string, string> = {
  BTC: 'bitcoin', WBTC: 'wrapped-bitcoin', CBBTC: 'coinbase-wrapped-btc',
  ETH: 'ethereum', WETH: 'weth', STETH: 'staked-ether', WSTETH: 'wrapped-steth',
  USDC: 'usd-coin', USDT: 'tether', DAI: 'dai', PYUSD: 'paypal-usd', USDE: 'ethena-usde',
  ARB: 'arbitrum', OP: 'optimism', MATIC: 'matic-network', POL: 'polygon-ecosystem-token',
  SOL: 'solana', AVAX: 'avalanche-2', BNB: 'binancecoin', LINK: 'chainlink',
  UNI: 'uniswap', AAVE: 'aave', MORPHO: 'morpho', CRV: 'curve-dao-token',
  LDO: 'lido-dao', MKR: 'maker', SKY: 'sky', PENDLE: 'pendle', ENA: 'ethena',
  DOGE: 'dogecoin', XRP: 'ripple', ADA: 'cardano', SUI: 'sui', TON: 'the-open-network',
};

export interface CoinPrice {
  readonly symbol: string;
  readonly id: string;
  readonly usd: number;
  readonly change24hPct: number | null;
  readonly marketCapUsd: number | null;
  /** Epoch ms of CoinGecko's last update, when reported. */
  readonly updatedAt: number | null;
}

export function knownPriceSymbols(): string[] {
  return Object.keys(COIN_IDS);
}

export function resolveCoinId(symbol: string): string | undefined {
  return COIN_IDS[symbol.trim().toUpperCase()];
}

interface SimplePriceEntry {
  usd?: number;
  usd_24h_change?: number;
  usd_market_cap?: number;
  last_updated_at?: number;
}

const cache = new Map<string, { value: unknown; expiresAt: number }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.value as T;

  const value = await load();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  if (cache.size > 200) {
    for (const [k, entry] of cache) if (Date.now() >= entry.expiresAt) cache.delete(k);
  }
  return value;
}

/**
 * Spot prices for well-known assets by symbol. Unknown symbols are reported
 * back rather than silently dropped, so the caller can say which ones it
 * could not price instead of pretending they do not exist.
 */
export async function getMarketPrices(
  symbols: readonly string[],
): Promise<{ prices: CoinPrice[]; unknown: string[] }> {
  const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()))].filter(Boolean);

  const resolved = wanted
    .map((symbol) => ({ symbol, id: resolveCoinId(symbol) }))
    .filter((entry): entry is { symbol: string; id: string } => entry.id !== undefined);

  const unknown = wanted.filter((symbol) => resolveCoinId(symbol) === undefined);
  if (resolved.length === 0) return { prices: [], unknown };

  const ids = [...new Set(resolved.map((r) => r.id))].sort();
  const body = await cached(`simple:${ids.join(',')}`, () =>
    requestJson<Record<string, SimplePriceEntry>>(
      `${BASE_URL}/simple/price?${new URLSearchParams({
        ids: ids.join(','),
        vs_currencies: 'usd',
        include_24hr_change: 'true',
        include_market_cap: 'true',
        include_last_updated_at: 'true',
      })}`,
      { provider: 'CoinGecko', headers: headers(), timeoutMs: 12_000 },
    ),
  );

  const prices: CoinPrice[] = [];
  for (const { symbol, id } of resolved) {
    const entry = body[id];
    if (!entry || typeof entry.usd !== 'number') {
      unknown.push(symbol);
      continue;
    }
    prices.push({
      symbol,
      id,
      usd: entry.usd,
      change24hPct: typeof entry.usd_24h_change === 'number' ? entry.usd_24h_change : null,
      marketCapUsd: typeof entry.usd_market_cap === 'number' ? entry.usd_market_cap : null,
      updatedAt: typeof entry.last_updated_at === 'number' ? entry.last_updated_at * 1000 : null,
    });
  }

  return { prices, unknown };
}

/**
 * Price for an arbitrary ERC-20 by contract address.
 *
 * Returns undefined rather than throwing: a missing price must degrade to
 * "unknown" on a card, never to a misleading $0.00 or a failed proposal.
 */
export async function getTokenPriceUsd(
  chainId: SupportedChainId,
  token: Address,
): Promise<number | undefined> {
  const platform = PLATFORM_IDS[chainId];
  if (!platform) return undefined;

  const address = getAddress(token);
  try {
    const body = await cached(`token:${platform}:${address}`, () =>
      requestJson<Record<string, SimplePriceEntry>>(
        `${BASE_URL}/simple/token_price/${platform}?${new URLSearchParams({
          contract_addresses: address,
          vs_currencies: 'usd',
        })}`,
        { provider: 'CoinGecko', headers: headers(), timeoutMs: 12_000 },
      ),
    );
    // CoinGecko lower-cases contract addresses in its response keys.
    const price = body[address.toLowerCase()]?.usd;
    return typeof price === 'number' && price > 0 ? price : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fiat currencies CoinGecko will price against.
 *
 * Privy's on-ramp accepts 49; CoinGecko prices 39 of them. The other ten get
 * no rate shown rather than a converted-through-dollars approximation, which
 * would be a made-up number wearing a real one's clothes.
 */
const PRICEABLE_FIAT = new Set([
  'usd', 'eur', 'mxn', 'brl', 'gbp', 'cny', 'jpy', 'inr', 'cad', 'krw', 'aud', 'idr',
  'sar', 'try', 'chf', 'twd', 'sek', 'ngn', 'pln', 'ars', 'aed', 'thb', 'zar', 'dkk',
  'myr', 'sgd', 'php', 'clp', 'bdt', 'vnd', 'czk', 'ils', 'hkd', 'nzd', 'pkr', 'nok',
  'huf', 'uah', 'kwd',
]);

export function isPriceableFiat(currency: string): boolean {
  return PRICEABLE_FIAT.has(currency.trim().toLowerCase());
}

/**
 * What one unit of a token costs in a fiat currency, live.
 *
 * Priced directly against the currency rather than converted through dollars:
 * an app that quotes "≈ ₹83 per $1" from anywhere but a live source is doing
 * the thing this whole codebase refuses to do elsewhere. The real figure moved
 * to ₹94.6 while a remembered one still said ₹83 — a 12% error, on the number
 * someone uses to decide how much to buy.
 *
 * Undefined on any failure. A missing rate is shown as missing.
 */
export async function getFiatPrice(
  symbol: string,
  currency: string,
): Promise<number | undefined> {
  const id = resolveCoinId(symbol);
  const vs = currency.trim().toLowerCase();
  if (!id || !isPriceableFiat(vs)) return undefined;

  try {
    const body = await cached(`fiat:${id}:${vs}`, () =>
      requestJson<Record<string, Record<string, number>>>(
        `${BASE_URL}/simple/price?${new URLSearchParams({ ids: id, vs_currencies: vs })}`,
        { provider: 'CoinGecko', headers: headers(), timeoutMs: 12_000 },
      ),
    );
    const price = body[id]?.[vs];
    return typeof price === 'number' && price > 0 ? price : undefined;
  } catch {
    return undefined;
  }
}
