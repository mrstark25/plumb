import { findMarkets, searchMarkets, type PredictionMarket } from '@/lib/providers/polymarket';

export interface PredictionArgs {
  topic?: string;
}

export interface PredictionResult {
  readonly markets: PredictionMarket[];
  readonly title: string;
}

export async function readPredictionMarkets(args: PredictionArgs): Promise<PredictionResult> {
  const topic = args.topic?.trim();

  const markets = topic
    ? await searchMarkets(topic, 5)
    : await findMarkets({ limit: 5 });

  if (markets.length === 0) {
    throw new Error(
      topic
        ? `No active Polymarket market matched "${topic}". Try a broader term.`
        : 'No active Polymarket markets came back.',
    );
  }

  return {
    markets,
    title: topic ? `Prediction markets: ${topic}` : 'Most traded prediction markets',
  };
}

/** Prose for the model — the odds it needs to reason about, nothing more. */
export function summariseMarkets(markets: readonly PredictionMarket[]): string {
  return markets
    .map((m) => {
      const odds = m.outcomes
        .map((o) => `${o.name} ${(o.price * 100).toFixed(1)}%`)
        .join(', ');
      const thin = m.liquidityUsd < 10_000 ? ' (thin liquidity)' : '';
      return `- ${m.question}: ${odds}. $${Math.round(m.volumeUsd).toLocaleString('en-US')} volume${thin}.`;
    })
    .join('\n');
}
