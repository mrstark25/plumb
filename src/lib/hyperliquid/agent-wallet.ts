import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Hex } from 'viem';

/**
 * The agent (API) wallet used to sign Hyperliquid orders.
 *
 * WHY THIS EXISTS: Hyperliquid's L1 actions must be signed under EIP-712
 * domain chainId 1337, and MetaMask refuses to sign typed data whose domain
 * chainId is not the chain it is currently on. So the user's own wallet
 * cannot sign orders at all. Hyperliquid's answer — and its own front-end's
 * design — is an agent key that the account authorises once.
 *
 * WHAT THIS KEY CAN DO: place, modify and cancel orders; change leverage.
 * WHAT IT CANNOT DO: withdraw, transfer, or move funds anywhere. Authority is
 * bounded to trading the account it was approved for.
 *
 * WHERE IT LIVES: generated in the browser, stored in that browser's
 * localStorage, and never transmitted anywhere — not to our server, not to
 * Hyperliquid. It is nonetheless a private key sitting in browser storage,
 * which is a real and different exposure from a hardware-backed wallet, and
 * the UI says so before the user opts in.
 */

const STORAGE_PREFIX = 'liberty.hl-agent.v1';

/** Shown in the user's Hyperliquid account so the approval is identifiable. */
export const AGENT_NAME = 'liberty';

export interface StoredAgent {
  readonly privateKey: Hex;
  readonly address: Hex;
  readonly createdAt: number;
}

/** Keyed per master account so switching wallets never reuses an agent. */
function storageKey(masterAddress: string): string {
  return `${STORAGE_PREFIX}:${masterAddress.toLowerCase()}`;
}

export function loadAgent(masterAddress: string): StoredAgent | null {
  try {
    const raw = localStorage.getItem(storageKey(masterAddress));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StoredAgent>;
    if (
      typeof parsed.privateKey !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(parsed.privateKey) ||
      typeof parsed.address !== 'string'
    ) {
      return null;
    }
    return parsed as StoredAgent;
  } catch {
    return null;
  }
}

export function createAgent(masterAddress: string): StoredAgent {
  const privateKey = generatePrivateKey();
  const agent: StoredAgent = {
    privateKey,
    address: privateKeyToAccount(privateKey).address,
    createdAt: Date.now(),
  };

  try {
    localStorage.setItem(storageKey(masterAddress), JSON.stringify(agent));
  } catch {
    // Storage may be unavailable. The agent still works for this session; it
    // simply has to be re-approved next time.
  }
  return agent;
}

export function forgetAgent(masterAddress: string): void {
  try {
    localStorage.removeItem(storageKey(masterAddress));
  } catch {
    // Nothing to do — the key is already unreachable.
  }
}

export function agentAccount(agent: StoredAgent): PrivateKeyAccount {
  return privateKeyToAccount(agent.privateKey);
}
