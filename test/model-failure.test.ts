import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { explainModelFailure, retryDelayMs } from '@/lib/agent/runner';

describe('explainModelFailure', () => {
  it('names the retired model and where to find a current one', () => {
    // Groq retires hosted models on a rolling basis. Its raw error does not
    // say "change GROQ_MODEL", so a working deployment breaks with no code
    // change and a generic 502 — exactly the failure this message prevents.
    assert.throws(
      () => explainModelFailure(new Error('The model `llama-3.3-70b-versatile` does not exist')),
      /no longer served.*GROQ_MODEL.*console\.groq\.com/s,
    );
  });

  it('recognises the other phrasings the API uses for a dead model', () => {
    for (const message of [
      'model_not_found',
      'This model has been decommissioned',
      'model has been deprecated',
    ]) {
      assert.throws(() => explainModelFailure(new Error(message)), /GROQ_MODEL/);
    }
  });

  it('distinguishes a bad key from a bad model', () => {
    assert.throws(
      () => explainModelFailure(new Error('invalid_api_key')),
      /rejected the API key.*GROQ_API_KEY/s,
    );
  });

  it('rethrows anything it cannot diagnose, without inventing a cause', () => {
    const original = new Error('socket hang up');
    assert.throws(() => explainModelFailure(original), (thrown: unknown) => thrown === original);
  });

  it('wraps a non-Error rejection so callers always get an Error', () => {
    assert.throws(() => explainModelFailure('boom'), /boom/);
  });
});

describe('explainModelFailure — recoverable conditions', () => {
  // Shaped like the real bodies, 429 prefix and error code included.
  const TPM = '429 {"error":{"message":"Rate limit reached for model `x` on tokens per minute (TPM): Limit 8000, Used 5543, Requested 3441. Please try again in 7.38s.","code":"rate_limit_exceeded"}}';
  const TPD = '429 {"error":{"message":"Rate limit reached for model `x` on tokens per day (TPD): Limit 200000, Used 199633, Requested 1303. Please try again in 6m44.352s.","code":"rate_limit_exceeded"}}';

  it('names the per-minute limit and its short wait', () => {
    assert.throws(() => explainModelFailure(new Error(TPM)), /per-minute token limit.*about 8s/s);
  });

  it('distinguishes the daily limit, which no amount of waiting fixes quickly', () => {
    // Reporting a per-day exhaustion as a per-minute blip sends the user off
    // to retry in seconds when the real answer is hours or a plan change.
    assert.throws(() => explainModelFailure(new Error(TPD)), /daily token allowance/);
    assert.throws(() => explainModelFailure(new Error(TPD)), /about 7 min/);
    assert.throws(() => explainModelFailure(new Error(TPD)), /billing/);
  });

  it('does not blame the per-minute limit for a daily exhaustion', () => {
    assert.throws(
      () => explainModelFailure(new Error(TPD)),
      (thrown: unknown) => !/per-minute/.test((thrown as Error).message),
    );
  });

  it('handles a rate limit with no stated wait', () => {
    assert.throws(() => explainModelFailure(new Error('429 Too Many Requests')), /try again shortly/);
  });

  it('explains a tool-schema validation failure', () => {
    assert.throws(
      () => explainModelFailure(new Error('Tool call validation failed: expected string, but got null')),
      /failed validation/,
    );
  });
});

describe('retry policy', () => {
  const TPM_SHORT = '429 rate_limit_exceeded on tokens per minute (TPM). Please try again in 7.38s.';
  const TPM_LONG = '429 rate_limit_exceeded on tokens per minute (TPM). Please try again in 48s.';
  const TPD = '429 rate_limit_exceeded on tokens per day (TPD). Please try again in 6m44.352s.';

  it('absorbs a short per-minute wait', () => {
    const delay = retryDelayMs(new Error(TPM_SHORT));
    assert.ok(delay !== null && delay > 7_000 && delay < 9_000, `got ${delay}`);
  });

  it('refuses to sit out a long wait, leaving the user with a real answer', () => {
    assert.equal(retryDelayMs(new Error(TPM_LONG)), null);
  });

  it('never retries a daily exhaustion — the wait is minutes at best', () => {
    assert.equal(retryDelayMs(new Error(TPD)), null);
  });

  it('ignores errors that are not rate limits', () => {
    assert.equal(retryDelayMs(new Error('socket hang up')), null);
  });

  it('parses a minutes-and-seconds wait, not just seconds', () => {
    // "6m44.352s" parsed naively yields 6 seconds and badly understates it.
    assert.throws(() => explainModelFailure(new Error(TPD)), /about 7 min/);
  });

  it('describes the daily budget as refilling, not as resetting', () => {
    // It is a rolling window: the stated wait buys one request's headroom,
    // not a fresh day's allowance.
    assert.throws(() => explainModelFailure(new Error(TPD)), /refills gradually/);
    assert.throws(
      () => explainModelFailure(new Error(TPD)),
      (thrown: unknown) => !/resets in/.test((thrown as Error).message),
    );
  });
});
