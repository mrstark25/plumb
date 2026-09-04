'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createWalletClient,
  custom,
  type Address,
  type EIP1193Provider,
  type WalletClient,
} from 'viem';
import { getChain, isSupportedChainId, type SupportedChainId } from '@/lib/chains';
import type { WalletSession } from '@/lib/wallet-session';
import type { EIP6963ProviderDetail } from '@/types/eip6963';

interface WalletState {
  readonly address: Address | null;
  readonly chainId: number | null;
  readonly wallet: EIP6963ProviderDetail | null;
}

const EMPTY: WalletState = { address: null, chainId: null, wallet: null };

/**
 * Wallet connection over EIP-6963 discovery, so every installed browser wallet
 * is offered rather than whichever one won the `window.ethereum` race.
 *
 * This is the fallback backend, used when no Privy app id is configured. It
 * covers browser extensions only — no email, social or embedded wallets.
 */
export function useInjectedWallet(): WalletSession {
  const [available, setAvailable] = useState<EIP6963ProviderDetail[]>([]);
  const [state, setState] = useState<WalletState>(EMPTY);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Discover wallets. Providers may announce at any time, so we keep listening.
  useEffect(() => {
    const seen = new Map<string, EIP6963ProviderDetail>();
    const onAnnounce = (event: CustomEvent<EIP6963ProviderDetail>) => {
      const detail = event.detail;
      if (seen.has(detail.info.uuid)) return;
      seen.set(detail.info.uuid, detail);
      setAvailable([...seen.values()]);
    };

    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    return () => window.removeEventListener('eip6963:announceProvider', onAnnounce);
  }, []);

  // Track account and chain changes from the connected provider.
  useEffect(() => {
    const provider = state.wallet?.provider;
    if (!provider) return;

    const onAccountsChanged = (accounts: unknown) => {
      const [next] = accounts as Address[];
      if (!next) return setState(EMPTY);
      setState((prev) => ({ ...prev, address: next }));
    };
    const onChainChanged = (chainIdHex: unknown) => {
      setState((prev) => ({ ...prev, chainId: Number(chainIdHex as string) }));
    };

    provider.on('accountsChanged', onAccountsChanged);
    provider.on('chainChanged', onChainChanged);
    return () => {
      provider.removeListener('accountsChanged', onAccountsChanged);
      provider.removeListener('chainChanged', onChainChanged);
    };
  }, [state.wallet]);

  const connect = useCallback(async (detail: EIP6963ProviderDetail) => {
    setIsConnecting(true);
    setError(null);
    try {
      const provider = detail.provider;
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as Address[];
      const address = accounts[0];
      if (!address) throw new Error('No account was returned by the wallet.');
      const chainIdHex = (await provider.request({ method: 'eth_chainId' })) as string;
      setState({ address, chainId: Number(chainIdHex), wallet: detail });
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setState(EMPTY);
    setError(null);
  }, []);

  /** Asks the wallet to move to `chainId`, adding the network if unknown to it. */
  const switchChain = useCallback(
    async (chainId: SupportedChainId) => {
      const provider = state.wallet?.provider;
      if (!provider) throw new Error('Connect a wallet first.');
      const hex = `0x${chainId.toString(16)}`;
      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: hex }],
        } as never);
      } catch (cause) {
        if (!isUnknownChainError(cause)) throw cause;
        const chain = getChain(chainId);
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: hex,
              chainName: chain.name,
              nativeCurrency: chain.nativeCurrency,
              rpcUrls: [chain.rpcUrls.default.http[0]],
              blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : [],
            },
          ],
        } as never);
      }
      setState((prev) => ({ ...prev, chainId }));
    },
    [state.wallet],
  );

  const walletClient: WalletClient | null = useMemo(() => {
    const { wallet, address, chainId } = state;
    if (!wallet || !address || chainId === null || !isSupportedChainId(chainId)) return null;
    return createWalletClient({
      account: address,
      chain: getChain(chainId),
      transport: custom(wallet.provider as EIP1193Provider),
    });
  }, [state]);

  return {
    address: state.address,
    chainId: state.chainId,
    isConnected: state.address !== null,
    isConnecting,
    error,
    walletClient,
    label: state.wallet?.info.name ?? null,
    // The picker is rendered by the button itself, so "connect" is a no-op
    // here; choosing a wallet goes through `injected.connectTo`.
    connect: () => {},
    disconnect,
    switchChain,
    injected: { available, connectTo: connect },
    // Privy-only capabilities; the injected backend has none of them.
    privy: null,
  };
}

/** MetaMask and most forks use 4902 for "chain not added". */
function isUnknownChainError(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && (cause as { code: unknown }).code === 4902;
}

function toUserMessage(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    if ((cause as { code: unknown }).code === 4001) return 'Connection request rejected.';
  }
  return cause instanceof Error ? cause.message : 'Could not connect to the wallet.';
}
