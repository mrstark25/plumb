import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import {
  bucketFor, deriveTitle, groupByRecency, loadConversations,
  pruneToLimit, saveConversations, type Conversation,
} from '@/lib/conversations';

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: crypto.randomUUID(),
    title: 'Chat',
    messages: [],
    createdAt: 0,
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** Minimal in-memory localStorage, optionally one that refuses to write. */
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

afterEach(() => vi.unstubAllGlobals());

describe('deriveTitle', () => {
  it('uses the first line of the opening message', () => {
    assert.equal(deriveTitle('Swap 0.1 ETH to USDC\nand tell me the fee'), 'Swap 0.1 ETH to USDC');
  });

  it('breaks long titles at a word boundary rather than mid-word', () => {
    const source = 'Deposit one thousand USDC into whichever Morpho vault yields most';
    const title = deriveTitle(source);

    assert.ok(title.endsWith('…'));
    assert.ok(title.length <= 49);

    // The kept text must be a whole-word prefix: the source character right
    // after it is a space, so no word was cut in half.
    const kept = title.slice(0, -1);
    assert.ok(source.startsWith(kept), `"${kept}" should prefix the source`);
    assert.equal(source[kept.length], ' ', `clipped mid-word: "${title}"`);
  });

  it('does not clip a title that already fits', () => {
    assert.equal(deriveTitle('Bridge 500 USDC to Base'), 'Bridge 500 USDC to Base');
  });

  it('clips a single unbroken run rather than overflowing', () => {
    const title = deriveTitle('A'.repeat(120));
    assert.ok(title.length <= 49);
    assert.ok(title.endsWith('…'));
  });

  it('falls back for an empty message', () => {
    assert.equal(deriveTitle('   '), 'New chat');
  });
});

describe('bucketFor', () => {
  const now = new Date('2026-08-30T12:00:00Z').getTime();
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const day = 86_400_000;

  it('places timestamps in the right recency bucket', () => {
    assert.equal(bucketFor(now, now), 'Today');
    assert.equal(bucketFor(startOfToday, now), 'Today');
    assert.equal(bucketFor(startOfToday - 1, now), 'Yesterday');
    assert.equal(bucketFor(startOfToday - day, now), 'Yesterday');
    assert.equal(bucketFor(startOfToday - day - 1, now), 'Previous 7 days');
    assert.equal(bucketFor(startOfToday - 8 * day, now), 'Older');
  });
});

describe('groupByRecency', () => {
  const now = new Date('2026-08-30T12:00:00Z').getTime();
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);

  it('orders groups by recency and conversations newest-first', () => {
    const groups = groupByRecency(
      [
        conversation({ title: 'old', updatedAt: startOfToday - 10 * 86_400_000 }),
        conversation({ title: 'earlier today', updatedAt: startOfToday + 1000 }),
        conversation({ title: 'later today', updatedAt: startOfToday + 5000 }),
      ],
      now,
    );

    assert.deepEqual(groups.map((g) => g.label), ['Today', 'Older']);
    assert.deepEqual(groups[0]?.conversations.map((c) => c.title), ['later today', 'earlier today']);
  });

  it('omits empty buckets rather than rendering blank headings', () => {
    const groups = groupByRecency([conversation({ updatedAt: now })], now);
    assert.deepEqual(groups.map((g) => g.label), ['Today']);
  });

  it('handles an empty history', () => {
    assert.deepEqual(groupByRecency([], now), []);
  });
});

describe('pruneToLimit', () => {
  it('keeps the 40 most recent conversations', () => {
    const many = Array.from({ length: 50 }, (_, i) => conversation({ title: `c${i}`, updatedAt: i }));
    const pruned = pruneToLimit(many);

    assert.equal(pruned.length, 40);
    assert.equal(pruned[0]?.title, 'c49', 'newest first');
    assert.ok(!pruned.some((c) => c.title === 'c0'), 'oldest dropped');
  });
});

describe('persistence', () => {
  it('round-trips through storage', () => {
    stubStorage();
    const one = conversation({ title: 'Swap ETH' });
    saveConversations([one]);

    const loaded = loadConversations();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.title, 'Swap ETH');
  });

  it('returns an empty list when storage holds junk instead of throwing', () => {
    const map = stubStorage();
    map.set('liberty.conversations.v1', 'not json at all');
    assert.deepEqual(loadConversations(), []);
  });

  it('drops records that do not match the expected shape', () => {
    const map = stubStorage();
    map.set('liberty.conversations.v1', JSON.stringify([{ id: 'x' }, conversation({ title: 'ok' })]));

    const loaded = loadConversations();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.title, 'ok');
  });

  it('does not throw when storage refuses the write', () => {
    // A full or disabled store must not take the session down with it.
    stubStorage({ failWrites: true });
    assert.doesNotThrow(() => saveConversations([conversation()]));
  });

  it('survives storage being entirely unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    assert.deepEqual(loadConversations(), []);
    assert.doesNotThrow(() => saveConversations([conversation()]));
  });
});
