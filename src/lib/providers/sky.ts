import type { Address } from 'viem';
import { publicClientFor } from '@/lib/viem';
import { readVaultPosition } from '@/lib/erc4626';

/**
 * Sky's savings token, and only on Ethereum.
 *
 * sUSDS exists on Base too, at 0x5875eEE1…67a, but that deployment is a
 * bridged representation: it answers `symbol()` and `decimals()` and nothing
 * else — no `asset()`, no `convertToAssets()`, no rate. Probed directly rather
 * than assumed. It is therefore carried as an ordinary token holding through
 * the registry, and only the Ethereum vault is read as a savings position.
 */
const SUSDS_ETHEREUM: Address = '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD';
const SKY_CHAIN_ID = 1;

const SSR_ABI = [
  { type: 'function', name: 'ssr', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

/** The Sky Savings Rate is a per-second rate in ray (1e27). */
const RAY = 1e27;
const SECONDS_PER_YEAR = 31_536_000;

export interface SkyPosition {
  readonly chainId: 1;
  readonly vault: Address;
  /** sUSDS shares held. */
  readonly shares: bigint;
  /** What those shares redeem for in USDS right now. */
  readonly assets: bigint;
  readonly assetSymbol: 'USDS';
  readonly decimals: 18;
  /** Sky Savings Rate, annualised, as a percentage. */
  readonly apyPct: number;
}

/**
 * Turns the per-second rate into an annual percentage.
 *
 * Compounded, not multiplied: the rate accrues every second, so simple
 * multiplication understates it. Exported for the test that pins this against
 * a rate read from the live contract.
 */
export function annualisedFromSsr(ssr: bigint): number {
  const perSecond = Number(ssr) / RAY;
  if (!Number.isFinite(perSecond) || perSecond <= 0) return 0;
  return (perSecond ** SECONDS_PER_YEAR - 1) * 100;
}

/**
 * Reads a Sky savings position, or null when there is none.
 *
 * sUSDS on Ethereum is a real ERC-4626 whose asset is USDS — verified by
 * reading `asset()` — so the same reader the Morpho vaults use works here
 * unchanged.
 */
export async function readSkyPosition(owner: Address): Promise<SkyPosition | null> {
  const position = await readVaultPosition({
    chainId: SKY_CHAIN_ID,
    vault: SUSDS_ETHEREUM,
    owner,
  });
  if (position.shares === 0n) return null;

  // A missing rate must not discard a position that is genuinely there.
  const ssr = await publicClientFor(SKY_CHAIN_ID)
    .readContract({ address: SUSDS_ETHEREUM, abi: SSR_ABI, functionName: 'ssr' })
    .catch(() => 0n);

  return {
    chainId: SKY_CHAIN_ID,
    vault: SUSDS_ETHEREUM,
    shares: position.shares,
    assets: position.assets,
    assetSymbol: 'USDS',
    decimals: 18,
    apyPct: annualisedFromSsr(ssr),
  };
}
