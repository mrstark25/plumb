import { requestJson } from './http';

/**
 * Hyperliquid's read-only API. No key, no auth.
 *
 * Note this is HyperCore — the order-book L1 where perps actually trade — not
 * HyperEVM. A wallet balance on any EVM chain is not usable here; funds must
 * be deposited into the exchange first.
 */
export const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

/** Metadata changes rarely and every order needs it, so it is cached. */
const META_TTL_MS = 5 * 60 * 1000;

export interface PerpAsset {
  /** Position in the universe array — the wire format's asset id. */
  readonly index: number;
  readonly name: string;
  /** Decimal places allowed on order size. */
  readonly szDecimals: number;
  readonly maxLeverage: number;
  readonly isDelisted: boolean;
}

interface RawUniverseEntry {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
}

let metaCache: { assets: PerpAsset[]; expiresAt: number } | null = null;

export async function getPerpAssets(): Promise<PerpAsset[]> {
  if (metaCache && Date.now() < metaCache.expiresAt) return metaCache.assets;

  const body = await requestJson<{ universe: RawUniverseEntry[] }>(HL_INFO_URL, {
    provider: 'Hyperliquid',
    method: 'POST',
    body: { type: 'meta' },
    timeoutMs: 15_000,
  });

  const assets = (body.universe ?? []).map((entry, index) => ({
    index,
    name: entry.name,
    szDecimals: entry.szDecimals,
    maxLeverage: entry.maxLeverage,
    isDelisted: entry.isDelisted === true,
  }));

  metaCache = { assets, expiresAt: Date.now() + META_TTL_MS };
  return assets;
}

/**
 * Resolves a coin symbol to its asset.
 *
 * Refused rather than guessed when unknown, and delisted assets are refused
 * too — they still appear in the universe but cannot be traded.
 */
export async function findPerpAsset(symbol: string): Promise<PerpAsset> {
  const wanted = symbol.trim().toUpperCase();
  const assets = await getPerpAssets();
  const asset = assets.find((a) => a.name.toUpperCase() === wanted);

  if (!asset) {
    throw new Error(`Hyperliquid has no perp market for "${symbol}".`);
  }
  if (asset.isDelisted) {
    throw new Error(`The ${asset.name} perp is delisted and cannot be traded.`);
  }
  return asset;
}

/** Mid prices for every market, keyed by coin name. */
export async function getMidPrices(): Promise<Record<string, string>> {
  return requestJson<Record<string, string>>(HL_INFO_URL, {
    provider: 'Hyperliquid',
    method: 'POST',
    body: { type: 'allMids' },
    timeoutMs: 15_000,
  });
}

export async function getMidPrice(symbol: string): Promise<number> {
  const mids = await getMidPrices();
  const raw = mids[symbol.toUpperCase()];
  const price = Number(raw);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`No live price for ${symbol} on Hyperliquid.`);
  }
  return price;
}

export interface PerpPosition {
  readonly coin: string;
  /** Signed: positive is long, negative is short. */
  readonly size: number;
  readonly entryPrice: number;
  readonly positionValueUsd: number;
  readonly unrealisedPnlUsd: number;
  readonly liquidationPrice: number | null;
  readonly leverage: number;
  readonly isCross: boolean;
}

export interface AccountState {
  /** USDC available to open new positions. */
  readonly withdrawableUsd: number;
  readonly accountValueUsd: number;
  readonly totalMarginUsedUsd: number;
  readonly positions: PerpPosition[];
}

interface RawAssetPosition {
  position: {
    coin: string;
    szi: string;
    entryPx: string | null;
    positionValue: string;
    unrealizedPnl: string;
    liquidationPx: string | null;
    leverage: { type: string; value: number };
  };
}

/**
 * The user's exchange account — margin and open positions.
 *
 * This is the balance that matters for trading. It is entirely separate from
 * any wallet balance, and is zero until funds are deposited into Hyperliquid.
 */
export async function getAccountState(address: string): Promise<AccountState> {
  const body = await requestJson<{
    marginSummary?: { accountValue: string; totalMarginUsed: string };
    withdrawable?: string;
    assetPositions?: RawAssetPosition[];
  }>(HL_INFO_URL, {
    provider: 'Hyperliquid',
    method: 'POST',
    body: { type: 'clearinghouseState', user: address },
    timeoutMs: 15_000,
  });

  const positions = (body.assetPositions ?? [])
    .map(({ position }) => ({
      coin: position.coin,
      size: Number(position.szi),
      entryPrice: Number(position.entryPx ?? 0),
      positionValueUsd: Number(position.positionValue),
      unrealisedPnlUsd: Number(position.unrealizedPnl),
      liquidationPrice: position.liquidationPx === null ? null : Number(position.liquidationPx),
      leverage: position.leverage?.value ?? 1,
      isCross: position.leverage?.type === 'cross',
    }))
    .filter((p) => p.size !== 0);

  return {
    withdrawableUsd: Number(body.withdrawable ?? 0),
    accountValueUsd: Number(body.marginSummary?.accountValue ?? 0),
    totalMarginUsedUsd: Number(body.marginSummary?.totalMarginUsed ?? 0),
    positions,
  };
}

/**
 * Whether the account has already authorised this browser's agent key.
 *
 * Checked before every position so the one-time signature is asked for once
 * and then never again — and so a fresh browser is asked properly rather than
 * silently failing with "does not exist".
 */
export async function hasApprovedAgent(
  master: string,
  agentAddress: string | null,
): Promise<boolean> {
  if (!agentAddress) return false;

  try {
    const body = await requestJson<{ agentAddress?: string; validUntil?: number }[]>(HL_INFO_URL, {
      provider: 'Hyperliquid',
      method: 'POST',
      body: { type: 'extraAgents', user: master },
      timeoutMs: 12_000,
    });

    const wanted = agentAddress.toLowerCase();
    return (body ?? []).some(
      (a) =>
        a.agentAddress?.toLowerCase() === wanted &&
        (a.validUntil === undefined || a.validUntil > Date.now()),
    );
  } catch {
    // Unknown means "ask again": a redundant approval is harmless, a skipped
    // one makes every order fail.
    return false;
  }
}

/** Whether a builder fee has already been approved for the configured builder. */
export async function hasApprovedBuilder(master: string): Promise<boolean> {
  const builder = process.env.HYPERLIQUID_BUILDER_ADDRESS;
  // With no builder configured there is nothing to approve.
  if (!builder) return true;

  try {
    const maxFee = await requestJson<number>(HL_INFO_URL, {
      provider: 'Hyperliquid',
      method: 'POST',
      body: { type: 'maxBuilderFee', user: master, builder: builder.toLowerCase() },
      timeoutMs: 12_000,
    });
    return typeof maxFee === 'number' && maxFee > 0;
  } catch {
    return false;
  }
}
