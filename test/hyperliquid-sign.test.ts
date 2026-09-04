import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { actionHash, l1TypedData, splitSignature } from '@/lib/hyperliquid/sign';

/*
 * Vectors from the official hyperliquid-python-sdk. If msgpack encoding, byte
 * layout, or field order ever drift, these fail — and a wrong action hash
 * means every order is silently rejected.
 */
const ACCOUNT = privateKeyToAccount(
  '0x0123456789012345678901234567890123456789012345678901234567890123',
);

describe('actionHash', () => {
  it('reproduces the SDK connectionId vector', () => {
    const action = {
      type: 'order',
      orders: [{ a: 4, b: true, p: '1670.1', s: '0.0147', r: false, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    };
    assert.equal(
      actionHash({ action, nonce: 1677777606040 }),
      '0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908',
    );
  });

  it('changes when field order changes, which is why order is load-bearing', () => {
    const a = { type: 'order', orders: [], grouping: 'na' };
    const b = { grouping: 'na', type: 'order', orders: [] };
    assert.notEqual(actionHash({ action: a, nonce: 1 }), actionHash({ action: b, nonce: 1 }));
  });

  it('includes the vault byte', () => {
    const action = { type: 'dummy', num: 100000000000 };
    const without = actionHash({ action, nonce: 0 });
    const withVault = actionHash({
      action, nonce: 0, vaultAddress: '0x1719884eb866cb12b2686399b0e4b5b3b7c1a5b6',
    });
    assert.notEqual(without, withVault);
  });
});

describe('l1TypedData signatures', () => {
  it('matches the SDK mainnet vector for a dummy action', async () => {
    const typedData = l1TypedData({
      action: { type: 'dummy', num: 100000000000 }, nonce: 0, isMainnet: true,
    });
    const sig = splitSignature(await ACCOUNT.signTypedData(typedData as never));

    assert.equal(BigInt(sig.r), BigInt('0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298'));
    assert.equal(sig.s, '0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8');
    assert.equal(sig.v, 27);
  });

  it('matches the SDK testnet vector, proving the source flag', async () => {
    const typedData = l1TypedData({
      action: { type: 'dummy', num: 100000000000 }, nonce: 0, isMainnet: false,
    });
    const sig = splitSignature(await ACCOUNT.signTypedData(typedData as never));

    assert.equal(BigInt(sig.r), BigInt('0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510'));
    assert.equal(sig.v, 28);
  });

  it('matches the SDK vector for a real order action', async () => {
    const typedData = l1TypedData({
      action: {
        type: 'order',
        orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t: { limit: { tif: 'Gtc' } } }],
        grouping: 'na',
      },
      nonce: 0,
      isMainnet: true,
    });
    const sig = splitSignature(await ACCOUNT.signTypedData(typedData as never));

    assert.equal(sig.r, '0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e');
    assert.equal(sig.s, '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e');
    assert.equal(sig.v, 28);
  });

  it('uses the fixed 1337 domain that MetaMask cannot sign', async () => {
    // This is precisely why orders go through an agent key instead of the
    // user's wallet: MetaMask refuses a domain chainId that is not the active
    // chain, and 1337 never is.
    const typedData = l1TypedData({ action: { type: 'x' }, nonce: 1, isMainnet: true });
    assert.equal(typedData.domain.chainId, 1337);
  });
});
