interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 15;

/**
 * Fixed-window limiter keyed by client IP.
 *
 * IMPORTANT: this state lives in one process. On a single long-running server
 * it is a real limit. On serverless (Vercel) each invocation may be a fresh
 * instance, so it degrades to a speed bump rather than a guarantee — a
 * determined caller can drain the deployment's upstream quota regardless.
 *
 * Anything publicly exposed and backed by a metered key wants either a shared
 * store (Redis/Upstash) or an auth gate in front of it.
 */
export function checkRateLimit(key: string): { ok: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    if (buckets.size > 5_000) pruneExpired(now);
    return { ok: true, retryAfterSeconds: 0 };
  }

  if (bucket.count >= MAX_REQUESTS) {
    return { ok: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  bucket.count += 1;
  return { ok: true, retryAfterSeconds: 0 };
}

function pruneExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}
