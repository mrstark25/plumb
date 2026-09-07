import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';

const findVaultByAddress = vi.fn();
const readAllMorphoPositions = vi.fn();
const readMorphoPositions = vi.fn();
const readVaultPosition = vi.fn();
const readContract = vi.fn();
const getUsdPrice = vi.fn();

vi.mock('@/lib/providers/morpho', () => ({
  findVaultByAddress: (...a: unknown[]) => findVaultByAddress(...a),
  findVaults: vi.fn(async () => []),
}));
vi.mock('@/lib/providers/morpho-positions', () => ({
  readAllMorphoPositions: (...a: unknown[]) => readAllMorphoPositions(...a),
  readMorphoPositions: (...a: unknown[]) => readMorphoPositions(...a),
}));
vi.mock('@/lib/erc4626', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/erc4626')>()),
  readVaultPosition: (...a: unknown[]) => readVaultPosition(...a),
}));
vi.mock('@/lib/viem', () => ({
  publicClientFor: () => ({ readContract: (...a: unknown[]) => readContract(...a) }),
}));
vi.mock('@/lib/providers/prices', () => ({ getUsdPrice: (...a: unknown[]) => getUsdPrice(...a) }));

const { buildWithdrawProposal } = await import('@/lib/agent/handlers/vault');

const WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as const;
const VAULT = '0x7802B8C35bFCB5B9a44a8dcC135b8Fda0fEd70F3' as const;
const ASSET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;

const position = {
  chainId: 1, vault: VAULT, name: 'StableMax Vault', shares: 1_000_000n,
  assets: 1_016_831n, assetSymbol: 'USDC', decimals: 6, assetsUsd: 1.01, apyPct: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  findVaultByAddress.mockResolvedValue(null);       // not on Morpho's curated list
  readAllMorphoPositions.mockResolvedValue([position]);
  readMorphoPositions.mockResolvedValue([]);        // nothing on the guessed chain
  readVaultPosition.mockResolvedValue({ shares: 1_000_000n, assets: 1_016_831n, maxWithdraw: 1_016_831n });
  readContract.mockResolvedValue(ASSET);
  getUsdPrice.mockResolvedValue(1);
});

describe('withdrawal resolution', () => {
  it('exits a vault Morpho no longer lists', async () => {
    /*
     * The curated-list gate belongs on deposits: it stops money going into an
     * unvetted vault. Applied to an exit it traps funds the user already holds
     * — a vault that is delisted or drops below the TVL floor would become
     * permanently unwithdrawable through this app. Getting money out is safe.
     */
    const proposal = await buildWithdrawProposal({ vaultAddress: 'StableMax Vault' }, WALLET);

    assert.equal(proposal.kind, 'withdraw');
    assert.equal(proposal.route, 'Morpho · StableMax Vault');
    assert.equal(proposal.from.chainId, 1);
  });

  it('ignores a wrong chain guess when a vault name is given', async () => {
    // The model fills `chain` from the connected wallet, which is a guess. The
    // position is on Ethereum; being connected to Base must not hide it.
    const proposal = await buildWithdrawProposal(
      { chain: 'base', vaultAddress: 'StableMax Vault' },
      WALLET,
    );

    assert.equal(proposal.from.chainId, 1);
  });

  it('needs no vault at all when the wallet holds exactly one', async () => {
    const proposal = await buildWithdrawProposal({}, WALLET);

    assert.equal(proposal.route, 'Morpho · StableMax Vault');
  });

  it('lists the options rather than guessing when several are held', async () => {
    readAllMorphoPositions.mockResolvedValue([
      position,
      { ...position, name: 'Spark Blue Chip USDC Vault', vault: '0x56A76b428244a50513ec81e225a293d128fd581D' },
    ]);

    await assert.rejects(
      buildWithdrawProposal({}, WALLET),
      /more than one Morpho vault.*StableMax Vault.*Spark Blue Chip/s,
    );
  });

  it('says plainly when there is nothing to withdraw', async () => {
    readAllMorphoPositions.mockResolvedValue([]);

    await assert.rejects(buildWithdrawProposal({}, WALLET), /no Morpho vault positions/);
  });
});
