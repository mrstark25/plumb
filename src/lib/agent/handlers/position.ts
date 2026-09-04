import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { formatUsd } from '@/lib/format';
import {
  buildApproveAgent, buildApproveBuilderFee, buildMarketOrder, buildUpdateLeverage,
  MAX_BUILDER_FEE_TENTHS_BP, MIN_ORDER_VALUE_USD, nextNonce, type BuilderCode,
} from '@/lib/hyperliquid/actions';
import { AGENT_NAME } from '@/lib/hyperliquid/agent-wallet';
import { estimateLiquidationPrice, liquidationDistancePct } from '@/lib/hyperliquid/liquidation';
import {
  APPROVE_AGENT_TYPES, APPROVE_BUILDER_FEE_TYPES, userSignedDomain,
} from '@/lib/hyperliquid/sign';
import { findPerpAsset, getAccountState, getMidPrice } from '@/lib/providers/hyperliquid-info';
import { roundPerpSize } from '@/lib/providers/hyperliquid-format';
import type { TxProposal, TxStep } from '@/types/tx';
import { QUOTE_TTL_MS } from './shared';

const IS_MAINNET = true;
/** Any chain works for user-signed actions; Arbitrum is Hyperliquid's own default. */
const SIGNATURE_CHAIN_ID = '0xa4b1';
const DEFAULT_SLIPPAGE_BPS = 500;

export interface OpenPositionArgs {
  coin: string;
  side: 'long' | 'short';
  /** Position notional in USD, before leverage is applied to margin. */
  notionalUsd: number;
  leverage?: number;
  slippageBps?: number;
}

export interface PositionContext {
  readonly wallet: Address;
  /** The browser's Hyperliquid agent address, if one exists yet. */
  readonly agentAddress: string | null;
  readonly agentApproved: boolean;
  readonly builderApproved: boolean;
}

function builderCode(): BuilderCode | null {
  const address = process.env.HYPERLIQUID_BUILDER_ADDRESS;
  if (!address || !isAddress(address)) return null;

  const requested = Number(process.env.HYPERLIQUID_BUILDER_FEE_TENTHS_BP ?? '10');
  const fee = Number.isFinite(requested)
    ? Math.min(Math.max(Math.round(requested), 0), MAX_BUILDER_FEE_TENTHS_BP)
    : 10;

  return { address: getAddress(address).toLowerCase(), feeTenthsBp: fee };
}

export async function buildOpenPositionProposal(
  args: OpenPositionArgs,
  context: PositionContext,
): Promise<TxProposal> {
  const asset = await findPerpAsset(args.coin);
  const isLong = args.side === 'long';

  const leverage = clampLeverage(args.leverage ?? 1, asset.maxLeverage, asset.name);
  const notional = Number(args.notionalUsd);
  if (!Number.isFinite(notional) || notional < MIN_ORDER_VALUE_USD) {
    throw new Error(`Hyperliquid's minimum order is $${MIN_ORDER_VALUE_USD}.`);
  }

  const [mid, account] = await Promise.all([
    getMidPrice(asset.name),
    getAccountState(context.wallet),
  ]);

  const marginRequired = notional / leverage;
  if (account.accountValueUsd <= 0) {
    throw new Error(
      'Your Hyperliquid account is empty. Perps trade on HyperCore, so USDC has to be deposited into Hyperliquid first — a wallet balance cannot be used directly.',
    );
  }
  if (account.withdrawableUsd < marginRequired) {
    throw new Error(
      `That position needs about ${formatUsd(marginRequired)} of margin, but only ${formatUsd(account.withdrawableUsd)} is free in your Hyperliquid account.`,
    );
  }

  const size = roundPerpSize(notional / mid, asset.szDecimals);
  if (size <= 0) {
    throw new Error(`${formatUsd(notional)} is too small to buy a tradable size of ${asset.name}.`);
  }

  const builder = builderCode();
  const steps: TxStep[] = [];

  // One-time authorisations. Both are signed by the user's own wallet, which
  // is possible because user-signed actions use the wallet's real chain id.
  if (!context.agentApproved) {
    if (!context.agentAddress) {
      throw new Error('No trading agent is set up in this browser yet. Reconnect your wallet and try again.');
    }
    const nonce = nextNonce();
    const action = buildApproveAgent({
      agentAddress: context.agentAddress,
      agentName: AGENT_NAME,
      nonce,
      isMainnet: IS_MAINNET,
      signatureChainId: SIGNATURE_CHAIN_ID,
    });
    steps.push({
      id: 'hl-approve-agent',
      kind: 'sign',
      label: 'Authorise a trading agent',
      detail:
        'A one-time signature letting a key in this browser place orders for you. It cannot withdraw or move funds.',
      execute: {
        via: 'wallet-sign',
        request: {
          typedData: {
            domain: userSignedDomain(SIGNATURE_CHAIN_ID as Hex),
            types: APPROVE_AGENT_TYPES as never,
            primaryType: 'HyperliquidTransaction:ApproveAgent',
            message: action as never,
          },
          action,
          nonce,
          vaultAddress: null,
        },
      },
    });
  }

  if (builder && !context.builderApproved) {
    const nonce = nextNonce();
    const action = buildApproveBuilderFee({
      builderAddress: builder.address,
      maxFeeRate: `${builder.feeTenthsBp / 1000}%`,
      nonce,
      isMainnet: IS_MAINNET,
      signatureChainId: SIGNATURE_CHAIN_ID,
    });
    steps.push({
      id: 'hl-approve-builder',
      kind: 'sign',
      label: 'Approve the builder fee',
      detail: `A one-time signature capping this app's fee at ${builder.feeTenthsBp / 1000}% of order value.`,
      execute: {
        via: 'wallet-sign',
        request: {
          typedData: {
            domain: userSignedDomain(SIGNATURE_CHAIN_ID as Hex),
            types: APPROVE_BUILDER_FEE_TYPES as never,
            primaryType: 'HyperliquidTransaction:ApproveBuilderFee',
            message: action as never,
          },
          action,
          nonce,
          vaultAddress: null,
        },
      },
    });
  }

  steps.push({
    id: 'hl-leverage',
    kind: 'leverage',
    label: `Set ${asset.name} leverage to ${leverage}x`,
    detail: 'Cross margin. Signed by the trading agent, so there is no wallet prompt.',
    execute: {
      via: 'agent-sign',
      request: {
        action: buildUpdateLeverage({ asset, leverage, isCross: true }),
        nonce: nextNonce(),
        isMainnet: IS_MAINNET,
      },
    },
  });

  steps.push({
    id: 'hl-order',
    kind: 'order',
    label: `${isLong ? 'Open long' : 'Open short'} ${size} ${asset.name}`,
    detail: `Immediate-or-cancel at up to ${(args.slippageBps ?? DEFAULT_SLIPPAGE_BPS) / 100}% from the mid.`,
    execute: {
      via: 'agent-sign',
      request: {
        action: buildMarketOrder({
          asset,
          isBuy: isLong,
          size,
          midPrice: mid,
          slippageBps: args.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
          reduceOnly: false,
          builder,
        }),
        nonce: nextNonce(),
        isMainnet: IS_MAINNET,
      },
    },
  });

  const liquidation = estimateLiquidationPrice({
    entryPrice: mid,
    leverage,
    maxLeverage: asset.maxLeverage,
    isLong,
  });

  const asAsset = {
    symbol: asset.name,
    address: '0x0000000000000000000000000000000000000000' as Address,
    chainId: 0,
    decimals: asset.szDecimals,
    amount: String(Math.round(size * 10 ** asset.szDecimals)),
    amountUsd: notional,
  };

  return {
    id: crypto.randomUUID(),
    kind: 'position',
    from: asAsset,
    to: asAsset,
    recipient: context.wallet,
    isSelfCustody: true,
    minReceived: asAsset.amount,
    slippageBps: args.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    route: `Hyperliquid · ${isLong ? 'long' : 'short'} ${asset.name} ${leverage}x`,
    provider: 'Hyperliquid',
    position: {
      coin: asset.name,
      isLong,
      leverage,
      maxLeverage: asset.maxLeverage,
      sizeUnits: size,
      notionalUsd: notional,
      marginUsd: marginRequired,
      entryPrice: mid,
      liquidationPrice: liquidation,
      liquidationDistancePct:
        liquidation === null ? null : liquidationDistancePct(mid, liquidation),
      builderFeePct: builder ? builder.feeTenthsBp / 1000 : null,
    },
    steps,
    warnings: positionWarnings({ leverage, liquidation, mid, asset: asset.name }),
    expiresAt: Date.now() + QUOTE_TTL_MS,
  };
}

function clampLeverage(requested: number, max: number, coin: string): number {
  const leverage = Math.floor(Number(requested));
  if (!Number.isFinite(leverage) || leverage < 1) return 1;
  if (leverage > max) {
    throw new Error(`${coin} allows at most ${max}x on Hyperliquid; you asked for ${requested}x.`);
  }
  return leverage;
}

function positionWarnings(input: {
  leverage: number;
  liquidation: number | null;
  mid: number;
  asset: string;
}): string[] {
  const warnings: string[] = [];

  if (input.liquidation !== null) {
    const distance = liquidationDistancePct(input.mid, input.liquidation);
    warnings.push(
      `A ${distance.toFixed(1)}% move against you liquidates this position and the margin is gone. Leverage multiplies losses exactly as it multiplies gains.`,
    );
  }
  if (input.leverage >= 10) {
    warnings.push(
      `${input.leverage}x is high. At this size normal intraday volatility in ${input.asset} is enough to close you out.`,
    );
  }
  warnings.push(
    'A market order fills at whatever the book offers within your slippage bound, which may be worse than the price shown.',
  );
  warnings.push(
    'Perps charge funding continuously while the position is open, and the estimated liquidation price ignores it.',
  );
  return warnings;
}
