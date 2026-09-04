import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { decodeFunctionData, erc20Abi } from 'viem';
import { buildTransferProposal } from '@/lib/agent/handlers/transfer';

const OWNER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const FRIEND = '0x000000000000000000000000000000000000dEaD';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ZERO = '0x0000000000000000000000000000000000000000';

/** Stubs balance, allowance, bytecode and price reads for one chain. */
async function stubChain({
  balance = 10n ** 21n,
  code = '0x',
}: { balance?: bigint; code?: string } = {}) {
  const viem = await import('@/lib/viem');
  vi.spyOn(viem, 'publicClientFor').mockReturnValue({
    readContract: vi.fn(async () => balance),
    getBalance: vi.fn(async () => balance),
    getCode: vi.fn(async () => code),
    getEnsAddress: vi.fn(async () => null),
  } as never);

  const prices = await import('@/lib/providers/prices');
  vi.spyOn(prices, 'getUsdPrice').mockResolvedValue(1);
}

afterEach(() => vi.restoreAllMocks());

describe('buildTransferProposal — ERC-20', () => {
  it('encodes transfer(to, amount) against the token contract', async () => {
    await stubChain();
    const proposal = await buildTransferProposal(
      { chain: 'base', token: 'USDC', amount: '25', recipient: FRIEND },
      OWNER,
    );

    const step = proposal.steps[0]!;
    assert.equal(step.execute.via, 'transaction');
    const tx = step.execute.via === 'transaction' ? step.execute.tx : null!;
    assert.equal(proposal.steps.length, 1, 'a transfer needs no approval');
    assert.equal(tx.to, USDC_BASE, 'the call goes to the token, not the recipient');
    assert.equal(tx.value, '0', 'an ERC-20 send carries no native value');

    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    assert.equal(functionName, 'transfer');
    assert.deepEqual(args, [FRIEND, 25_000_000n]);
  });

  it('records the recipient as a first-class field for the card to display', async () => {
    await stubChain();
    const proposal = await buildTransferProposal(
      { chain: 'base', token: 'USDC', amount: '1', recipient: FRIEND.toLowerCase() },
      OWNER,
    );
    assert.equal(proposal.recipient, FRIEND, 'stored checksummed');
    assert.equal(proposal.kind, 'transfer');
  });

  it('warns that a transfer cannot be undone', async () => {
    await stubChain();
    const proposal = await buildTransferProposal(
      { chain: 'base', token: 'USDC', amount: '1', recipient: FRIEND },
      OWNER,
    );
    assert.ok(proposal.warnings[0]?.includes('cannot be undone'));
  });

  it('flags a contract recipient, which may not handle incoming tokens', async () => {
    await stubChain({ code: '0x60806040' });
    const proposal = await buildTransferProposal(
      { chain: 'base', token: 'USDC', amount: '1', recipient: FRIEND },
      OWNER,
    );
    assert.ok(proposal.warnings.some((w) => w.includes('is a contract')));
  });
});

describe('buildTransferProposal — native', () => {
  it('sends value directly with empty calldata', async () => {
    await stubChain();
    const proposal = await buildTransferProposal(
      { chain: 'base', token: 'ETH', amount: '0.5', recipient: FRIEND },
      OWNER,
    );

    const step = proposal.steps[0]!;
    assert.equal(step.execute.via, 'transaction');
    const tx = step.execute.via === 'transaction' ? step.execute.tx : null!;
    assert.equal(tx.to, FRIEND, 'native value goes straight to the recipient');
    assert.equal(tx.data, '0x');
    assert.equal(tx.value, (5n * 10n ** 17n).toString());
  });

  it('refuses to spend the gas money', async () => {
    // Sending the entire balance produces a transaction that cannot pay for
    // itself, so it is refused with the largest safe amount instead.
    await stubChain({ balance: 10n ** 18n });
    await assert.rejects(
      () => buildTransferProposal(
        { chain: 'base', token: 'ETH', amount: '1', recipient: FRIEND },
        OWNER,
      ),
      /too little ETH to pay for gas/,
    );
  });
});

describe('buildTransferProposal — refusals', () => {
  it('refuses the zero address', async () => {
    await stubChain();
    await assert.rejects(
      () => buildTransferProposal({ chain: 'base', token: 'USDC', amount: '1', recipient: ZERO }, OWNER),
      /zero address.*burned/s,
    );
  });

  it("refuses sending a token to its own contract, which loses it", async () => {
    await stubChain();
    await assert.rejects(
      () => buildTransferProposal(
        { chain: 'base', token: 'USDC', amount: '1', recipient: USDC_BASE },
        OWNER,
      ),
      /contract itself.*lost forever/s,
    );
  });

  it('refuses a send to the user own wallet', async () => {
    await stubChain();
    await assert.rejects(
      () => buildTransferProposal({ chain: 'base', token: 'USDC', amount: '1', recipient: OWNER }, OWNER),
      /your own wallet/,
    );
  });

  it('refuses an amount larger than the balance', async () => {
    await stubChain({ balance: 1_000_000n });
    await assert.rejects(
      () => buildTransferProposal({ chain: 'base', token: 'USDC', amount: '999', recipient: FRIEND }, OWNER),
      /balance on Base is 1, less than/,
    );
  });

  it('refuses a malformed destination rather than guessing', async () => {
    await stubChain();
    for (const recipient of ['0xdeadbeef', 'my friend bob', '']) {
      await assert.rejects(
        () => buildTransferProposal({ chain: 'base', token: 'USDC', amount: '1', recipient }, OWNER),
      );
    }
  });

  it('refuses an ENS name that does not resolve', async () => {
    await stubChain();
    await assert.rejects(
      () => buildTransferProposal(
        { chain: 'base', token: 'USDC', amount: '1', recipient: 'definitely-not-registered.eth' },
        OWNER,
      ),
      /could not resolve/,
    );
  });
});
