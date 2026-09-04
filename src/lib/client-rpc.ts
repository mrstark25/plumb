import { createPublicClient, http, type PublicClient } from 'viem';
import { getChain, type SupportedChainId } from './chains';
import { PUBLIC_RPC_URLS } from './public-rpc';

const clients = new Map<number, PublicClient>();

/**
 * Browser-side read client, used only to wait for receipts.
 *
 * The endpoint is passed explicitly rather than left to viem's chain default:
 * those defaults change between viem releases, and a change would silently
 * fall outside the CSP `connect-src` allow-list.
 */
export function publicClientForChain(chainId: SupportedChainId): PublicClient {
  const existing = clients.get(chainId);
  if (existing) return existing;

  const client = createPublicClient({
    chain: getChain(chainId),
    transport: http(PUBLIC_RPC_URLS[chainId], { retryCount: 2 }),
  }) as PublicClient;

  clients.set(chainId, client);
  return client;
}
