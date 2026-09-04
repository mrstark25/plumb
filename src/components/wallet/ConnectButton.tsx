'use client';

import { useEffect, useRef, useState } from 'react';
import { chainName, CHAIN_IDS, isSupportedChainId } from '@/lib/chains';
import { shortAddress } from '@/lib/format';
import type { WalletSession } from '@/lib/wallet-session';
import './wallet.css';

export function ConnectButton({ wallet }: { wallet: WalletSession }) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const onChainChange = async (value: string) => {
    const next = Number(value);
    if (isSupportedChainId(next)) await wallet.switchChain(next);
  };

  if (wallet.isConnected) {
    return (
      <div className="wallet-status">
        <label className="chain-select">
          <span className="visually-hidden">Active network</span>
          <select
            value={wallet.chainId ?? ''}
            onChange={(event) => void onChainChange(event.target.value)}
          >
            {!isSupportedChainId(wallet.chainId ?? 0) && (
              <option value="">Unsupported network</option>
            )}
            {CHAIN_IDS.map((id) => (
              <option key={id} value={id}>
                {chainName(id)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="account-chip"
          onClick={wallet.disconnect}
          title={wallet.label ? `Connected with ${wallet.label}` : undefined}
        >
          <span className="account-dot" aria-hidden="true" />
          <span className="num">{shortAddress(wallet.address ?? '')}</span>
          <span className="account-action">Disconnect</span>
        </button>
      </div>
    );
  }

  // Privy owns its own modal, so there is nothing to render but one button.
  if (!wallet.injected) {
    return (
      <div className="wallet-connect">
        <button
          type="button"
          className="btn-primary"
          onClick={wallet.connect}
          disabled={wallet.isConnecting}
        >
          {wallet.isConnecting ? 'Loading…' : 'Connect'}
        </button>
        {wallet.error && <p className="wallet-error" role="alert">{wallet.error}</p>}
      </div>
    );
  }

  const detected = wallet.injected;

  return (
    <div className="wallet-connect" ref={rootRef}>
      <button
        type="button"
        className="btn-primary"
        onClick={() => setIsOpen((open) => !open)}
        disabled={wallet.isConnecting}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        {wallet.isConnecting ? 'Connecting…' : 'Connect wallet'}
      </button>

      {isOpen && (
        <div className="wallet-menu" role="menu">
          {detected.available.length === 0 ? (
            <p className="wallet-empty">
              No browser wallet detected. Install MetaMask, Rabby, or another
              EIP-6963 wallet and reload.
            </p>
          ) : (
            detected.available.map((detail) => (
              <button
                key={detail.info.uuid}
                type="button"
                role="menuitem"
                className="wallet-option"
                onClick={async () => {
                  await detected.connectTo(detail);
                  setIsOpen(false);
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={detail.info.icon} alt="" width={22} height={22} />
                <span>{detail.info.name}</span>
              </button>
            ))
          )}
        </div>
      )}

      {wallet.error && <p className="wallet-error" role="alert">{wallet.error}</p>}
    </div>
  );

}
