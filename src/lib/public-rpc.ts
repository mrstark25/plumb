/**
 * The RPC endpoints the *browser* dials, as an explicit list.
 *
 * Single source of truth on purpose: `client-rpc.ts` passes these to viem
 * instead of relying on viem's chain defaults, and `next.config.ts` derives the
 * CSP `connect-src` from the same constant. When those two drift, receipt
 * polling is silently blocked by the browser after the user has already signed
 * and paid gas — which reads as "my transaction is stuck" and invites a costly
 * duplicate submission.
 */
export const PUBLIC_RPC_URLS: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
  137: 'https://polygon-bor-rpc.publicnode.com',
};

/** Origins for the CSP, derived so the allow-list cannot fall out of step. */
export const PUBLIC_RPC_ORIGINS = [
  ...new Set(Object.values(PUBLIC_RPC_URLS).map((url) => new URL(url).origin)),
];
