import { arbitrum, base, mainnet, polygon } from 'viem/chains';
import { defineChain, type Chain } from 'viem';

/**
 * Robinhood Chain — an Arbitrum Orbit L2 for tokenised equities, mainnet
 * since 1 July 2026. viem ships no definition for it, so it is declared here.
 *
 * Every value was read from the chain rather than copied from a doc page:
 * `eth_chainId` returned 0x1237 (4663), gas is ETH, and Multicall3 is live at
 * the canonical address — which matters, because every balance read in this
 * app is batched through it.
 *
 * What it supports here is deliberately narrower than the other four. See
 * `SWAPLESS_CHAINS` below.
 */
export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
});

export const SUPPORTED_CHAINS = [mainnet, base, arbitrum, polygon, robinhood] as const satisfies readonly Chain[];

export type SupportedChainId = (typeof SUPPORTED_CHAINS)[number]['id'];

export const CHAIN_IDS = SUPPORTED_CHAINS.map((c) => c.id) as SupportedChainId[];

const CHAIN_BY_ID = new Map<number, Chain>(SUPPORTED_CHAINS.map((c) => [c.id, c]));

/** Human aliases the model (and users) actually type. */
const CHAIN_ALIASES: Record<string, SupportedChainId> = {
  ethereum: 1, eth: 1, mainnet: 1, l1: 1,
  base: 8453,
  arbitrum: 42161, arb: 42161, 'arbitrum one': 42161,
  polygon: 137, matic: 137, pol: 137,
  robinhood: 4663, 'robinhood chain': 4663, rhc: 4663, hood: 4663,
};

/**
 * Chains with no same-chain swap venue this app can reach.
 *
 * Neither the Uniswap Trading API nor OpenOcean quotes Robinhood Chain — the
 * former answers `ResourceNotFound: No quotes available` for chain 4663. The
 * chain is still worth supporting because LI.FI bridges to it and balances
 * read fine, but a swap request has to be refused with the reason rather than
 * failing deep inside a provider with an opaque error.
 */
export const SWAPLESS_CHAINS = new Set<number>([robinhood.id]);

export function canSwapOn(chainId: number): boolean {
  return !SWAPLESS_CHAINS.has(chainId);
}

export function isSupportedChainId(id: number): id is SupportedChainId {
  return CHAIN_BY_ID.has(id);
}

export function getChain(id: number): Chain {
  const chain = CHAIN_BY_ID.get(id);
  if (!chain) throw new Error(`Unsupported chain id: ${id}. Supported: ${CHAIN_IDS.join(', ')}`);
  return chain;
}

/** Accepts "base", "Arbitrum One", or "8453" and returns a supported chain id. */
export function resolveChain(input: string | number): SupportedChainId {
  if (typeof input === 'number') {
    if (!isSupportedChainId(input)) throw new Error(`Unsupported chain id: ${input}`);
    return input;
  }
  const trimmed = input.trim().toLowerCase();
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric > 0) return resolveChain(numeric);
  const alias = CHAIN_ALIASES[trimmed];
  if (!alias) {
    throw new Error(
      `Unknown chain "${input}". Supported: ethereum, base, arbitrum, polygon, robinhood.`,
    );
  }
  return alias;
}

export function chainName(id: number): string {
  return CHAIN_BY_ID.get(id)?.name ?? `chain ${id}`;
}

export function explorerTxUrl(chainId: number, hash: string): string {
  const base = CHAIN_BY_ID.get(chainId)?.blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : '';
}

/**
 * Public RPCs are rate-limited and are a development default only; operators
 * should set RPC_URL_<chainId> to a dedicated endpoint before real use.
 */
const FALLBACK_RPC: Record<SupportedChainId, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
  137: 'https://polygon-bor-rpc.publicnode.com',
  4663: 'https://rpc.mainnet.chain.robinhood.com',
};

export function rpcUrl(chainId: SupportedChainId): string {
  return process.env[`RPC_URL_${chainId}`] || FALLBACK_RPC[chainId];
}
