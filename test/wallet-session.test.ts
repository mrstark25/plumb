import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import {
  isFundingExit,
  parseCaipChainId,
  planDisconnect,
  planPrivySend,
  privyAppId,
} from '@/lib/wallet-session';

describe('parseCaipChainId', () => {
  it('extracts the chain id from a CAIP-2 string', () => {
    // Privy reports "eip155:8453" where the rest of the app expects 8453.
    assert.equal(parseCaipChainId('eip155:8453'), 8453);
    assert.equal(parseCaipChainId('eip155:1'), 1);
    assert.equal(parseCaipChainId('eip155:42161'), 42161);
  });

  it('accepts a bare numeric string or number', () => {
    assert.equal(parseCaipChainId('8453'), 8453);
    assert.equal(parseCaipChainId(8453), 8453);
  });

  it('returns null for anything unusable rather than guessing a chain', () => {
    // A wrong chain id would build a transaction for the wrong network.
    assert.equal(parseCaipChainId(null), null);
    assert.equal(parseCaipChainId(undefined), null);
    assert.equal(parseCaipChainId('eip155:'), null);
    assert.equal(parseCaipChainId('solana:mainnet'), null);
    assert.equal(parseCaipChainId(''), null);
    assert.equal(parseCaipChainId(0), null);
  });
});

describe('privyAppId', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is absent by default, so the app falls back to browser wallets', () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVY_APP_ID', '');
    assert.equal(privyAppId(), null);
  });

  it('treats whitespace as unset rather than passing it to Privy', () => {
    // A blank value in a deployment env var would otherwise reach the SDK and
    // throw during render.
    vi.stubEnv('NEXT_PUBLIC_PRIVY_APP_ID', '   ');
    assert.equal(privyAppId(), null);
  });

  it('returns a configured id', () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVY_APP_ID', 'cm1234567890abcdef');
    assert.equal(privyAppId(), 'cm1234567890abcdef');
  });
});

describe('planDisconnect', () => {
  it('destroys the session only when one exists', () => {
    assert.equal(planDisconnect({ authenticated: true }), 'logout');
  });

  it('drops the wallet when there is no session to destroy', () => {
    // Calling logout on a wallet-only connection asks Privy to destroy a
    // session that was never created: HTTP 400, "Error destroying session".
    assert.equal(planDisconnect({ authenticated: false }), 'drop-wallet');
  });
});

describe('planPrivySend', () => {
  it('routes an embedded wallet through Privy', () => {
    // No extension exists to raise a confirmation, so Privy renders one.
    assert.equal(planPrivySend({ walletClientType: 'privy' }), 'privy');
  });

  it('leaves an external wallet signing in its own extension', () => {
    // Connected *through* Privy, but the user still expects MetaMask's screen.
    assert.equal(planPrivySend({ walletClientType: 'metamask' }), 'provider');
    assert.equal(planPrivySend({ walletClientType: 'phantom' }), 'provider');
  });

  it('falls back to the provider when the type is unknown', () => {
    // A wallet type we have never seen is not evidence that it is embedded.
    assert.equal(planPrivySend({ walletClientType: undefined }), 'provider');
  });
});

describe('isFundingExit', () => {
  it('treats a dismissed modal as a choice, not a failure', () => {
    assert.equal(isFundingExit(new Error('User exited the funding flow')), true);
    assert.equal(isFundingExit(new Error('Funding was cancelled')), true);
    assert.equal(isFundingExit(new Error('Modal closed')), true);
  });

  it('reports a real failure as a failure', () => {
    assert.equal(isFundingExit(new Error('Onramp provider unavailable')), false);
    assert.equal(isFundingExit(new Error('Unsupported destination asset')), false);
  });

  it('does not mistake a non-Error rejection for an exit', () => {
    // An empty message must not match every substring test by accident.
    assert.equal(isFundingExit(undefined), false);
    assert.equal(isFundingExit('exited'), false);
    assert.equal(isFundingExit(new Error('')), false);
  });
});
