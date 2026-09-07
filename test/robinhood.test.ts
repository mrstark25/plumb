import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { canSwapOn, chainName, getChain, isSupportedChainId, resolveChain, robinhood } from '@/lib/chains';
import { findToken, knownTokens } from '@/lib/tokens';

describe('Robinhood Chain', () => {
  it('is registered with the id read from the chain itself', () => {
    // eth_chainId returned 0x1237.
    assert.equal(robinhood.id, 4663);
    assert.equal(isSupportedChainId(4663), true);
    assert.equal(chainName(4663), 'Robinhood Chain');
  });

  it('uses ETH for gas, not a native token of its own', () => {
    assert.equal(getChain(4663).nativeCurrency.symbol, 'ETH');
    assert.equal(getChain(4663).nativeCurrency.decimals, 18);
  });

  it('declares Multicall3, which every balance read depends on', () => {
    // Confirmed deployed at the canonical address on 4663. Without it viem's
    // batching silently degrades to one RPC call per token.
    assert.equal(
      getChain(4663).contracts?.multicall3?.address,
      '0xcA11bde05977b3631167028862bE2a173976CA11',
    );
  });

  it('resolves from the names a person would type', () => {
    for (const alias of ['robinhood', 'Robinhood Chain', 'RHC', 'hood', '4663']) {
      assert.equal(resolveChain(alias), 4663, `failed on "${alias}"`);
    }
  });

  it('is marked as having no swap venue', () => {
    /*
     * Uniswap answers ResourceNotFound for 4663 and OpenOcean does not cover
     * it. Refusing early gives the user a reason; letting it through gives
     * them an opaque upstream error after two failed round trips.
     */
    assert.equal(canSwapOn(4663), false);
    for (const id of [1, 8453, 42161, 137]) assert.equal(canSwapOn(id), true);
  });

  it('carries only tokens whose symbol and decimals were read on-chain', () => {
    const tokens = knownTokens(4663);
    assert.deepEqual(
      tokens.map((t) => t.symbol).sort(),
      ['ETH', 'LINK', 'USDe', 'WETH'],
    );
    assert.equal(findToken(4663, 'WETH')?.address, '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
    assert.equal(findToken(4663, 'weth')?.decimals, 18);
  });

  it('has no USDC, because there is no canonical one to point at', () => {
    /*
     * The bridged list carries two different contracts both called USDG.
     * Guessing which stablecoin someone means is how people buy an impostor.
     */
    assert.equal(findToken(4663, 'USDC'), undefined);
    assert.equal(findToken(4663, 'USDT'), undefined);
  });
});
