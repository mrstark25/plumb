import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { agentAccount, createAgent, forgetAgent, loadAgent } from '@/lib/hyperliquid/agent-wallet';

function stubStorage({ failWrites = false } = {}) {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrites) throw new Error('QuotaExceededError');
      map.set(k, v);
    },
    removeItem: (k: string) => map.delete(k),
  });
  return map;
}

const MASTER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const OTHER = '0x000000000000000000000000000000000000dEaD';

afterEach(() => vi.unstubAllGlobals());

describe('agent wallet', () => {
  it('creates a usable key whose address matches the private key', () => {
    stubStorage();
    const agent = createAgent(MASTER);

    assert.match(agent.privateKey, /^0x[0-9a-f]{64}$/i);
    assert.equal(privateKeyToAccount(agent.privateKey).address, agent.address);
    assert.equal(agentAccount(agent).address, agent.address);
  });

  it('round-trips through storage', () => {
    stubStorage();
    const created = createAgent(MASTER);
    assert.deepEqual(loadAgent(MASTER), created);
  });

  it('keys agents per master account, so switching wallets never reuses one', () => {
    // Reusing an agent across accounts would sign for an account that never
    // approved it.
    stubStorage();
    const first = createAgent(MASTER);
    const second = createAgent(OTHER);

    assert.notEqual(first.address, second.address);
    assert.equal(loadAgent(MASTER)?.address, first.address);
    assert.equal(loadAgent(OTHER)?.address, second.address);
  });

  it('generates a different key every time', () => {
    stubStorage();
    assert.notEqual(createAgent(MASTER).privateKey, createAgent(OTHER).privateKey);
  });

  it('forgets an agent on request', () => {
    stubStorage();
    createAgent(MASTER);
    forgetAgent(MASTER);
    assert.equal(loadAgent(MASTER), null);
  });

  it('rejects a malformed stored value rather than trusting it', () => {
    const map = stubStorage();
    map.set(`liberty.hl-agent.v1:${MASTER.toLowerCase()}`, JSON.stringify({ privateKey: 'nope' }));
    assert.equal(loadAgent(MASTER), null);
  });

  it('returns null when storage holds junk', () => {
    const map = stubStorage();
    map.set(`liberty.hl-agent.v1:${MASTER.toLowerCase()}`, 'not json');
    assert.equal(loadAgent(MASTER), null);
  });

  it('still returns a working agent when storage refuses the write', () => {
    stubStorage({ failWrites: true });
    const agent = createAgent(MASTER);
    assert.equal(privateKeyToAccount(agent.privateKey).address, agent.address);
  });

  it('survives storage being entirely unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    assert.equal(loadAgent(MASTER), null);
    assert.doesNotThrow(() => forgetAgent(MASTER));
  });
});
