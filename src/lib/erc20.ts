import { encodeFunctionData, erc20Abi, maxUint256, type Address } from 'viem';
import { publicClientFor } from './viem';
import { isNative } from './tokens';
import type { SupportedChainId } from './chains';
import type { TxRequest } from '@/types/tx';

/**
 * Some tokens (USDT is the canonical case) revert on an approve that changes a
 * non-zero allowance to another non-zero value, so an existing allowance must
 * be zeroed first.
 */
const RESET_REQUIRED_SYMBOLS = new Set(['USDT']);

export interface ApprovalPlan {
  readonly resetTx?: TxRequest;
  readonly approvalTx?: TxRequest;
}

/**
 * Builds whatever approval transactions are needed for `spender` to move
 * `amount` of `token`. Returns an empty plan for native assets or when the
 * allowance is already sufficient.
 *
 * Approves the exact amount rather than an unlimited allowance: a stale
 * infinite approval to a compromised router is one of the most common ways
 * users lose funds.
 */
export async function planApproval(input: {
  chainId: SupportedChainId;
  token: Address;
  symbol: string;
  owner: Address;
  spender: Address;
  amount: bigint;
}): Promise<ApprovalPlan> {
  const { chainId, token, symbol, owner, spender, amount } = input;
  if (isNative(token)) return {};

  const client = publicClientFor(chainId);
  const current = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  });

  if (current >= amount) return {};

  const approvalTx: TxRequest = {
    chainId,
    to: token,
    data: encodeApprove(spender, amount),
    value: '0',
  };

  if (current > 0n && RESET_REQUIRED_SYMBOLS.has(symbol.toUpperCase())) {
    return {
      resetTx: { chainId, to: token, data: encodeApprove(spender, 0n), value: '0' },
      approvalTx,
    };
  }
  return { approvalTx };
}

function encodeApprove(spender: Address, amount: bigint) {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount === maxUint256 ? maxUint256 : amount],
  });
}

/** Reads on-chain metadata for a token that is not in the local registry. */
export async function readTokenMetadata(chainId: SupportedChainId, token: Address) {
  const client = publicClientFor(chainId);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  return { symbol, decimals };
}

export async function readBalance(input: {
  chainId: SupportedChainId;
  token: Address;
  owner: Address;
}): Promise<bigint> {
  const client = publicClientFor(input.chainId);
  if (isNative(input.token)) return client.getBalance({ address: input.owner });
  return client.readContract({
    address: input.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [input.owner],
  });
}
