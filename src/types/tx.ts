import type { Address, Hex } from 'viem';

/** A single transaction the user's wallet will be asked to sign. */
export interface TxRequest {
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  /** Wei, as a decimal string — bigint does not survive JSON. */
  readonly value: string;
  readonly gasLimit?: string;
}

export type StepKind =
  | 'approve' | 'swap' | 'bridge' | 'deposit' | 'withdraw' | 'transfer'
  | 'sign' | 'order' | 'leverage';

/**
 * An off-chain action the user signs and the server relays.
 *
 * Hyperliquid's exchange is an order book, not a contract: an order is an
 * EIP-712 payload the wallet signs, which is then POSTed to their API. Nothing
 * lands on a chain, so there is no hash to wait on and no receipt to check.
 */
export interface SignedRequest {
  /** EIP-712 payload handed to the wallet verbatim. */
  readonly typedData: {
    readonly domain: Record<string, unknown>;
    readonly types: Record<string, { name: string; type: string }[]>;
    readonly primaryType: string;
    readonly message: Record<string, unknown>;
  };
  /** The action echoed back to the API alongside the signature. */
  readonly action: unknown;
  readonly nonce: number;
  readonly vaultAddress: string | null;
}

/**
 * How a step reaches the world: broadcast as a transaction, or signed and
 * relayed. Discriminated so neither path can be executed by the wrong code.
 */
export type StepExecution =
  | { readonly via: 'transaction'; readonly tx: TxRequest }
  /** The user's wallet signs the typed data, then it is relayed. */
  | { readonly via: 'wallet-sign'; readonly request: SignedRequest }
  /**
   * The browser's Hyperliquid agent key signs, with no wallet popup. Used for
   * orders, which the user's wallet cannot sign at all — see agent-wallet.ts.
   */
  | { readonly via: 'agent-sign'; readonly request: AgentSignedRequest };

/**
 * An L1 action signed locally by the agent key. The hash is computed in the
 * browser from the action itself, so the server cannot alter what gets signed
 * after the fact.
 */
export interface AgentSignedRequest {
  readonly action: unknown;
  readonly nonce: number;
  readonly isMainnet: boolean;
}

export interface TxStep {
  readonly id: string;
  readonly kind: StepKind;
  /** Imperative, short: "Approve USDC", "Swap on Uniswap". */
  readonly label: string;
  readonly detail: string;
  readonly execute: StepExecution;
}

export interface AssetAmount {
  readonly symbol: string;
  readonly address: Address;
  readonly chainId: number;
  readonly decimals: number;
  /** Base units, decimal string. */
  readonly amount: string;
  readonly amountUsd?: number;
}

/** Vault context, present on deposit and withdraw proposals. */
export interface VaultSummary {
  readonly name: string;
  readonly address: Address;
  readonly curator?: string;
  /** Percent, e.g. 6.2 means 6.2%. */
  readonly apy: number;
  readonly totalAssetsUsd?: number;
  /** Naive linear projection on the deposited amount; not compounded. */
  readonly projectedYearlyUsd?: number;
}

/** Leveraged perp context, present on position proposals. */
export interface PositionSummary {
  readonly coin: string;
  readonly isLong: boolean;
  readonly leverage: number;
  readonly maxLeverage: number;
  readonly sizeUnits: number;
  readonly notionalUsd: number;
  /** Collateral actually at risk, notional divided by leverage. */
  readonly marginUsd: number;
  readonly entryPrice: number;
  /** Estimate: ignores fees and funding. Null when it cannot be computed. */
  readonly liquidationPrice: number | null;
  readonly liquidationDistancePct: number | null;
  readonly builderFeePct: number | null;
}

export interface TxProposal {
  readonly id: string;
  readonly kind: 'swap' | 'bridge' | 'deposit' | 'withdraw' | 'transfer' | 'position';
  readonly from: AssetAmount;
  readonly to: AssetAmount;
  /**
   * Where the output lands. Always present so the UI can state it plainly.
   *
   * `isSelfCustody` is false whenever it differs from the connected wallet.
   * For a swap or bridge that is an alarm — the user did not ask to send
   * elsewhere. For a transfer it is the entire intent, so the card presents
   * the destination prominently but neutrally.
   */
  readonly recipient: Address;
  readonly isSelfCustody: boolean;
  /** Worst-case output after slippage, base units. */
  readonly minReceived: string;
  readonly slippageBps: number;
  readonly priceImpactPct?: number;
  readonly estimatedGasUsd?: number;
  readonly estimatedSeconds?: number;
  /** e.g. "Uniswap v3", "Across via LI.FI" */
  readonly route: string;
  readonly provider: string;
  /** Set on deposit and withdraw proposals. */
  readonly vault?: VaultSummary;
  /** Set on leveraged perp proposals. */
  readonly position?: PositionSummary;
  readonly steps: readonly TxStep[];
  /** Plain-English cautions surfaced in the confirmation card. */
  readonly warnings: readonly string[];
  /** Epoch ms after which the quote must be refreshed before signing. */
  readonly expiresAt: number;
}
