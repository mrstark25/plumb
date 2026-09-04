import type { Address, Hex, WalletClient } from 'viem';
import type { SupportedChainId } from './chains';
import type { EIP6963ProviderDetail } from '@/types/eip6963';
import type { TxRequest } from '@/types/tx';

/**
 * The things a Privy-backed session can do that a bare EIP-1193 provider
 * cannot. Null on the injected backend.
 *
 * Kept behind a capability object rather than widened into `WalletSession`
 * itself: an interface where one backend always throws is worse than one that
 * says plainly what it does not have. Callers branch on presence, exactly as
 * they already do for `injected`.
 */
/**
 * Every fiat currency Privy's onramp accepts, taken from the SDK's own
 * `SupportedFiatCurrency` union rather than guessed.
 *
 * Held as runtime data, not just a type, because the currency arrives from a
 * language model parsing free text — "in rupees", "INR", "₹" — and an
 * unvalidated string handed to the SDK is exactly the boundary this app
 * validates everywhere else. An unsupported code is reported to the user, not
 * silently dropped into the modal.
 */
export const FIAT_CURRENCIES = [
  'usd', 'eur', 'mxn', 'brl', 'gbp', 'cny', 'jpy', 'inr', 'cad', 'krw', 'aud', 'idr',
  'sar', 'try', 'chf', 'twd', 'sek', 'ngn', 'pln', 'ars', 'aed', 'thb', 'zar', 'dkk',
  'egp', 'myr', 'sgd', 'cop', 'php', 'clp', 'bdt', 'vnd', 'czk', 'ils', 'hkd', 'nzd',
  'pkr', 'ron', 'kzt', 'nok', 'huf', 'uah', 'kwd', 'qar', 'etb', 'mad', 'bgn', 'kes',
  'npr',
] as const;

export type FiatCurrency = (typeof FIAT_CURRENCIES)[number];

/** Normalises "INR", " inr ", "₹" to a code the onramp accepts. */
export function toFiatCurrency(input: string | null | undefined): FiatCurrency | null {
  if (!input) return null;
  const code = input.trim().toLowerCase().replace(/[^a-z]/g, '');
  return (FIAT_CURRENCIES as readonly string[]).includes(code) ? (code as FiatCurrency) : null;
}

/** What the funding card asks the wallet to open. */
export interface FundingRequest {
  readonly chainId: SupportedChainId;
  /** Registry symbol to receive. */
  readonly asset: string;
  /** Fiat the onramp should default to. Null lets the provider decide. */
  readonly currency: FiatCurrency | null;
  /** Fiat amount to prefill, as typed. */
  readonly amount: string | null;
}

export interface PrivyCapabilities {
  /** True when the account is a Privy embedded wallet rather than an extension. */
  readonly isEmbedded: boolean;
  /**
   * Privy's own transaction path, with its confirmation UI and gas handling.
   *
   * Present only for embedded wallets. An external wallet connected *through*
   * Privy still signs in its own extension, so routing it here would replace a
   * familiar confirmation screen with an unfamiliar one for no gain.
   */
  readonly sendTransaction: ((tx: TxRequest) => Promise<Hex>) | null;
  /**
   * Opens Privy's funding flow — card, bank, or a transfer from another
   * wallet. This is the only way a user who logged in with an email and has no
   * other wallet can get assets into the one Privy just created for them, and
   * the only route in this app from fiat to a token.
   */
  readonly addFunds: (request: FundingRequest) => Promise<void>;
}

/**
 * The wallet surface the rest of the app depends on.
 *
 * Both backends — Privy and direct EIP-6963 discovery — produce exactly this,
 * so the executor, the chat shell and every card stay unaware of which is in
 * use. Adding a third would mean writing one more adapter and nothing else.
 */
export interface WalletSession {
  readonly address: Address | null;
  readonly chainId: number | null;
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly error: string | null;
  /** Signs and sends. Null until a supported chain is selected. */
  readonly walletClient: WalletClient | null;
  /** Human label for the connected account: "MetaMask", "Email", "Passkey". */
  readonly label: string | null;
  readonly connect: () => void;
  readonly disconnect: () => void;
  readonly switchChain: (chainId: SupportedChainId) => Promise<void>;
  /**
   * Present only for the injected backend, which has to render its own picker.
   * Privy shows its own modal, so it leaves this null.
   */
  readonly injected: {
    readonly available: readonly EIP6963ProviderDetail[];
    readonly connectTo: (detail: EIP6963ProviderDetail) => Promise<void>;
  } | null;
  /**
   * Present only for the Privy backend. See {@link PrivyCapabilities}.
   */
  readonly privy: PrivyCapabilities | null;
}

/** Privy reports chain ids as CAIP-2 strings such as "eip155:8453". */
export function parseCaipChainId(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;

  const numeric = value.includes(':') ? value.split(':').pop() : value;
  const parsed = Number(numeric);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The Privy app id is a public, client-side identifier — safe to ship in the
 * bundle, which is why it carries the NEXT_PUBLIC prefix.
 *
 * When it is absent the app falls back to direct wallet discovery rather than
 * breaking, so a missing configuration degrades to the previous behaviour
 * instead of an unusable connect button.
 */
export function privyAppId(): string | null {
  const id = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  return id ? id : null;
}

/**
 * How to end a Privy session.
 *
 * Privy distinguishes an authenticated session from a bare wallet connection,
 * and they end differently. Asking it to destroy a session that was never
 * created answers 400 and logs "Error destroying session" — which is what
 * calling logout unconditionally produces.
 */
export function planDisconnect(input: { authenticated: boolean }): 'logout' | 'drop-wallet' {
  return input.authenticated ? 'logout' : 'drop-wallet';
}

/**
 * Which path a Privy-backed wallet should send transactions through.
 *
 * An embedded wallet has no extension to raise a confirmation, so Privy
 * renders one and manages nonce and gas — routing it through the EIP-1193
 * provider would reach the same wallet by a longer road and lose that UI.
 * An external wallet connected through Privy is the opposite case: the user
 * expects MetaMask's confirmation, and replacing it with Privy's would be a
 * surprise on the one screen that must never surprise anyone.
 */
export function planPrivySend(input: { walletClientType: string | undefined }): 'privy' | 'provider' {
  return input.walletClientType === 'privy' ? 'privy' : 'provider';
}

/**
 * Whether a rejected funding flow was the user closing the modal.
 *
 * Privy rejects on exit exactly as it rejects on failure. Dismissing a modal
 * is a decision, not a fault, and showing an error for it would teach users to
 * ignore the errors that matter.
 */
export function isFundingExit(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message.toLowerCase() : '';
  if (message === '') return false;
  return message.includes('exited') || message.includes('cancel') || message.includes('closed');
}
