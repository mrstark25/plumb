'use client';

import { useEffect, useState } from 'react';
import { createAgent, loadAgent, type StoredAgent } from '@/lib/hyperliquid/agent-wallet';

/**
 * Ensures a Hyperliquid agent key exists for the connected wallet.
 *
 * Creating the key is free and local — it is only ever *authorised* when the
 * user actually opens a position, at which point they sign for it explicitly.
 * Having the address ready up front lets the server tell whether that
 * one-time authorisation is still outstanding.
 */
export function useHyperliquidAgent(masterAddress: string | null) {
  const [agent, setAgent] = useState<StoredAgent | null>(null);

  useEffect(() => {
    if (!masterAddress) {
      setAgent(null);
      return;
    }
    setAgent(loadAgent(masterAddress) ?? createAgent(masterAddress));
  }, [masterAddress]);

  return agent;
}
