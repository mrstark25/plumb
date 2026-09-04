'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAddFunds, usePrivy, useSendTransaction, useWallets } from '@privy-io/react-auth';
import { createWalletClient, custom, type Address, type Hex, type WalletClient } from 'viem';
import { getChain, isSupportedChainId, type SupportedChainId } from '@/lib/chains';
import { findToken } from '@/lib/tokens';
import {
  parseCaipChainId,
  planDisconnect,
  planPrivySend,
  type FundingRequest,
  type PrivyCapabilities,
  type WalletSession,
} from '@/lib/wallet-session';
import type { TxRequest } from '@/types/tx';

/**
 * Wallet session backed by Privy.
 *
 * Privy covers browser extensions, WalletConnect, and its own embedded
 * wallets created from an email or social login — so a user without any wallet
 * installed can still transact. Whatever they choose, it is exposed as a
 * standard EIP-1193 provider, which viem wraps exactly as it wraps MetaMask.
 * Nothing downstream can tell the difference.
 */
export function usePrivyWallet(): WalletSession {
  const { ready, authenticated, login, logout, connectWallet } = usePrivy();
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();
  const { addFunds } = useAddFunds();

  const [provider, setProvider] = useState<Parameters<typeof custom>[0] | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * MetaMask and Phantom have no programmatic disconnect — Privy's own
   * `disconnect` is documented to no-op for them — so after "Disconnect" the
   * wallet can still be sitting in Privy's list. Without this the button would
   * appear to do nothing. Dismissing locally makes the user's action real; the
   * next connect clears it.
   */
  const [isDismissed, setIsDismissed] = useState(false);

  // The first connected wallet is the active one; Privy orders them by recency.
  const wallet = isDismissed ? null : (wallets[0] ?? null);
  const address = (wallet?.address as Address | undefined) ?? null;
  const chainId = parseCaipChainId(wallet?.chainId ?? null);

  // The provider is fetched asynchronously, so it cannot be derived in render.
  useEffect(() => {
    let cancelled = false;
    if (!wallet) {
      setProvider(null);
      return;
    }

    wallet
      .getEthereumProvider()
      .then((eip1193) => {
        if (!cancelled) setProvider(eip1193 as Parameters<typeof custom>[0]);
      })
      .catch(() => {
        if (!cancelled) setError('Could not reach the connected wallet.');
      });

    return () => {
      cancelled = true;
    };
  }, [wallet]);

  const walletClient: WalletClient | null = useMemo(() => {
    if (!provider || !address || chainId === null || !isSupportedChainId(chainId)) return null;
    return createWalletClient({
      account: address,
      chain: getChain(chainId),
      transport: custom(provider),
    });
  }, [provider, address, chainId]);

  const switchChain = useCallback(
    async (target: SupportedChainId) => {
      if (!wallet) throw new Error('Connect a wallet first.');
      // Privy handles adding an unknown network itself.
      await wallet.switchChain(target);
    },
    [wallet],
  );

  const connect = useCallback(() => {
    setError(null);
    setIsDismissed(false);
    // Authenticated users who have no wallet yet get the wallet picker;
    // everyone else gets the full login modal.
    if (authenticated) connectWallet();
    else login();
  }, [authenticated, connectWallet, login]);

  const disconnect = useCallback(() => {
    setIsDismissed(true);
    setError(null);

    /*
     * Only log out when there is actually a session. Calling logout on a
     * wallet-only connection asks Privy to destroy a session that was never
     * created, which answers 400 and logs "Error destroying session".
     */
    if (planDisconnect({ authenticated }) === 'logout') {
      void logout().catch(() => {
        // The local session is already dismissed; a failed server-side logout
        // is not worth interrupting the user over.
      });
      return;
    }

    // No session, so just drop the wallet. This no-ops on MetaMask and
    // Phantom by design, which is why the dismissal above does the real work.
    try {
      wallets[0]?.disconnect();
    } catch {
      // Nothing to do — the wallet is already dismissed locally.
    }
  }, [authenticated, logout, wallets]);

  const sendPath = planPrivySend({ walletClientType: wallet?.walletClientType });
  const isEmbedded = sendPath === 'privy';

  /**
   * Send through Privy rather than through the EIP-1193 provider.
   *
   * For an embedded wallet there is no extension to pop up, so Privy renders
   * the confirmation itself and manages nonce and gas. Going through viem's
   * `custom` transport would reach the same wallet by a longer route and lose
   * that UI.
   */
  const privySend = useCallback(
    async (tx: TxRequest): Promise<Hex> => {
      if (!address) throw new Error('Connect a wallet first.');
      const { hash } = await sendTransaction(
        {
          to: tx.to,
          data: tx.data,
          value: tx.value,
          chainId: tx.chainId,
          ...(tx.gasLimit ? { gasLimit: tx.gasLimit } : {}),
        },
        { address },
      );
      return hash;
    },
    [sendTransaction, address],
  );

  /**
   * Privy's funding flow — the app's only route from fiat to a token.
   *
   * The destination asset is resolved through the same hand-verified registry
   * every other path uses, because `destination.asset` wants a concrete token
   * address and guessing one is exactly what this app refuses to do. Gas still
   * has to come from somewhere, which the card says rather than this hook
   * pretending otherwise.
   *
   * Both fiat and crypto methods are offered: a user who cannot buy with their
   * currency in their region can still transfer from an exchange, and losing
   * that fallback would strand them.
   */
  const privyAddFunds = useCallback(
    async (request: FundingRequest) => {
      if (!address) throw new Error('Connect a wallet first.');
      const token = findToken(request.chainId, request.asset);
      if (!token) {
        throw new Error(`I have no verified ${request.asset} address on that chain.`);
      }

      await addFunds({
        destination: {
          address,
          chain: `eip155:${request.chainId}`,
          asset: token.address,
        },
        fiat: {
          ...(request.currency ? { source: { defaultAsset: request.currency } } : {}),
          ...(request.amount ? { defaultAmount: request.amount } : {}),
        },
        crypto: {},
      });
    },
    [addFunds, address],
  );

  const privy: PrivyCapabilities | null = useMemo(
    () =>
      address === null
        ? null
        : {
            isEmbedded,
            // External wallets connected through Privy keep signing in their
            // own extension; only embedded wallets route through Privy's UI.
            sendTransaction: isEmbedded ? privySend : null,
            addFunds: privyAddFunds,
          },
    [address, isEmbedded, privySend, privyAddFunds],
  );

  return {
    address,
    chainId,
    isConnected: address !== null,
    isConnecting: !ready,
    error,
    walletClient,
    label: describeWallet(wallet),
    connect,
    disconnect,
    switchChain,
    // Privy renders its own picker, so the button needs no wallet list.
    injected: null,
    privy,
  };
}

/** A short, human name for whatever the user actually connected with. */
function describeWallet(wallet: { walletClientType?: string } | null): string | null {
  if (!wallet) return null;
  const type = wallet.walletClientType;
  if (!type) return null;
  if (type === 'privy') return 'Embedded wallet';

  return type
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
