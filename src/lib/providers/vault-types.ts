import type { Address } from 'viem';
import type { SupportedChainId } from '@/lib/chains';

/** Normalised vault shape, independent of whatever the indexer returns. */
export interface MorphoVault {
  readonly address: Address;
  readonly chainId: SupportedChainId;
  readonly name: string;
  readonly symbol: string;
  readonly curator?: string;
  readonly asset: {
    readonly address: Address;
    readonly symbol: string;
    readonly decimals: number;
  };
  /** Net APY as a percent, e.g. 6.2 means 6.2%. Already net of fees. */
  readonly netApy: number;
  readonly totalAssetsUsd: number;
  /** Whether Morpho lists the vault as vetted rather than merely deployed. */
  readonly isVetted: boolean;
  /** Naive linear projection for a stated principal; not compounded. */
  readonly projectedYearlyUsd?: number;
}
