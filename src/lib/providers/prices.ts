import type { Address } from 'viem';
import { isNative } from '@/lib/tokens';
import type { SupportedChainId } from '@/lib/chains';
import { getMarketPrices, getTokenPriceUsd, resolveCoinId, type CoinPrice } from './coingecko';
import { requestJson } from './http';

const LLAMA_URL = 'https://coins.llama.fi/prices/current';
const LLAMA_CHANGE_URL = 'https://coins.llama.fi/percentage';

/**
 * DefiLlama scores every price it serves, and a thin or stale market scores
 * low. Below this the price is treated as unknown rather than shown — the same
 * rule the rest of this app follows, where a figure nobody can stand behind is
 * worse than a blank.
 */
const MIN_CONFIDENCE = 0.8;

function isTrustworthy(coin: { price?: number; confidence?: number } | undefined): boolean {
  if (typeof coin?.price !== 'number' || coin.price <= 0) return false;
  // Absent confidence is not low confidence; older entries omit the field.
  return coin.confidence === undefined || coin.confidence >= MIN_CONFIDENCE;
}

/**
 * 24h movement for a batch of CoinGecko ids, from DefiLlama.
 *
 * This exists so a CoinGecko outage costs the *source* of the 24h figure and
 * not the figure itself. Without it the fallback returned prices with a null
 * change, which silently emptied the one number a portfolio screen is really
 * for — and a rate limit should slow an answer down, not hollow it out.
 */
async function llamaChanges(ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const keys = ids.map((id) => `coingecko:${id}`);

  try {
    const body = await requestJson<{ coins: Record<string, number> }>(
      `${LLAMA_CHANGE_URL}/${keys.map(encodeURIComponent).join(',')}?period=24h`,
      { provider: 'DefiLlama prices', timeoutMs: 8_000 },
    );
    const out = new Map<string, number>();
    for (const id of ids) {
      const value = body.coins?.[`coingecko:${id}`];
      if (typeof value === 'number' && Number.isFinite(value)) out.set(id, value);
    }
    return out;
  } catch {
    // A missing change is rendered as unknown; it never blocks the price.
    return new Map();
  }
}

/** DefiLlama's coin keys are chain-slug prefixed. */
const LLAMA_SLUGS: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum',
  137: 'polygon',
  4663: 'robinhood',
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
  4663: 'coingecko:ethereum',
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
    const coin = body.coins?.[key];
    return isTrustworthy(coin) ? coin!.price : undefined;
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
 * differs.
 *
 * The fallback now carries 24h movement too, fetched alongside the price from
 * DefiLlama's own percentage endpoint. Market cap it genuinely does not have,
 * and that stays null rather than being approximated from anything.
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
    // Both calls at once: the change is worth having but never worth waiting
    // for in series behind the price.
    const [body, changes] = await Promise.all([
      requestJson<{
        coins: Record<string, { price?: number; timestamp?: number; confidence?: number }>;
      }>(`${LLAMA_URL}/${keys.map(encodeURIComponent).join(',')}`, {
        provider: 'DefiLlama prices',
        timeoutMs: 10_000,
      }),
      llamaChanges(resolved.map((r) => r.id)),
    ]);

    const prices: CoinPrice[] = [];
    for (const { symbol, id } of resolved) {
      const coin = body.coins?.[`coingecko:${id}`];
      if (!isTrustworthy(coin)) {
        unknown.push(symbol);
        continue;
      }
      const change = changes.get(id);
      prices.push({
        symbol,
        id,
        usd: coin!.price!,
        change24hPct: change ?? null,
        // DefiLlama's coin API carries no market cap, and it is not derivable
        // from anything here.
        marketCapUsd: null,
        updatedAt: typeof coin!.timestamp === 'number' ? coin!.timestamp * 1000 : null,
      });
    }
    return { prices, unknown, source: 'DefiLlama' };
  } catch {
    return { prices: [], unknown: wanted, source: 'DefiLlama' };
  }
}
