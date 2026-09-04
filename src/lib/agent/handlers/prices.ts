import { knownPriceSymbols, type CoinPrice } from '@/lib/providers/coingecko';
import { getSpotPrices } from '@/lib/providers/prices';

export interface PriceArgs {
  symbols?: string[];
}

export interface PriceResult {
  readonly prices: CoinPrice[];
  readonly unknown: string[];
  readonly title: string;
  readonly source: string;
}

const MAX_SYMBOLS = 12;

export async function readPrices(args: PriceArgs): Promise<PriceResult> {
  const requested = (args.symbols ?? []).filter((s) => typeof s === 'string' && s.trim() !== '');
  if (requested.length === 0) {
    throw new Error('Name at least one asset to price, for example BTC or ETH.');
  }

  const { prices, unknown, source } = await getSpotPrices(requested.slice(0, MAX_SYMBOLS));

  if (prices.length === 0) {
    throw new Error(
      `I don't have a price feed for ${unknown.join(', ')}. I can price: ${knownPriceSymbols().join(', ')}.`,
    );
  }

  return {
    prices,
    unknown,
    source,
    title: prices.length === 1 ? `${prices[0]?.symbol} price` : 'Prices',
  };
}
