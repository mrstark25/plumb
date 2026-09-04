'use client';

import { createContext, useContext } from 'react';
import type { WalletSession } from '@/lib/wallet-session';

/**
 * A disconnected session, used before a wallet backend has finished loading.
 *
 * Privy's SDK is large and is loaded lazily, so the page renders and is
 * usable — history, greeting, prompts — while it arrives. Every consumer
 * already handles the disconnected case, so this needs no special handling
 * anywhere else.
 */
const LOADING_SESSION: WalletSession = {
  address: null,
  chainId: null,
  isConnected: false,
  isConnecting: true,
  error: null,
  walletClient: null,
  label: null,
  connect: () => {},
  disconnect: () => {},
  switchChain: async () => {},
  injected: null,
  privy: null,
};

export const WalletContext = createContext<WalletSession>(LOADING_SESSION);

/**
 * The connected wallet, whichever backend supplied it.
 *
 * The backend is chosen once at the root and published through this context,
 * so no component calls a backend-specific hook or knows which is in use.
 */
export function useWallet(): WalletSession {
  return useContext(WalletContext);
}
