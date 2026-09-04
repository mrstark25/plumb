import { marketablePrice, roundPerpSize, toWireNumber } from '@/lib/providers/hyperliquid-format';
import type { PerpAsset } from '@/lib/providers/hyperliquid-info';

/**
 * Action builders.
 *
 * Field insertion order matters throughout: the action is msgpack-encoded and
 * hashed, so reordering a key changes the signature. The order here mirrors
 * the reference SDK exactly and should not be "tidied".
 */

/** Hyperliquid rejects anything smaller. */
export const MIN_ORDER_VALUE_USD = 10;

/** Builder fees are quoted in tenths of a basis point; 100 = 0.1%, the cap. */
export const MAX_BUILDER_FEE_TENTHS_BP = 100;

export interface BuilderCode {
  readonly address: string;
  /** Tenths of a basis point. */
  readonly feeTenthsBp: number;
}

export interface MarketOrderInput {
  readonly asset: PerpAsset;
  readonly isBuy: boolean;
  readonly size: number;
  readonly midPrice: number;
  readonly slippageBps: number;
  readonly reduceOnly: boolean;
  readonly builder?: BuilderCode | null;
}

/**
 * A market order is an immediate-or-cancel limit priced through the book. The
 * slippage bound is the only thing stopping "fills immediately" from becoming
 * "fills at any price", so it is always applied.
 */
export function buildMarketOrder(input: MarketOrderInput) {
  const { asset, isBuy, midPrice, slippageBps, reduceOnly } = input;

  const size = roundPerpSize(input.size, asset.szDecimals);
  if (size <= 0) {
    throw new Error(`Size rounds to zero at ${asset.name}'s ${asset.szDecimals} decimals.`);
  }

  const price = marketablePrice({ midPrice, isBuy, slippageBps, szDecimals: asset.szDecimals });

  const order = {
    a: asset.index,
    b: isBuy,
    p: toWireNumber(price),
    s: toWireNumber(size),
    r: reduceOnly,
    t: { limit: { tif: 'Ioc' as const } },
  };

  // `builder` is omitted entirely when unset — an empty object is not the same
  // as absent once msgpack has encoded it.
  return input.builder
    ? {
        type: 'order' as const,
        orders: [order],
        grouping: 'na' as const,
        builder: { b: input.builder.address.toLowerCase(), f: input.builder.feeTenthsBp },
      }
    : { type: 'order' as const, orders: [order], grouping: 'na' as const };
}

export function buildUpdateLeverage(input: {
  asset: PerpAsset;
  leverage: number;
  isCross: boolean;
}) {
  const leverage = Math.floor(input.leverage);
  if (leverage < 1 || leverage > input.asset.maxLeverage) {
    throw new Error(
      `${input.asset.name} allows 1x to ${input.asset.maxLeverage}x; ${input.leverage}x is outside that.`,
    );
  }
  return {
    type: 'updateLeverage' as const,
    asset: input.asset.index,
    isCross: input.isCross,
    leverage,
  };
}

/** User-signed. Posted verbatim as both the EIP-712 message and the action. */
export function buildApproveAgent(input: {
  agentAddress: string;
  agentName: string;
  nonce: number;
  isMainnet: boolean;
  signatureChainId: string;
}) {
  return {
    type: 'approveAgent' as const,
    hyperliquidChain: input.isMainnet ? 'Mainnet' : 'Testnet',
    signatureChainId: input.signatureChainId,
    agentAddress: input.agentAddress.toLowerCase(),
    agentName: input.agentName,
    nonce: input.nonce,
  };
}

export function buildApproveBuilderFee(input: {
  builderAddress: string;
  /** Percent string, e.g. "0.1%". */
  maxFeeRate: string;
  nonce: number;
  isMainnet: boolean;
  signatureChainId: string;
}) {
  return {
    type: 'approveBuilderFee' as const,
    hyperliquidChain: input.isMainnet ? 'Mainnet' : 'Testnet',
    signatureChainId: input.signatureChainId,
    maxFeeRate: input.maxFeeRate,
    builder: input.builderAddress.toLowerCase(),
    nonce: input.nonce,
  };
}

/**
 * Nonces are unix milliseconds and must strictly increase per signing key.
 * A counter guards against two orders in the same millisecond colliding.
 */
let lastNonce = 0;
export function nextNonce(): number {
  const now = Date.now();
  lastNonce = now > lastNonce ? now : lastNonce + 1;
  return lastNonce;
}
