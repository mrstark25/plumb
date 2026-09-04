'use client';

import { Component, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
  /** Rendered instead if the wallet backend fails to initialise. */
  readonly fallback: ReactNode;
}

/**
 * Keeps a failing wallet backend from taking the app down with it.
 *
 * Privy throws during render on an invalid app id, and a thrown error in a
 * provider unmounts everything below it — chat, prices, yields and history
 * included, none of which need a wallet at all. This catches that and drops
 * back to browser-wallet discovery, so a misconfiguration or a Privy outage
 * costs the login options and nothing else.
 */
export class WalletBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Surfaced for the operator; the user just sees the fallback work.
    console.error('[liberty] wallet backend failed, falling back', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
