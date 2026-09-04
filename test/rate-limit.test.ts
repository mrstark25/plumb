import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { checkRateLimit } from '@/lib/rate-limit';

describe('checkRateLimit', () => {
  it('allows a burst up to the window limit, then refuses', () => {
    const key = `client-${Math.random()}`;
    for (let i = 0; i < 15; i += 1) {
      assert.equal(checkRateLimit(key).ok, true, `request ${i + 1} should be allowed`);
    }
    const blocked = checkRateLimit(key);
    assert.equal(blocked.ok, false);
    assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 60);
  });

  it('tracks callers independently, so one abuser cannot lock everyone out', () => {
    const noisy = `noisy-${Math.random()}`;
    const quiet = `quiet-${Math.random()}`;
    for (let i = 0; i < 16; i += 1) checkRateLimit(noisy);

    assert.equal(checkRateLimit(noisy).ok, false);
    assert.equal(checkRateLimit(quiet).ok, true);
  });
});
