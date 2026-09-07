import { getAddress, isAddress, type Address } from 'viem';
import { chainName, resolveChain, type SupportedChainId } from '@/lib/chains';
import { formatTokenAmount, parseAmount } from '@/lib/format';
import { planApproval, readBalance } from '@/lib/erc20';
import { ERC4626_ABI, readVaultForDeposit, readVaultPosition, vaultDepositTx, vaultRedeemTx } from '@/lib/erc4626';
import { publicClientFor } from '@/lib/viem';
import { findVaultByAddress, findVaults } from '@/lib/providers/morpho';
import { readAllMorphoPositions, readMorphoPositions } from '@/lib/providers/morpho-positions';
import { getUsdPrice } from '@/lib/providers/prices';
import type { MorphoVault } from '@/lib/providers/vault-types';
import type { TxProposal, TxStep } from '@/types/tx';
import { QUOTE_TTL_MS } from './shared';

export interface FindVaultsArgs {
  asset?: string;
  chain?: string;
  amountUsd?: number;
}

export async function listVaults(args: FindVaultsArgs) {
  const chainIds = args.chain ? [resolveChain(args.chain)] : undefined;
  const vaults = await findVaults({
    ...(chainIds ? { chainIds } : {}),
    ...(args.asset ? { assetSymbol: args.asset } : {}),
    ...(args.amountUsd !== undefined ? { amountUsd: args.amountUsd } : {}),
  });

  const parts = ['Morpho vaults'];
  if (args.asset) parts.push(`for ${args.asset.toUpperCase()}`);
  if (args.chain) parts.push(`on ${chainName(resolveChain(args.chain))}`);
  return { vaults, title: parts.join(' ') };
}

export interface DepositArgs {
  chain: string;
  asset: string;
  amount: string;
  vaultAddress?: string;
}

export async function buildDepositProposal(args: DepositArgs, wallet: Address): Promise<TxProposal> {
  const chainId = resolveChain(args.chain);
  const vault = await selectVault(chainId, args.asset, args.vaultAddress);

  const { asset } = vault;
  const amountIn = parseAmount(args.amount, asset.decimals);

  const balance = await readBalance({ chainId, token: asset.address, owner: wallet });
  if (balance < amountIn) {
    throw new Error(
      `Your ${asset.symbol} balance on ${chainName(chainId)} is ${formatTokenAmount(balance, asset.decimals)}, less than the ${args.amount} you asked to deposit.`,
    );
  }

  // The vault's own view, not the indexer's: a vault can be paused or capped
  // after the API's last snapshot, and a deposit that reverts wastes gas.
  const state = await readVaultForDeposit({
    chainId,
    vault: vault.address,
    receiver: wallet,
    assets: amountIn,
  });

  // Vaults V2 always report maxDeposit as 0, so only a non-zero value is a
  // real cap. Gating on `maxDeposit < amount` would reject every V2 deposit.
  if (state.maxDeposit > 0n && state.maxDeposit < amountIn) {
    throw new Error(
      `${vault.name} will only accept ${formatTokenAmount(state.maxDeposit, asset.decimals)} ${asset.symbol} more at the moment.`,
    );
  }

  // previewDeposit works on both versions and is the real capacity signal: a
  // vault that would mint nothing will revert on deposit.
  if (state.previewShares === 0n) {
    throw new Error(
      `${vault.name} would mint no shares for that amount — it is either too small to deposit or the vault is not accepting deposits.`,
    );
  }

  const approval = await planApproval({
    chainId,
    token: asset.address,
    symbol: asset.symbol,
    owner: wallet,
    spender: vault.address,
    amount: amountIn,
  });

  const steps: TxStep[] = [];
  if (approval.resetTx) {
    steps.push({
      id: 'vault-reset',
      kind: 'approve',
      label: `Reset ${asset.symbol} allowance`,
      detail: `${asset.symbol} requires clearing an existing allowance first.`,
      execute: { via: 'transaction', tx: approval.resetTx },
    });
  }
  if (approval.approvalTx) {
    steps.push({
      id: 'vault-approve',
      kind: 'approve',
      label: `Approve ${asset.symbol}`,
      detail: `Lets the vault move exactly ${args.amount} ${asset.symbol} — not an unlimited allowance.`,
      execute: { via: 'transaction', tx: approval.approvalTx },
    });
  }
  steps.push({
    id: 'vault-deposit',
    kind: 'deposit',
    label: `Deposit into ${vault.name}`,
    detail: `ERC-4626 deposit direct to the vault. Shares are minted to your own address.`,
    execute: { via: 'transaction', tx: vaultDepositTx({ chainId, vault: vault.address, assets: amountIn, receiver: wallet }) },
  });

  const price = await getUsdPrice(chainId, asset.address);
  const amountUsd = price ? (Number(amountIn) / 10 ** asset.decimals) * price : undefined;

  return {
    id: crypto.randomUUID(),
    kind: 'deposit',
    from: {
      symbol: asset.symbol,
      address: asset.address,
      chainId,
      decimals: asset.decimals,
      amount: amountIn.toString(),
      ...(amountUsd !== undefined ? { amountUsd } : {}),
    },
    to: {
      symbol: vault.symbol || 'shares',
      address: vault.address,
      chainId,
      decimals: state.shareDecimals,
      amount: state.previewShares.toString(),
    },
    recipient: wallet,
    isSelfCustody: true,
    // ERC-4626 mints at the current share price; there is no slippage leg.
    minReceived: state.previewShares.toString(),
    slippageBps: 0,
    route: `Morpho · ${vault.name}`,
    provider: 'Morpho',
    vault: {
      name: vault.name,
      address: vault.address,
      ...(vault.curator ? { curator: vault.curator } : {}),
      apy: vault.netApy,
      totalAssetsUsd: vault.totalAssetsUsd,
      ...(amountUsd !== undefined ? { projectedYearlyUsd: amountUsd * (vault.netApy / 100) } : {}),
    },
    steps,
    warnings: depositWarnings(vault, Boolean(approval.approvalTx)),
    expiresAt: Date.now() + QUOTE_TTL_MS,
  };
}

export interface WithdrawArgs {
  /**
   * Optional. The wallet's own positions say which chain a vault is on, so
   * asking the user is asking a question the app can already answer.
   */
  chain?: string;
  /**
   * Optional. An address, a vault name, or nothing at all — a withdrawal can
   * be resolved from the positions the wallet actually holds.
   */
  vaultAddress?: string;
  amount?: string;
}

/** Words people use for a full exit. `parseAmount` would throw on all of them. */
const FULL_EXIT_WORDS = new Set(['all', 'max', 'everything', 'full', 'entire', 'whole']);

export function isFullExitAmount(amount: string | undefined): boolean {
  if (amount === undefined || amount.trim() === '') return true;
  return FULL_EXIT_WORDS.has(amount.trim().toLowerCase());
}

export async function buildWithdrawProposal(args: WithdrawArgs, wallet: Address): Promise<TxProposal> {
  const { chainId, vault } = await resolveWithdrawVault(wallet, args.chain, args.vaultAddress);
  const vaultAddress = vault.address;

  const position = await readVaultPosition({ chainId, vault: vaultAddress, owner: wallet });
  if (position.shares === 0n) {
    throw new Error(`You have no position in ${vault.name}.`);
  }

  // Exit by shares, not by asset amount: redeeming shares the user actually
  // holds cannot revert on a share-price move between quote and signature.
  const isFullExit = isFullExitAmount(args.amount);
  const shares = isFullExit
    ? position.shares
    : sharesForAssets(parseAmount(args.amount!, vault.asset.decimals), position);

  if (shares > position.shares) {
    throw new Error(
      `You only hold ${formatTokenAmount(position.assets, vault.asset.decimals)} ${vault.asset.symbol} in ${vault.name}.`,
    );
  }

  const assetsOut = isFullExit ? position.assets : parseAmount(args.amount!, vault.asset.decimals);
  if (position.maxWithdraw < assetsOut) {
    throw new Error(
      `${vault.name} can only release ${formatTokenAmount(position.maxWithdraw, vault.asset.decimals)} ${vault.asset.symbol} right now — its markets are fully utilised. Try a smaller amount or wait for liquidity.`,
    );
  }

  const price = await getUsdPrice(chainId, vault.asset.address);
  const amountUsd = price ? (Number(assetsOut) / 10 ** vault.asset.decimals) * price : undefined;

  return {
    id: crypto.randomUUID(),
    kind: 'withdraw',
    from: {
      symbol: vault.asset.symbol,
      address: vault.asset.address,
      chainId,
      decimals: vault.asset.decimals,
      amount: assetsOut.toString(),
      ...(amountUsd !== undefined ? { amountUsd } : {}),
    },
    to: {
      symbol: vault.asset.symbol,
      address: vault.asset.address,
      chainId,
      decimals: vault.asset.decimals,
      amount: assetsOut.toString(),
      ...(amountUsd !== undefined ? { amountUsd } : {}),
    },
    recipient: wallet,
    isSelfCustody: true,
    minReceived: assetsOut.toString(),
    slippageBps: 0,
    route: `Morpho · ${vault.name}`,
    provider: 'Morpho',
    vault: {
      name: vault.name,
      address: vault.address,
      ...(vault.curator ? { curator: vault.curator } : {}),
      apy: vault.netApy,
      totalAssetsUsd: vault.totalAssetsUsd,
    },
    steps: [
      {
        id: 'vault-redeem',
        kind: 'withdraw',
        label: isFullExit ? `Exit ${vault.name}` : `Withdraw from ${vault.name}`,
        detail: `Redeems ${formatTokenAmount(shares, 18)} vault shares back to ${vault.asset.symbol}.`,
        execute: { via: 'transaction', tx: vaultRedeemTx({ chainId, vault: vaultAddress, shares, owner: wallet }) },
      },
    ],
    warnings: isFullExit ? [] : ['A partial exit leaves the rest of your position earning at the vault’s variable rate.'],
    expiresAt: Date.now() + QUOTE_TTL_MS,
  };
}

/**
 * Which vault to exit.
 *
 * A withdrawal is the one case where the app already knows the answer: the
 * wallet's Morpho positions say exactly which vaults it is in. Demanding a
 * contract address for a vault the user is already inside — which is what this
 * used to do, and what sent the agent back asking the user to paste a `0x`
 * string — is asking a question the app can answer itself.
 *
 * Resolution runs from most to least specific: an explicit address, then a
 * name matched against the user's own positions, then the single position they
 * hold. Ambiguity is reported with the actual options rather than guessed at,
 * because withdrawing from the wrong vault moves real money.
 */
async function resolveWithdrawVault(
  owner: Address,
  chain: string | undefined,
  requested: string | undefined,
): Promise<{ chainId: SupportedChainId; vault: MorphoVault }> {
  const named = chain ? resolveChain(chain) : undefined;

  if (requested && isAddress(requested)) {
    // An address is only meaningful with a chain; default to where the wallet
    // actually holds something at that address rather than refusing.
    const chainId = named ?? (await chainHoldingVault(owner, getAddress(requested)));
    const vault = await findVaultByAddress(chainId, getAddress(requested));
    if (!vault) {
      throw new Error(
        `I could not find a listed Morpho vault at ${getAddress(requested)} on ${chainName(chainId)}.`,
      );
    }
    return { chainId, vault };
  }

  /*
   * A vault name outranks the chain.
   *
   * The model fills `chain` from whatever the wallet happens to be connected
   * to, which is a guess, not a statement. Searching only there meant a user
   * connected to Base could not exit a vault they hold on Ethereum — the
   * position was found, named back to them, and then declared missing. When a
   * name is given it is the stronger signal, so every chain is searched and
   * the chain hint is used only to break a tie.
   */
  const searchAll = requested !== undefined || named === undefined;
  const found = searchAll
    ? await readAllMorphoPositions(owner)
    : await readMorphoPositions(named, owner);

  const positions =
    named && found.some((position) => position.chainId === named) && !requested
      ? found.filter((position) => position.chainId === named)
      : found;

  const where = named && !searchAll ? ` on ${chainName(named)}` : '';
  if (positions.length === 0) {
    throw new Error(`You have no Morpho vault positions${where}, so there is nothing to withdraw.`);
  }

  const byName = requested ? matchVaultName(positions, requested) : undefined;
  // With a name matched on several chains, the chain hint breaks the tie.
  const chosen =
    byName ??
    (requested
      ? undefined
      : positions.length === 1
        ? positions[0]
        : undefined);

  if (!chosen) {
    const held = positions
      .map((position) => `${position.name} (${chainName(position.chainId)})`)
      .join(', ');
    throw new Error(
      requested
        ? `You have no position in a vault called "${requested}"${where}. You are in: ${held}.`
        : `You have positions in more than one Morpho vault${where} — tell me which to exit: ${held}.`,
    );
  }

  const listed = await findVaultByAddress(chosen.chainId, chosen.vault);
  /*
   * A withdrawal is never gated on the curated list.
   *
   * `findVaultByAddress` only returns vaults Morpho marks `listed: true` and
   * that clear a TVL floor, which is exactly right for a deposit — it is what
   * stops this app putting money into an unvetted vault. Applied to an exit it
   * does the opposite of protecting anyone: a vault that is delisted, shrinks
   * below the floor, or is simply missing from the indexer would leave a
   * position permanently unwithdrawable through Plumb. Getting money out is
   * always safe. The shares are already held; the vault is read from the chain
   * rather than the index.
   */
  return {
    chainId: chosen.chainId,
    vault: listed ?? (await vaultFromPosition(chosen)),
  };
}

/**
 * Builds the minimum viable vault record for an exit, straight from the chain.
 *
 * Only what a withdrawal actually needs: the asset, its decimals and a name.
 * APY and TVL are unknown here and are reported as zero rather than guessed —
 * nothing on a withdrawal card depends on them, and inventing a rate for a
 * vault the indexer has dropped would be the worst place to start.
 */
async function vaultFromPosition(position: {
  chainId: SupportedChainId;
  vault: Address;
  name: string;
  assetSymbol: string;
  decimals: number;
}): Promise<MorphoVault> {
  const asset = await publicClientFor(position.chainId).readContract({
    address: position.vault,
    abi: ERC4626_ABI,
    functionName: 'asset',
  });

  return {
    address: position.vault,
    chainId: position.chainId,
    name: position.name,
    symbol: '',
    asset: { address: asset, symbol: position.assetSymbol, decimals: position.decimals },
    netApy: 0,
    totalAssetsUsd: 0,
    // Unlisted by definition — the card says so instead of implying vetting.
    isVetted: false,
  };
}

/** Which chain the wallet actually holds shares of this vault on. */
async function chainHoldingVault(owner: Address, vaultAddress: Address): Promise<SupportedChainId> {
  const positions = await readAllMorphoPositions(owner);
  const held = positions.find(
    (position) => position.vault.toLowerCase() === vaultAddress.toLowerCase(),
  );
  if (!held) {
    throw new Error(
      `You hold no shares of ${vaultAddress} on any chain I support, so tell me the chain if you meant to withdraw there anyway.`,
    );
  }
  return held.chainId;
}

/** Converts an asset amount to shares using the position's own current ratio. */
export function sharesForAssets(assets: bigint, position: { shares: bigint; assets: bigint }): bigint {
  if (position.assets === 0n) return 0n;
  return (assets * position.shares) / position.assets;
}

/** How many listed vaults to search when a deposit names one. */
const NAME_MATCH_LIMIT = 25;

async function selectVault(
  chainId: SupportedChainId,
  assetSymbol: string,
  requested: string | undefined,
): Promise<MorphoVault> {
  if (requested === undefined) return bestVault(chainId, assetSymbol);

  if (isAddress(requested)) {
    const vault = await findVaultByAddress(chainId, getAddress(requested));
    if (!vault) {
      throw new Error(
        `${requested} is not a listed Morpho vault on ${chainName(chainId)}. I won't deposit into a vault I can't verify.`,
      );
    }
    return vault;
  }

  /*
   * A name rather than an address.
   *
   * Refusing here used to send the agent back to the user asking for a 0x
   * address — for a vault it had just listed by name a moment earlier. That
   * is an unanswerable question for most people and it stalled the deposit
   * entirely.
   *
   * Matching by name is no weaker than matching by address: both resolve
   * against Morpho's listed set, so an unlisted or invented vault still gets
   * refused. The name is never trusted as a contract, only as a lookup key.
   */
  return vaultByName(chainId, assetSymbol, requested);
}

async function bestVault(
  chainId: SupportedChainId,
  assetSymbol: string,
): Promise<MorphoVault> {
  const [best] = await findVaults({ chainIds: [chainId], assetSymbol, limit: 1 });
  if (!best) {
    throw new Error(
      `There is no Morpho vault for ${assetSymbol.toUpperCase()} on ${chainName(chainId)} that clears the size threshold I use.`,
    );
  }
  return best;
}

async function vaultByName(
  chainId: SupportedChainId,
  assetSymbol: string,
  requested: string,
): Promise<MorphoVault> {
  const candidates = await findVaults({
    chainIds: [chainId],
    assetSymbol,
    limit: NAME_MATCH_LIMIT,
  });
  const match = matchVaultName(candidates, requested);
  if (!match) {
    throw new Error(
      `I could not find a listed Morpho ${assetSymbol.toUpperCase()} vault called "${requested}" on ${chainName(chainId)}. Ask me to list the vaults and name one from that list, or give its contract address.`,
    );
  }
  return match;
}

/**
 * Exact name first, then a unique prefix.
 *
 * A prefix is only accepted when exactly one vault matches: "Steakhouse"
 * where two Steakhouse vaults exist is genuinely ambiguous, and picking one
 * would put the user's money somewhere they did not choose.
 */
export function matchVaultName<T extends { name: string }>(
  vaults: readonly T[],
  requested: string,
): T | undefined {
  const wanted = requested.trim().toLowerCase();
  if (wanted === '') return undefined;

  const exact = vaults.filter((vault) => vault.name.trim().toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;

  const prefixed = vaults.filter((vault) => vault.name.trim().toLowerCase().startsWith(wanted));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

function depositWarnings(vault: MorphoVault, hasApproval: boolean): string[] {
  const warnings: string[] = [
    `${vault.curator ? `${vault.curator} decides` : 'The curator decides'} which lending markets this vault enters. That selection is the risk you are taking, not the vault wrapper.`,
    'The APY is variable and not guaranteed. It can fall at any time.',
  ];

  if (vault.totalAssetsUsd < 20_000_000) {
    warnings.push('This is a comparatively small vault, so exiting a large position may take longer.');
  }
  if (hasApproval) {
    warnings.push(`You will sign two transactions: an approval, then the deposit itself.`);
  }
  return warnings;
}
