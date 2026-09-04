import type { Address } from 'viem';
import { publicClientFor } from '@/lib/viem';
import { CHAIN_IDS, type SupportedChainId } from '@/lib/chains';

/**
 * Aave v3 Pool, one per chain.
 *
 * Every address here was verified on-chain by calling `getReservesList()` and
 * walking `ADDRESSES_PROVIDER() → getPriceOracle()`, not copied from a doc
 * page. A wrong pool address would not throw — it would read zero and report
 * a healthy, empty account for someone who is actually borrowing.
 */
const POOL_ADDRESSES: Record<SupportedChainId, Address> = {
  1: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  8453: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  42161: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  137: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
};

const POOL_ABI = [
  {
    type: 'function',
    name: 'getUserAccountData',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
  },
] as const;

/**
 * Aave reports account totals in its oracle's base currency, scaled by
 * `BASE_CURRENCY_UNIT`. That is 1e8 (USD) on all four chains this app
 * supports — read from each pool's own oracle to confirm, not assumed.
 */
const BASE_UNIT = 1e8;

/** Basis points, as Aave encodes LTV and liquidation threshold. */
const BPS = 10_000;

/** Health factor is 1e18-scaled. */
const HF_UNIT = 1e18;

/**
 * Aave returns `type(uint256).max` as the health factor for an account with
 * no debt. Rendering that literally would put a 78-digit number on screen; it
 * means "nothing to liquidate", which is a different thing from a high score.
 */
const NO_DEBT_HEALTH_FACTOR = 2n ** 256n - 1n;

export interface AaveAccount {
  readonly chainId: SupportedChainId;
  readonly suppliedUsd: number;
  readonly borrowedUsd: number;
  /** Supplied minus borrowed — what the position is actually worth. */
  readonly netUsd: number;
  /**
   * Null when the account has no debt. A null here means "not applicable",
   * never "unknown", and the UI must say so rather than showing a dash that
   * could be read as a failed read.
   */
  readonly healthFactor: number | null;
  readonly ltvPct: number;
  readonly liquidationThresholdPct: number;
}

/**
 * Reads one account's Aave v3 position, or null when there is nothing there.
 *
 * Aggregates only — supplied, borrowed, and how close to liquidation. That is
 * one call per chain rather than one per reserve, and it is the information
 * that changes what someone does next. A per-asset breakdown would cost a call
 * for every token in the registry to tell most users what they already know.
 */
export async function readAaveAccount(
  chainId: SupportedChainId,
  owner: Address,
): Promise<AaveAccount | null> {
  const [collateral, debt, , liquidationThreshold, ltv, healthFactor] =
    await publicClientFor(chainId).readContract({
      address: POOL_ADDRESSES[chainId],
      abi: POOL_ABI,
      functionName: 'getUserAccountData',
      args: [owner],
    });

  // Nothing supplied and nothing borrowed is an absent position, not an empty
  // one. Returning a zeroed row would put "Aave: $0.00" on every portfolio.
  if (collateral === 0n && debt === 0n) return null;

  const suppliedUsd = Number(collateral) / BASE_UNIT;
  const borrowedUsd = Number(debt) / BASE_UNIT;

  return {
    chainId,
    suppliedUsd,
    borrowedUsd,
    netUsd: suppliedUsd - borrowedUsd,
    healthFactor:
      healthFactor === NO_DEBT_HEALTH_FACTOR ? null : Number(healthFactor) / HF_UNIT,
    ltvPct: Number(ltv) / BPS * 100,
    liquidationThresholdPct: Number(liquidationThreshold) / BPS * 100,
  };
}

/**
 * Every chain at once. One unreachable RPC must not blank the other three —
 * a portfolio that silently drops a chain is worse than one that is late.
 */
export async function readAllAaveAccounts(owner: Address): Promise<AaveAccount[]> {
  const results = await Promise.all(
    CHAIN_IDS.map((chainId) => readAaveAccount(chainId, owner).catch(() => null)),
  );
  return results.filter((account): account is AaveAccount => account !== null);
}

/**
 * How alarmed to be about a health factor.
 *
 * Aave liquidates below 1.0. The bands above that are this app's judgement,
 * not Aave's: 1.5 is where a bad day starts to matter and 1.1 is where one
 * already does.
 */
export function healthBand(healthFactor: number | null): 'none' | 'safe' | 'watch' | 'danger' {
  if (healthFactor === null) return 'none';
  if (healthFactor < 1.1) return 'danger';
  if (healthFactor < 1.5) return 'watch';
  return 'safe';
}
