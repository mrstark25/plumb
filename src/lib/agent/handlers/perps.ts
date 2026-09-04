import type { Address } from 'viem';
import { formatUsd } from '@/lib/format';
import {
  findPerpAsset, getAccountState, getMidPrice, type AccountState, type PerpPosition,
} from '@/lib/providers/hyperliquid-info';

export interface PositionsArgs {
  coin?: string;
}

export interface PositionsResult {
  readonly state: AccountState;
  readonly title: string;
}

/**
 * Reads the user's Hyperliquid account.
 *
 * The balance that matters here is the one deposited into the exchange, which
 * is entirely separate from any wallet balance. Saying so explicitly is
 * important: a user with plenty of USDC in their wallet and nothing on
 * Hyperliquid will otherwise read "no funds" as a bug.
 */
export async function readPositions(
  args: PositionsArgs,
  wallet: Address,
): Promise<PositionsResult> {
  const state = await getAccountState(wallet);

  const positions = args.coin
    ? state.positions.filter((p) => p.coin.toUpperCase() === args.coin!.trim().toUpperCase())
    : state.positions;

  return {
    state: { ...state, positions },
    title: args.coin ? `${args.coin.toUpperCase()} position` : 'Hyperliquid account',
  };
}

/** Prose for the model: the numbers it needs to reason about, nothing more. */
export function summarisePositions(state: AccountState): string {
  const lines = [
    `Account value ${formatUsd(state.accountValueUsd)}, withdrawable ${formatUsd(state.withdrawableUsd)}, margin used ${formatUsd(state.totalMarginUsedUsd)}.`,
  ];

  if (state.positions.length === 0) {
    lines.push('No open positions.');
    if (state.accountValueUsd === 0) {
      lines.push(
        'The account holds nothing. Funds must be deposited into Hyperliquid before trading — a wallet balance is not usable directly.',
      );
    }
    return lines.join(' ');
  }

  for (const p of state.positions) {
    lines.push(describePosition(p));
  }
  return lines.join('\n');
}

function describePosition(p: PerpPosition): string {
  const side = p.size > 0 ? 'long' : 'short';
  const liq = p.liquidationPrice === null ? 'none' : `$${p.liquidationPrice}`;
  return `- ${side} ${Math.abs(p.size)} ${p.coin} at ${p.leverage}x ${p.isCross ? 'cross' : 'isolated'}, entry $${p.entryPrice}, value ${formatUsd(p.positionValueUsd)}, unrealised ${formatUsd(p.unrealisedPnlUsd)}, liquidation ${liq}.`;
}

/**
 * Distance to liquidation as a percentage of the current price.
 *
 * This is the number that actually matters on a leveraged position, and it is
 * not something the exchange returns directly.
 */
export async function liquidationDistancePct(position: PerpPosition): Promise<number | null> {
  if (position.liquidationPrice === null) return null;
  try {
    const mark = await getMidPrice(position.coin);
    if (mark <= 0) return null;
    return (Math.abs(mark - position.liquidationPrice) / mark) * 100;
  } catch {
    return null;
  }
}

/** Confirms a market exists and reports its ceiling, for sizing questions. */
export async function describeMarket(coin: string) {
  const asset = await findPerpAsset(coin);
  const mid = await getMidPrice(asset.name);
  return { asset, mid };
}
