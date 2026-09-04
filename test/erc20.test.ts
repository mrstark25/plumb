import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { decodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import { planApproval, readBalance } from '@/lib/erc20';
import { NATIVE_ADDRESS } from '@/lib/tokens';

const OWNER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SPENDER = '0x6352a56caadC4F1E25CD6c75970Fa768A3304e64';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

/** Stubs the chain so allowance/balance reads return a chosen value. */
async function stubChain(reads: { allowance?: bigint; balance?: bigint }) {
  const viem = await import('@/lib/viem');
  vi.spyOn(viem, 'publicClientFor').mockReturnValue({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'allowance' ? (reads.allowance ?? 0n) : (reads.balance ?? 0n)),
    getBalance: vi.fn(async () => reads.balance ?? 0n),
  } as never);
}

function decodeApprove(data: `0x${string}`) {
  const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data });
  return { functionName, spender: args?.[0], amount: args?.[1] as bigint };
}

afterEach(() => vi.restoreAllMocks());

describe('planApproval', () => {
  it('needs no approval for a native asset', async () => {
    await stubChain({});
    const plan = await planApproval({
      chainId: 8453, token: NATIVE_ADDRESS, symbol: 'ETH',
      owner: OWNER, spender: SPENDER, amount: 10n ** 18n,
    });
    assert.deepEqual(plan, {});
  });

  it('skips approval when the existing allowance already covers the amount', async () => {
    await stubChain({ allowance: 1_000_000n });
    const plan = await planApproval({
      chainId: 8453, token: USDC, symbol: 'USDC',
      owner: OWNER, spender: SPENDER, amount: 500_000n,
    });
    assert.deepEqual(plan, {});
  });

  it('approves the exact amount, never an unlimited allowance', async () => {
    await stubChain({ allowance: 0n });
    const plan = await planApproval({
      chainId: 8453, token: USDC, symbol: 'USDC',
      owner: OWNER, spender: SPENDER, amount: 1_000_000n,
    });

    const decoded = decodeApprove(plan.approvalTx!.data);
    assert.equal(decoded.functionName, 'approve');
    assert.equal(decoded.amount, 1_000_000n);
    assert.notEqual(decoded.amount, maxUint256);
  });

  it('approves the provider-supplied spender, so the target cannot be substituted', async () => {
    await stubChain({ allowance: 0n });
    const plan = await planApproval({
      chainId: 8453, token: USDC, symbol: 'USDC',
      owner: OWNER, spender: SPENDER, amount: 1n,
    });

    assert.equal(decodeApprove(plan.approvalTx!.data).spender, SPENDER);
    // The approval is sent to the token contract, not the spender.
    assert.equal(plan.approvalTx!.to, USDC);
    assert.equal(plan.approvalTx!.value, '0');
  });

  it('zeroes an existing USDT allowance first, which would otherwise revert', async () => {
    await stubChain({ allowance: 5n });
    const plan = await planApproval({
      chainId: 1, token: USDT, symbol: 'USDT',
      owner: OWNER, spender: SPENDER, amount: 1_000_000n,
    });

    assert.ok(plan.resetTx, 'USDT with a non-zero allowance needs a reset step');
    assert.equal(decodeApprove(plan.resetTx!.data).amount, 0n);
    assert.equal(decodeApprove(plan.approvalTx!.data).amount, 1_000_000n);
  });

  it('does not add a reset step for USDT when the allowance is already zero', async () => {
    await stubChain({ allowance: 0n });
    const plan = await planApproval({
      chainId: 1, token: USDT, symbol: 'USDT',
      owner: OWNER, spender: SPENDER, amount: 1_000_000n,
    });
    assert.equal(plan.resetTx, undefined);
  });

  it('does not add a reset step for tokens that do not need one', async () => {
    await stubChain({ allowance: 5n });
    const plan = await planApproval({
      chainId: 8453, token: USDC, symbol: 'USDC',
      owner: OWNER, spender: SPENDER, amount: 1_000_000n,
    });
    assert.equal(plan.resetTx, undefined);
    assert.ok(plan.approvalTx);
  });
});

describe('readBalance', () => {
  it('reads the native balance for the native sentinel', async () => {
    await stubChain({ balance: 42n });
    assert.equal(await readBalance({ chainId: 8453, token: NATIVE_ADDRESS, owner: OWNER }), 42n);
  });

  it('reads balanceOf for an ERC-20', async () => {
    await stubChain({ balance: 7n });
    assert.equal(await readBalance({ chainId: 8453, token: USDC, owner: OWNER }), 7n);
  });
});
