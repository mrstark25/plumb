'use client';

import { ConnectButton } from '@/components/wallet/ConnectButton';
import type { WalletSession } from '@/lib/wallet-session';

/**
 * Product header. Deliberately plain: a wordmark, the connection state, and
 * nothing else. Anything more would compete with the transaction cards, which
 * are the only thing on this page the user must read carefully.
 */
interface AppHeaderProps {
  readonly wallet: WalletSession;
  readonly onOpenSidebar: () => void;
  readonly isSidebarOpen: boolean;
}

export function AppHeader({ wallet, onOpenSidebar, isSidebarOpen }: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="app-header-inner">
        {!isSidebarOpen && (
          <button
            type="button"
            className="icon-button header-menu"
            onClick={onOpenSidebar}
            aria-label="Open sidebar"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
              <path d="M9.5 4v16" stroke="currentColor" strokeWidth="1.7" />
            </svg>
          </button>
        )}

        <div className="wordmark">
          {/*
            The mark is the instrument the product is named for: a line
            dropped from a fixed point with a weight on the end. The bob is
            the only amber at rest in the whole header, which is the point —
            it marks true, and nothing else here claims to.
          */}
          <span className="wordmark-mark" aria-hidden="true">
            <svg width="22" height="26" viewBox="0 0 22 26" fill="none">
              <path d="M3 2.5h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
              <path d="M11 2.5v13.5" stroke="currentColor" strokeWidth="1" />
              <path
                d="M11 15.5 14.2 19 11 23.5 7.8 19 11 15.5Z"
                fill="var(--brand)"
              />
            </svg>
          </span>
          <h1>Plumb</h1>
          <span className="wordmark-rule" aria-hidden="true" />
          <span className="wordmark-sub">Execution terminal</span>
        </div>

        <ConnectButton wallet={wallet} />
      </div>
    </header>
  );
}
