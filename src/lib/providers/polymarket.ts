import { requestJson } from './http';

/**
 * Polymarket market data via the public Gamma API. No key, no auth.
 *
 * Markets settle on Polygon in pUSD — a 1:1 USDC wrapper, not USDC.e directly
 * — and each outcome is an ERC-1155 position token traded on Polymarket's own
 * order book. Reading odds needs nothing on-chain; trading them needs pUSD,
 * four approvals, and CLOB API credentials.
 */
const GAMMA_URL = 'https://gamma-api.polymarket.com';

export interface PredictionOutcome {
  readonly name: string;
  /** Implied probability, 0–1. */
  readonly price: number;
  /** CLOB token id for this outcome. */
  readonly tokenId: string;
}

export interface PredictionMarket {
  readonly question: string;
  readonly slug: string;
  readonly conditionId: string;
  readonly outcomes: readonly PredictionOutcome[];
  readonly volumeUsd: number;
  readonly liquidityUsd: number;
  readonly endDate: string | null;
  readonly isAcceptingOrders: boolean;
  /** Multi-outcome markets settle on a different exchange contract. */
  readonly isNegRisk: boolean;
  readonly minTickSize: number;
  readonly url: string;
}

interface RawMarket {
  question?: string;
  slug?: string;
  conditionId?: string;
  // These three arrive as JSON-encoded strings, not arrays.
  clobTokenIds?: string;
  outcomes?: string;
  outcomePrices?: string;
  volumeNum?: number;
  liquidityNum?: number;
  endDate?: string;
  closed?: boolean;
  active?: boolean;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  negRisk?: boolean;
  orderPriceMinTickSize?: number;
}

export interface MarketQuery {
  readonly search?: string;
  readonly limit?: number;
}

/**
 * Active markets, most traded first.
 *
 * Ordering by volume matters: Polymarket carries a long tail of markets with
 * almost no liquidity, and surfacing those as "the odds" would be misleading.
 */
export async function findMarkets(query: MarketQuery = {}): Promise<PredictionMarket[]> {
  const params = new URLSearchParams({
    active: 'true',
    closed: 'false',
    order: 'volumeNum',
    ascending: 'false',
    limit: String(Math.min(query.limit ?? 5, 20)),
  });

  const raw = await requestJson<RawMarket[]>(
    `${GAMMA_URL}/markets?${params}`,
    { provider: 'Polymarket', timeoutMs: 15_000 },
  );

  const markets = (raw ?? []).map(toMarket).filter((m): m is PredictionMarket => m !== null);

  // Gamma has no reliable full-text filter, so a search term is applied here.
  const term = query.search?.trim().toLowerCase();
  if (!term) return markets;

  const words = term.split(/\s+/).filter((w) => w.length > 2);
  return markets.filter((m) => {
    const haystack = `${m.question} ${m.slug}`.toLowerCase();
    return words.length === 0
      ? haystack.includes(term)
      : words.some((w) => haystack.includes(w));
  });
}

/** Searches by keyword across a wider slice than the default listing. */
export async function searchMarkets(search: string, limit = 5): Promise<PredictionMarket[]> {
  const found = await findMarkets({ search, limit: 20 });
  return found.slice(0, limit);
}

export async function getMarketBySlug(slug: string): Promise<PredictionMarket | null> {
  const raw = await requestJson<RawMarket[]>(
    `${GAMMA_URL}/markets?slug=${encodeURIComponent(slug)}`,
    { provider: 'Polymarket', timeoutMs: 15_000 },
  );
  const market = (raw ?? [])[0];
  return market ? toMarket(market) : null;
}

function toMarket(raw: RawMarket): PredictionMarket | null {
  if (!raw.question || !raw.conditionId) return null;
  if (raw.closed === true || raw.active === false) return null;

  const names = parseJsonArray(raw.outcomes);
  const prices = parseJsonArray(raw.outcomePrices);
  const tokenIds = parseJsonArray(raw.clobTokenIds);
  if (names.length === 0 || names.length !== prices.length) return null;

  const outcomes = names.map((name, index) => ({
    name,
    price: Number(prices[index]),
    tokenId: tokenIds[index] ?? '',
  }));
  if (outcomes.some((o) => !Number.isFinite(o.price))) return null;

  const slug = raw.slug ?? '';
  return {
    question: raw.question,
    slug,
    conditionId: raw.conditionId,
    outcomes,
    volumeUsd: Number(raw.volumeNum ?? 0),
    liquidityUsd: Number(raw.liquidityNum ?? 0),
    endDate: raw.endDate ?? null,
    // A market can be listed but not currently matching orders.
    isAcceptingOrders: raw.acceptingOrders === true && raw.enableOrderBook !== false,
    isNegRisk: raw.negRisk === true,
    minTickSize: Number(raw.orderPriceMinTickSize ?? 0.01),
    url: slug ? `https://polymarket.com/market/${slug}` : 'https://polymarket.com',
  };
}

/**
 * Gamma encodes these arrays as JSON strings rather than returning arrays, so
 * they have to be parsed rather than used directly.
 */
function parseJsonArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
