import { arbitrum, base, mainnet, polygon } from 'viem/chains';
import type { Chain } from 'viem';

export const SUPPORTED_CHAINS = [mainnet, base, arbitrum, polygon] as const satisfies readonly Chain[];

export type SupportedChainId = (typeof SUPPORTED_CHAINS)[number]['id'];

export const CHAIN_IDS = SUPPORTED_CHAINS.map((c) => c.id) as SupportedChainId[];

const CHAIN_BY_ID = new Map<number, Chain>(SUPPORTED_CHAINS.map((c) => [c.id, c]));

/** Human aliases the model (and users) actually type. */
const CHAIN_ALIASES: Record<string, SupportedChainId> = {
  ethereum: 1, eth: 1, mainnet: 1, l1: 1,
  base: 8453,
  arbitrum: 42161, arb: 42161, 'arbitrum one': 42161,
  polygon: 137, matic: 137, pol: 137,
};

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
  if (!alias) throw new Error(`Unknown chain "${input}". Supported: ethereum, base, arbitrum.`);
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
};

export function rpcUrl(chainId: SupportedChainId): string {
  return process.env[`RPC_URL_${chainId}`] || FALLBACK_RPC[chainId];
}
