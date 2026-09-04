import type { Address } from 'viem';
import { isNative } from '@/lib/tokens';
import type { SupportedChainId } from '@/lib/chains';
import { getMarketPrices, getTokenPriceUsd, resolveCoinId, type CoinPrice } from './coingecko';
import { requestJson } from './http';

const LLAMA_URL = 'https://coins.llama.fi/prices/current';

/** DefiLlama's coin keys are chain-slug prefixed. */
const LLAMA_SLUGS: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum',
  137: 'polygon',
};

/**
 * Best-effort USD pricing, CoinGecko first and DefiLlama behind it.
 *
 * Two sources because they fail differently: CoinGecko's public tier is
 * rate-limited and will refuse under load, while DefiLlama covers long-tail
 * contracts CoinGecko has never indexed. Either one missing a token is normal.
 *
 * Every caller treats an unknown price as unknown rather than zero — a card
 * showing "$0.00" is worse than one showing nothing at all.
 */
export async function getUsdPrice(
  chainId: number,
  token: Address,
): Promise<number | undefined> {
  const supported = chainId as SupportedChainId;

  if (isNative(token)) {
    const { prices } = await getMarketPrices(['ETH']).catch(() => ({ prices: [], unknown: [] }));
    const eth = prices[0]?.usd;
    if (eth !== undefined) return eth;
    return llamaPrice(chainId, token);
  }

  const fromCoinGecko = await getTokenPriceUsd(supported, token);
  return fromCoinGecko ?? llamaPrice(chainId, token);
}

const LLAMA_NATIVE_KEYS: Record<number, string> = {
  1: 'coingecko:ethereum',
  8453: 'coingecko:ethereum',
  42161: 'coingecko:ethereum',
  137: 'coingecko:polygon-ecosystem-token',
};

async function llamaPrice(chainId: number, token: Address): Promise<number | undefined> {
  const key = isNative(token)
    ? LLAMA_NATIVE_KEYS[chainId]
    : LLAMA_SLUGS[chainId] && `${LLAMA_SLUGS[chainId]}:${token}`;
  if (!key) return undefined;

  try {
    const body = await requestJson<{ coins: Record<string, { price?: number }> }>(
      `${LLAMA_URL}/${encodeURIComponent(key)}`,
      { provider: 'DefiLlama prices', timeoutMs: 8_000 },
    );
    const price = body.coins?.[key]?.price;
    return typeof price === 'number' && price > 0 ? price : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Spot prices by symbol, with a fallback.
 *
 * CoinGecko's keyless tier rate-limits readily, and a rate limit should slow
 * an answer down, not remove it. DefiLlama prices the same assets by their
 * CoinGecko id, so the identity mapping is shared and only the transport
 * differs. The fallback carries no 24h change or market cap — the card renders
 * those as unknown rather than inventing them.
 */
export async function getSpotPrices(
  symbols: readonly string[],
): Promise<{ prices: CoinPrice[]; unknown: string[]; source: 'CoinGecko' | 'DefiLlama' }> {
  try {
    const result = await getMarketPrices(symbols);
    if (result.prices.length > 0) return { ...result, source: 'CoinGecko' };
  } catch {
    // Fall through: a rate limit or outage is not a reason to answer nothing.
  }

  const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()))].filter(Boolean);
  const resolved = wanted
    .map((symbol) => ({ symbol, id: resolveCoinId(symbol) }))
    .filter((e): e is { symbol: string; id: string } => e.id !== undefined);
  const unknown = wanted.filter((s) => resolveCoinId(s) === undefined);

  if (resolved.length === 0) return { prices: [], unknown, source: 'DefiLlama' };

  try {
    const keys = resolved.map((r) => `coingecko:${r.id}`);
    const body = await requestJson<{ coins: Record<string, { price?: number; timestamp?: number }> }>(
      `${LLAMA_URL}/${keys.map(encodeURIComponent).join(',')}`,
      { provider: 'DefiLlama prices', timeoutMs: 10_000 },
    );

    const prices: CoinPrice[] = [];
    for (const { symbol, id } of resolved) {
      const coin = body.coins?.[`coingecko:${id}`];
      if (typeof coin?.price !== 'number' || coin.price <= 0) {
        unknown.push(symbol);
        continue;
      }
      prices.push({
        symbol,
        id,
        usd: coin.price,
        change24hPct: null,
        marketCapUsd: null,
        updatedAt: typeof coin.timestamp === 'number' ? coin.timestamp * 1000 : null,
      });
    }
    return { prices, unknown, source: 'DefiLlama' };
  } catch {
    return { prices: [], unknown: wanted, source: 'DefiLlama' };
  }
}
