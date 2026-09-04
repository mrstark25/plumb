import { createPublicClient, http, type PublicClient } from 'viem';
import { getChain, rpcUrl, type SupportedChainId } from './chains';

const clients = new Map<number, PublicClient>();

/**
 * Server-side read client, memoised per chain. Used for balance reads, ERC-20
 * metadata and allowance checks — never for signing.
 */
export function publicClientFor(chainId: SupportedChainId): PublicClient {
  const existing = clients.get(chainId);
  if (existing) return existing;

  const client = createPublicClient({
    chain: getChain(chainId),
    /*
     * Multicall batching collapses the contract reads a single proposal needs
     * — balance, allowance, and four ERC-4626 views — into one eth_call
     * against Multicall3. On a shared public RPC the un-batched version is
     * enough to trip a rate limit on its own.
     */
    batch: { multicall: { wait: 12, batchSize: 2048 } },
    transport: http(rpcUrl(chainId), {
      batch: true,
      retryCount: 3,
      retryDelay: 250,
      timeout: 12_000,
    }),
  }) as PublicClient;

  clients.set(chainId, client);
  return client;
}
