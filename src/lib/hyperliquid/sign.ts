import { encode } from '@msgpack/msgpack';
import { hexToBytes, keccak256, numberToBytes, type Hex } from 'viem';

/**
 * Hyperliquid uses two entirely different signing schemes, and mixing them
 * produces a valid signature over the wrong thing — which the API rejects with
 * an unhelpful "does not exist" error.
 *
 * L1 actions (orders, leverage) are signed over a keccak hash of the
 * msgpack-encoded action. User-signed actions (agent and builder approval) are
 * plain EIP-712 over the action object itself.
 */

/** Fixed for L1 actions on both mainnet and testnet. */
export const L1_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
} as const;

export const AGENT_TYPES = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
} as const;

/**
 * keccak256( msgpack(action) ‖ nonce(8, BE) ‖ vaultByte ‖ [expiresAfter] )
 *
 * Key order inside `action` is load-bearing: msgpack preserves insertion
 * order, so reordering fields changes the hash and invalidates the signature.
 */
export function actionHash(input: {
  action: unknown;
  nonce: number;
  vaultAddress?: Hex | null;
  expiresAfter?: number | null;
}): Hex {
  const { action, nonce, vaultAddress = null, expiresAfter = null } = input;

  const bytes: number[] = [
    ...encode(action, { forceIntegerToFloat: false }),
    ...numberToBytes(BigInt(nonce), { size: 8 }),
  ];

  if (vaultAddress === null) bytes.push(0x00);
  else bytes.push(0x01, ...hexToBytes(vaultAddress));

  // The expiry block carries its own leading zero byte, after the vault byte.
  if (expiresAfter !== null) {
    bytes.push(0x00, ...numberToBytes(BigInt(expiresAfter), { size: 8 }));
  }

  return keccak256(new Uint8Array(bytes));
}

/** Typed data for an L1 action, ready to hand to any signer. */
export function l1TypedData(input: {
  action: unknown;
  nonce: number;
  isMainnet: boolean;
  vaultAddress?: Hex | null;
}) {
  return {
    domain: L1_DOMAIN,
    types: AGENT_TYPES,
    primaryType: 'Agent' as const,
    message: {
      // "a" is mainnet, "b" is testnet.
      source: input.isMainnet ? 'a' : 'b',
      connectionId: actionHash({
        action: input.action,
        nonce: input.nonce,
        vaultAddress: input.vaultAddress ?? null,
      }),
    },
  };
}

/**
 * User-signed actions use the wallet's *actual* chain, which is the whole
 * reason they work in MetaMask when L1 actions do not.
 */
export function userSignedDomain(signatureChainId: Hex) {
  return {
    name: 'HyperliquidSignTransaction',
    version: '1',
    chainId: Number.parseInt(signatureChainId, 16),
    verifyingContract: '0x0000000000000000000000000000000000000000' as const,
  };
}

export const APPROVE_AGENT_TYPES = {
  'HyperliquidTransaction:ApproveAgent': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'agentAddress', type: 'address' },
    { name: 'agentName', type: 'string' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

export const APPROVE_BUILDER_FEE_TYPES = {
  'HyperliquidTransaction:ApproveBuilderFee': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'maxFeeRate', type: 'string' },
    { name: 'builder', type: 'address' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

/** Splits a 65-byte signature into the {r,s,v} the API expects. */
export function splitSignature(signature: Hex): { r: Hex; s: Hex; v: number } {
  return {
    r: `0x${signature.slice(2, 66)}`,
    s: `0x${signature.slice(66, 130)}`,
    v: Number.parseInt(signature.slice(130, 132), 16),
  };
}
