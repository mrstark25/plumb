import { getAddress, type Address } from 'viem';
import { CHAIN_IDS, isSupportedChainId, type SupportedChainId } from '@/lib/chains';
import { sanitiseLabel } from '@/lib/sanitise';
import { ProviderError, requestJson } from './http';
import type { MorphoVault } from './vault-types';

const API_URL = 'https://api.morpho.org/graphql';

/**
 * `listed: true` is the curated allowlist Morpho shows in its own app. Without
 * it an APY-sorted list is dominated by test and abandoned deployments —
 * anyone can deploy a vault. The TVL floor is a second guard on the same
 * problem, set low enough that Arbitrum (whose largest listed vault is ~$2M)
 * is not empty.
 */
const DEFAULT_MIN_TVL_USD = 1_000_000;
const DEFAULT_LIMIT = 6;

/**
 * V1 and V2 are separate query roots with different response shapes, and there
 * is no version field — the root you call IS the discriminator. Both implement
 * the same ERC-4626 deposit interface, so only this read layer branches.
 */
const V1_QUERY = `
  query VaultsV1($chainIds: [Int!], $minTvl: Float, $first: Int!, $assetSymbols: [String!]) {
    vaults(
      first: $first
      orderBy: NetApy
      orderDirection: Desc
      where: {
        chainId_in: $chainIds
        listed: true
        totalAssetsUsd_gte: $minTvl
        assetSymbol_in: $assetSymbols
      }
    ) {
      items {
        address name symbol
        chain { id }
        asset { address symbol decimals }
        warnings { type level }
        state { netApy totalAssetsUsd curators { name } }
      }
    }
  }
`;

const V2_QUERY = `
  query VaultsV2($chainIds: [Int!], $minTvl: Float, $first: Int!, $assetSymbols: [String!]) {
    vaultV2s(
      first: $first
      orderBy: NetApy
      orderDirection: Desc
      where: {
        chainId_in: $chainIds
        listed: true
        totalAssetsUsd_gte: $minTvl
        assetSymbol_in: $assetSymbols
      }
    ) {
      items {
        address name symbol
        chain { id }
        asset { address symbol decimals }
        netApy totalAssetsUsd
        curators { items { name } }
      }
    }
  }
`;

interface RawAsset {
  address: string;
  symbol: string;
  decimals: number;
}

interface RawV1 {
  address: string;
  name: string;
  symbol: string;
  chain: { id: number } | null;
  asset: RawAsset;
  warnings: { type: string; level: string }[] | null;
  state: { netApy: number | null; totalAssetsUsd: number | null; curators: { name: string }[] | null } | null;
}

interface RawV2 {
  address: string;
  name: string;
  symbol: string;
  chain: { id: number } | null;
  asset: RawAsset;
  netApy: number | null;
  totalAssetsUsd: number | null;
  curators: { items: { name: string }[] | null } | null;
}

export interface VaultQuery {
  readonly chainIds?: readonly SupportedChainId[];
  readonly assetSymbol?: string;
  readonly minTvlUsd?: number;
  readonly limit?: number;
  readonly amountUsd?: number;
}

export async function findVaults(query: VaultQuery = {}): Promise<MorphoVault[]> {
  const variables = {
    chainIds: [...(query.chainIds ?? CHAIN_IDS)],
    minTvl: query.minTvlUsd ?? DEFAULT_MIN_TVL_USD,
    first: query.limit ?? DEFAULT_LIMIT,
    // GraphQL reads null as "no filter"; an empty array would match nothing.
    assetSymbols: query.assetSymbol ? [query.assetSymbol.toUpperCase()] : null,
  };

  // One root being down or changing shape must not blank the whole list.
  const [v1, v2] = await Promise.allSettled([
    execute<{ vaults?: { items?: RawV1[] } }>(V1_QUERY, variables),
    execute<{ vaultV2s?: { items?: RawV2[] } }>(V2_QUERY, variables),
  ]);

  if (v1.status === 'rejected' && v2.status === 'rejected') {
    throw new ProviderError('Morpho', 'Could not read vaults from Morpho.');
  }

  const vaults = [
    ...(v1.status === 'fulfilled' ? (v1.value.vaults?.items ?? []).map(fromV1) : []),
    ...(v2.status === 'fulfilled' ? (v2.value.vaultV2s?.items ?? []).map(fromV2) : []),
  ].filter((v): v is MorphoVault => v !== null);

  vaults.sort((a, b) => b.netApy - a.netApy);

  return vaults
    .slice(0, query.limit ?? DEFAULT_LIMIT)
    .map((v) => withProjection(v, query.amountUsd));
}

/**
 * Verifies a user-named vault by address. Scans the chain's listed vaults with
 * no TVL floor rather than trusting an arbitrary address: depositing into an
 * unlisted vault is how someone loses funds to a lookalike.
 */
export async function findVaultByAddress(
  chainId: SupportedChainId,
  address: Address,
): Promise<MorphoVault | null> {
  const vaults = await findVaults({ chainIds: [chainId], minTvlUsd: 0, limit: 250 });
  const target = getAddress(address);
  return vaults.find((v) => getAddress(v.address) === target) ?? null;
}

async function execute<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const body = await requestJson<{ data?: T; errors?: { message: string }[] }>(API_URL, {
    provider: 'Morpho',
    method: 'POST',
    timeoutMs: 20_000,
    body: { query, variables },
  });
  if (body.errors?.length) {
    throw new ProviderError('Morpho', body.errors[0]?.message ?? 'Vault query failed.');
  }
  if (!body.data) throw new ProviderError('Morpho', 'Vault query returned no data.');
  return body.data;
}

function fromV1(raw: RawV1): MorphoVault | null {
  // A RED warning is Morpho's own risk flag; those never reach the user.
  if (raw.warnings?.some((w) => w.level === 'RED')) return null;
  return build({
    address: raw.address,
    name: raw.name,
    symbol: raw.symbol,
    chainId: raw.chain?.id,
    asset: raw.asset,
    netApy: raw.state?.netApy ?? null,
    totalAssetsUsd: raw.state?.totalAssetsUsd ?? null,
    curatorNames: raw.state?.curators?.map((c) => c.name) ?? [],
  });
}

function fromV2(raw: RawV2): MorphoVault | null {
  return build({
    address: raw.address,
    name: raw.name,
    symbol: raw.symbol,
    chainId: raw.chain?.id,
    asset: raw.asset,
    netApy: raw.netApy,
    totalAssetsUsd: raw.totalAssetsUsd,
    curatorNames: raw.curators?.items?.map((c) => c.name) ?? [],
  });
}

function build(input: {
  address: string;
  name: string;
  symbol: string;
  chainId: number | undefined;
  asset: RawAsset;
  netApy: number | null;
  totalAssetsUsd: number | null;
  curatorNames: string[];
}): MorphoVault | null {
  const { chainId } = input;
  if (chainId === undefined || !isSupportedChainId(chainId)) return null;
  if (input.netApy === null || input.totalAssetsUsd === null) return null;

  // netApy arrives as a fraction (0.0442), not a percent, and is already net
  // of the vault fee — do not subtract the fee again.
  const netApy = input.netApy * 100;

  const curator = input.curatorNames
    .map((name) => sanitiseLabel(name))
    .filter(Boolean)
    .join(', ');

  return {
    address: getAddress(input.address),
    chainId,
    // Vault and curator names are operator-supplied text that flows back into
    // the model's context, so they are treated as untrusted.
    name: sanitiseLabel(input.name) || 'Unnamed vault',
    symbol: sanitiseLabel(input.symbol),
    ...(curator ? { curator } : {}),
    asset: {
      address: getAddress(input.asset.address),
      symbol: sanitiseLabel(input.asset.symbol),
      decimals: input.asset.decimals,
    },
    netApy,
    totalAssetsUsd: input.totalAssetsUsd,
    isVetted: true,
  };
}

function withProjection(vault: MorphoVault, amountUsd: number | undefined): MorphoVault {
  if (amountUsd === undefined) return vault;
  return { ...vault, projectedYearlyUsd: amountUsd * (vault.netApy / 100) };
}
