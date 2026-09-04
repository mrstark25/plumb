import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import { ERC4626_ABI, vaultDepositTx, vaultRedeemTx } from '@/lib/erc4626';
import { matchVaultName, sharesForAssets } from '@/lib/agent/handlers/vault';

const OWNER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const VAULT = '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61';

afterEach(() => vi.restoreAllMocks());

describe('vaultDepositTx', () => {
  it('encodes ERC-4626 deposit(assets, receiver) against the vault itself', () => {
    // Morpho vaults take a direct deposit — no router, no bundler — so the
    // transaction target must be the vault, and the approval spender likewise.
    const tx = vaultDepositTx({ chainId: 8453, vault: VAULT, assets: 10_000_000n, receiver: OWNER });

    assert.equal(tx.to, VAULT);
    assert.equal(tx.value, '0', 'depositing an ERC-20 must never send native value');

    const { functionName, args } = decodeFunctionData({ abi: ERC4626_ABI, data: tx.data });
    assert.equal(functionName, 'deposit');
    assert.deepEqual(args, [10_000_000n, OWNER]);
  });

  it('mints shares to the depositor, never to a third party', () => {
    const tx = vaultDepositTx({ chainId: 1, vault: VAULT, assets: 1n, receiver: OWNER });
    const { args } = decodeFunctionData({ abi: ERC4626_ABI, data: tx.data });
    assert.equal(args?.[1], OWNER);
  });
});

describe('vaultRedeemTx', () => {
  it('exits by redeeming shares rather than withdrawing an asset amount', () => {
    // redeem() cannot revert on a share-price move between quote and signature,
    // and it leaves no dust shares behind on a full exit.
    const tx = vaultRedeemTx({ chainId: 8453, vault: VAULT, shares: 500n, owner: OWNER });

    const { functionName, args } = decodeFunctionData({ abi: ERC4626_ABI, data: tx.data });
    assert.equal(functionName, 'redeem');
    assert.deepEqual(args, [500n, OWNER, OWNER], 'receiver and owner are both the user');
  });
});

describe('sharesForAssets', () => {
  it('converts using the position own ratio', () => {
    // 100 assets backed by 90 shares: half the assets is half the shares.
    const position = { shares: 90n, assets: 100n };
    assert.equal(sharesForAssets(50n, position), 45n);
  });

  it('returns zero for an empty position rather than dividing by zero', () => {
    assert.equal(sharesForAssets(50n, { shares: 0n, assets: 0n }), 0n);
  });

  it('rounds down, so a withdrawal never asks for more shares than it should', () => {
    const position = { shares: 3n, assets: 10n };
    assert.equal(sharesForAssets(1n, position), 0n);
  });
});

describe('ERC-4626 ABI', () => {
  it('declares deposit and redeem with the argument order the standard requires', () => {
    const deposit = ERC4626_ABI.find((f) => f.name === 'deposit');
    assert.deepEqual(deposit?.inputs.map((i) => i.name), ['assets', 'receiver']);

    const redeem = ERC4626_ABI.find((f) => f.name === 'redeem');
    assert.deepEqual(redeem?.inputs.map((i) => i.name), ['shares', 'receiver', 'owner']);
  });
});

/** Stubs the chain so the ERC-4626 view calls return chosen values. */
async function stubVault(reads: Record<string, bigint | string | number>) {
  const viem = await import('@/lib/viem');
  vi.spyOn(viem, 'publicClientFor').mockReturnValue({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => reads[functionName]),
  } as never);
}

describe('readVaultForDeposit', () => {
  it('reads share decimals off the vault rather than assuming the asset decimals', async () => {
    // Morpho vaults use an 18-decimal share token over a 6-decimal asset.
    // Assuming they match would misreport the share count by 1e12.
    await stubVault({
      previewDeposit: 9_228_923_232_541_475_405n,
      maxDeposit: 100_351_476_502_274_382n,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimals: 18,
    });
    const { readVaultForDeposit } = await import('@/lib/erc4626');

    const state = await readVaultForDeposit({
      chainId: 8453, vault: VAULT, receiver: OWNER, assets: 10_000_000n,
    });
    assert.equal(state.shareDecimals, 18);
    assert.equal(state.previewShares, 9_228_923_232_541_475_405n);
  });

  it('surfaces a stubbed maxDeposit of zero rather than hiding it', async () => {
    // Vaults V2 always return 0 here; the handler must treat that as
    // "not reported", so the read layer passes it through untouched.
    await stubVault({
      previewDeposit: 962_838_385_410_550_097n,
      maxDeposit: 0n,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimals: 18,
    });
    const { readVaultForDeposit } = await import('@/lib/erc4626');

    const state = await readVaultForDeposit({
      chainId: 8453, vault: VAULT, receiver: OWNER, assets: 1_000_000n,
    });
    assert.equal(state.maxDeposit, 0n);
    assert.ok(state.previewShares > 0n, 'previewDeposit is the real capacity signal');
  });
});

describe('readVaultPosition', () => {
  it('values a held position in the underlying asset', async () => {
    await stubVault({ balanceOf: 500n, maxWithdraw: 400n, convertToAssets: 550n });
    const { readVaultPosition } = await import('@/lib/erc4626');

    const position = await readVaultPosition({ chainId: 8453, vault: VAULT, owner: OWNER });
    assert.equal(position.shares, 500n);
    assert.equal(position.assets, 550n);
    assert.equal(position.maxWithdraw, 400n);
  });

  it('skips the conversion call when there is nothing held', async () => {
    const convertToAssets = vi.fn();
    await stubVault({ balanceOf: 0n, maxWithdraw: 0n });
    const { readVaultPosition } = await import('@/lib/erc4626');

    const position = await readVaultPosition({ chainId: 8453, vault: VAULT, owner: OWNER });
    assert.equal(position.assets, 0n);
    assert.equal(convertToAssets.mock.calls.length, 0);
  });
});

describe('matchVaultName', () => {
  const vaults = [
    { name: 'Steakhouse High Yield USDC v1.1' },
    { name: 'Steakhouse USDC' },
    { name: 'Gauntlet USDC Core' },
  ];

  it('matches the exact name the agent just showed the user', () => {
    // The case that sent the agent back to the user asking for a 0x address.
    assert.equal(
      matchVaultName(vaults, 'Steakhouse High Yield USDC v1.1')?.name,
      'Steakhouse High Yield USDC v1.1',
    );
  });

  it('ignores case and surrounding whitespace', () => {
    assert.equal(matchVaultName(vaults, '  gauntlet usdc core ')?.name, 'Gauntlet USDC Core');
  });

  it('accepts a prefix only when exactly one vault matches', () => {
    assert.equal(matchVaultName(vaults, 'Gauntlet')?.name, 'Gauntlet USDC Core');
  });

  it('refuses an ambiguous prefix rather than guessing', () => {
    // Two Steakhouse vaults exist. Picking either would put the user's money
    // somewhere they did not choose.
    assert.equal(matchVaultName(vaults, 'Steakhouse'), undefined);
  });

  it('refuses a name that matches nothing', () => {
    assert.equal(matchVaultName(vaults, 'Definitely Not A Vault'), undefined);
    assert.equal(matchVaultName(vaults, ''), undefined);
    assert.equal(matchVaultName(vaults, '   '), undefined);
  });

  it('does not treat an exact duplicate as a match', () => {
    // Two vaults with the same name is ambiguous, not a coin flip.
    const dupes = [{ name: 'Same Vault' }, { name: 'Same Vault' }];
    assert.equal(matchVaultName(dupes, 'Same Vault'), undefined);
  });
});
