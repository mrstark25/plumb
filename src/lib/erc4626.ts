import { encodeFunctionData, type Address } from 'viem';
import { publicClientFor } from './viem';
import type { SupportedChainId } from './chains';
import type { TxRequest } from '@/types/tx';

/**
 * The slice of ERC-4626 this app uses. Morpho vaults implement the standard,
 * so a deposit is a plain `approve` + `deposit` against the vault itself —
 * no router, no bundler, no protocol-specific wrapper.
 */
export const ERC4626_ABI = [
  {
    type: 'function', name: 'asset', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'address' }],
  },
  {
    type: 'function', name: 'decimals', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function', name: 'totalAssets', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'previewDeposit', stateMutability: 'view',
    inputs: [{ name: 'assets', type: 'uint256' }], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'previewRedeem', stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'maxDeposit', stateMutability: 'view',
    inputs: [{ name: 'receiver', type: 'address' }], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'maxWithdraw', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'convertToAssets', stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'deposit', stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'withdraw', stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'redeem', stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export interface VaultState {
  /** Shares the deposit would mint, base units. */
  readonly previewShares: bigint;
  /**
   * Largest deposit the vault reports it will accept.
   *
   * Vaults V2 always return 0 here — the standard's max* functions are stubbed
   * out — so zero means "not reported", never "closed". Only a non-zero value
   * is a real cap.
   */
  readonly maxDeposit: bigint;
  readonly assetAddress: Address;
  readonly shareDecimals: number;
}

/**
 * Reads the vault's own view of a prospective deposit.
 *
 * Everything the card shows about size and capacity comes from here rather
 * than from the indexer: a vault can be paused or capped after the API's last
 * snapshot, and proposing a deposit that reverts wastes the user's gas.
 */
export async function readVaultForDeposit(input: {
  chainId: SupportedChainId;
  vault: Address;
  receiver: Address;
  assets: bigint;
}): Promise<VaultState> {
  const client = publicClientFor(input.chainId);
  const contract = { address: input.vault, abi: ERC4626_ABI } as const;

  const [previewShares, maxDeposit, assetAddress, shareDecimals] = await Promise.all([
    client.readContract({ ...contract, functionName: 'previewDeposit', args: [input.assets] }),
    client.readContract({ ...contract, functionName: 'maxDeposit', args: [input.receiver] }),
    client.readContract({ ...contract, functionName: 'asset' }),
    client.readContract({ ...contract, functionName: 'decimals' }),
  ]);

  return { previewShares, maxDeposit, assetAddress, shareDecimals: Number(shareDecimals) };
}

export interface VaultPosition {
  readonly shares: bigint;
  /** What those shares are currently worth in the underlying asset. */
  readonly assets: bigint;
  readonly maxWithdraw: bigint;
}

export async function readVaultPosition(input: {
  chainId: SupportedChainId;
  vault: Address;
  owner: Address;
}): Promise<VaultPosition> {
  const client = publicClientFor(input.chainId);
  const contract = { address: input.vault, abi: ERC4626_ABI } as const;

  const [shares, maxWithdraw] = await Promise.all([
    client.readContract({ ...contract, functionName: 'balanceOf', args: [input.owner] }),
    client.readContract({ ...contract, functionName: 'maxWithdraw', args: [input.owner] }),
  ]);
  const assets = shares > 0n
    ? await client.readContract({ ...contract, functionName: 'convertToAssets', args: [shares] })
    : 0n;

  return { shares, assets, maxWithdraw };
}

export function encodeDeposit(assets: bigint, receiver: Address): `0x${string}` {
  return encodeFunctionData({ abi: ERC4626_ABI, functionName: 'deposit', args: [assets, receiver] });
}

/**
 * Exits by shares rather than by assets. `redeem` is the safer of the two
 * exits for a full withdrawal: asking for an exact asset amount can revert if
 * the share price moves between the quote and the signature, whereas redeeming
 * shares the user actually holds cannot.
 */
export function encodeRedeem(shares: bigint, receiver: Address, owner: Address): `0x${string}` {
  return encodeFunctionData({
    abi: ERC4626_ABI,
    functionName: 'redeem',
    args: [shares, receiver, owner],
  });
}

export function vaultDepositTx(input: {
  chainId: number;
  vault: Address;
  assets: bigint;
  receiver: Address;
}): TxRequest {
  return {
    chainId: input.chainId,
    to: input.vault,
    data: encodeDeposit(input.assets, input.receiver),
    value: '0',
  };
}

export function vaultRedeemTx(input: {
  chainId: number;
  vault: Address;
  shares: bigint;
  owner: Address;
}): TxRequest {
  return {
    chainId: input.chainId,
    to: input.vault,
    data: encodeRedeem(input.shares, input.owner, input.owner),
    value: '0',
  };
}
