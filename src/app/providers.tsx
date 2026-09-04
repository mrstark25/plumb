'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { privyAppId } from '@/lib/wallet-session';
import { WalletContext } from '@/hooks/useWallet';
import { useInjectedWallet } from '@/hooks/useInjectedWallet';
import { WalletBoundary } from './wallet-boundary';

/*
 * Privy's SDK bundles connectors for every wallet it supports and is by far
 * the heaviest dependency here. Loading it lazily keeps it out of the critical
 * path: the greeting, history and composer paint immediately, and the connect
 * button becomes live a moment later. Until then `useWallet` returns a
 * disconnected session, which every consumer already handles.
 */
const PrivyWalletProvider = dynamic(
  () => import('./privy-provider').then((m) => m.PrivyWalletProvider),
  { ssr: false },
);

/**
 * Chooses the wallet backend once, at the root.
 *
 * Privy when an app id is configured, direct EIP-6963 discovery otherwise, so
 * a missing configuration degrades to browser wallets rather than to a broken
 * connect button. Privy's hooks throw outside its provider, which is why each
 * backend lives in its own component and only the chosen one is mounted.
 */
export function Providers({ children }: { children: ReactNode }) {
  if (!privyAppId()) return <InjectedWalletProvider>{children}</InjectedWalletProvider>;

  // If Privy cannot start — bad app id, outage — the app keeps working on
  // browser wallets rather than going blank.
  return (
    <WalletBoundary fallback={<InjectedWalletProvider>{children}</InjectedWalletProvider>}>
      <PrivyWalletProvider>{children}</PrivyWalletProvider>
    </WalletBoundary>
  );
}

function InjectedWalletProvider({ children }: { children: ReactNode }) {
  return <WalletContext.Provider value={useInjectedWallet()}>{children}</WalletContext.Provider>;
}
