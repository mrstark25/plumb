import { getAddress, type Address } from 'viem';
import { CHAIN_IDS, type SupportedChainId } from '@/lib/chains';
import { sanitiseLabel } from '@/lib/sanitise';
import { requestJson } from './http';

const API_URL = 'https://api.morpho.org/graphql';

/**
 * Which vaults an address is actually in.
 *
 * Asking the indexer rather than probing every listed vault on chain: there
 * are hundreds of them, and `balanceOf` on each would be hundreds of calls to
 * report that almost all are zero.
 *
 * Position figures live under `state`, not on the position itself — querying
 * `shares` directly is a validation error, not an empty result.
 */
const USER_POSITIONS_QUERY = `
  query UserVaultPositions($address: String!, $chainId: Int!) {
    userByAddress(address: $address, chainId: $chainId) {
      vaultPositions {
        state { shares assets assetsUsd }
        vault {
          address name symbol
          asset { symbol decimals }
          state { netApy }
        }
      }
    }
  }
`;

interface RawPosition {
  state?: {
    // The API returns these as a number for small values and a decimal string
    // for large ones, in the same response. Parsing either as one type drops
    // whole positions.
    shares?: string | number;
    assets?: string | number;
    assetsUsd?: number;
  };
  vault?: {
    address?: string;
    name?: string;
    symbol?: string;
    asset?: { symbol?: string; decimals?: number };
    state?: { netApy?: number };
  };
}

interface Response {
  data?: { userByAddress?: { vaultPositions?: RawPosition[] } | null };
}

export interface MorphoPosition {
  readonly chainId: SupportedChainId;
  readonly vault: Address;
  readonly name: string;
  readonly shares: bigint;
  /** Position size in the underlying asset, base units. */
  readonly assets: bigint;
  readonly assetSymbol: string;
  readonly decimals: number;
  readonly assetsUsd: number | undefined;
  /** Net of the vault fee already, as a percentage. */
  readonly apyPct: number;
}

/**
 * Positions on one chain. An address the indexer has never seen returns null
 * rather than an error, which is not a failure — it is the common case.
 */
export async function readMorphoPositions(
  chainId: SupportedChainId,
  owner: Address,
): Promise<MorphoPosition[]> {
  const body = await requestJson<Response>(API_URL, {
    provider: 'Morpho',
    method: 'POST',
    body: {
      query: USER_POSITIONS_QUERY,
      variables: { address: owner.toLowerCase(), chainId },
    },
  });

  const raw = body.data?.userByAddress?.vaultPositions ?? [];
  return raw.map((entry) => toPosition(chainId, entry)).filter(isPresent);
}

function toPosition(chainId: SupportedChainId, entry: RawPosition): MorphoPosition | null {
  const address = entry.vault?.address;
  const shares = parseMorphoAmount(entry.state?.shares);
  if (!address || shares === 0n) return null;

  const decimals = entry.vault?.asset?.decimals;
  if (typeof decimals !== 'number') return null;

  return {
    chainId,
    vault: getAddress(address),
    // Vault names are author-supplied and re-enter the model's context, so
    // they go through the same stripping every other upstream label does.
    name: sanitiseLabel(entry.vault?.name ?? 'Morpho vault'),
    shares,
    assets: parseMorphoAmount(entry.state?.assets),
    assetSymbol: sanitiseLabel(entry.vault?.asset?.symbol ?? '?'),
    decimals,
    assetsUsd: typeof entry.state?.assetsUsd === 'number' ? entry.state.assetsUsd : undefined,
    // `netApy` is a fraction here, as everywhere else in Morpho's API.
    apyPct: (entry.vault?.state?.netApy ?? 0) * 100,
  };
}

/**
 * Handles the mixed number/string encoding, and the fractional values that
 * come with it: a JavaScript number large enough to hold a share balance has
 * already lost precision, and `BigInt()` throws on a decimal point.
 */
export function parseMorphoAmount(value: string | number | undefined): bigint {
  if (value === undefined || value === null) return 0n;
  const text = typeof value === 'number' ? value.toFixed(0) : value.trim();
  if (!/^-?\d+$/.test(text)) return 0n;
  try {
    const parsed = BigInt(text);
    return parsed < 0n ? 0n : parsed;
  } catch {
    return 0n;
  }
}

function isPresent(value: MorphoPosition | null): value is MorphoPosition {
  return value !== null;
}

/** Every chain at once; one failing chain must not blank the others. */
export async function readAllMorphoPositions(owner: Address): Promise<MorphoPosition[]> {
  const results = await Promise.all(
    CHAIN_IDS.map((chainId) => readMorphoPositions(chainId, owner).catch(() => [])),
  );
  return results.flat();
}
