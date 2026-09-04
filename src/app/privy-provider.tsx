'use client';

import { PrivyProvider } from '@privy-io/react-auth';
import type { ReactNode } from 'react';
import { SUPPORTED_CHAINS } from '@/lib/chains';
import { privyAppId } from '@/lib/wallet-session';
import { WalletContext } from '@/hooks/useWallet';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';

/**
 * The Privy backend, in its own module so it can be code-split away from the
 * initial bundle. Nothing here is imported unless an app id is configured.
 */
export function PrivyWalletProvider({ children }: { children: ReactNode }) {
  const appId = privyAppId();
  if (!appId) return <>{children}</>;

  return (
    <PrivyProvider
      appId={appId}
      config={{
        /*
         * Which methods are offered. Their order in the modal is largely
         * Privy's own — the email field leads regardless — so this list
         * controls availability, not layout. "Continue with a wallet" covers
         * every injected extension and WalletConnect.
         */
        loginMethods: ['wallet', 'email', 'google', 'passkey'],
        appearance: {
          theme: 'light',
          accentColor: '#2b6bff',
          walletChainType: 'ethereum-only',
        },
        // An embedded wallet only for users who arrive without one.
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        supportedChains: [...SUPPORTED_CHAINS],
        defaultChain: SUPPORTED_CHAINS[1],
      }}
    >
      <SessionBridge>{children}</SessionBridge>
    </PrivyProvider>
  );
}

/** Publishes Privy's session into the shared context. */
function SessionBridge({ children }: { children: ReactNode }) {
  return <WalletContext.Provider value={usePrivyWallet()}>{children}</WalletContext.Provider>;
}
