const DEFAULT_TIMEOUT_MS = 15_000;

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

interface RequestOptions {
  readonly provider: string;
  readonly method?: 'GET' | 'POST';
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

/**
 * One JSON fetch for every upstream, so timeouts, non-2xx handling and error
 * shaping are identical everywhere. Upstream error bodies are summarised
 * rather than forwarded verbatim — they routinely echo request parameters and
 * we do not want provider internals reaching the browser.
 */
export async function requestJson<T>(url: string, options: RequestOptions): Promise<T> {
  const { provider, method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new ProviderError(provider, await describeFailure(response), response.status);
    }
    return (await response.json()) as T;
  } catch (cause) {
    if (cause instanceof ProviderError) throw cause;
    if (cause instanceof Error && cause.name === 'AbortError') {
      throw new ProviderError(provider, `${provider} did not respond within ${timeoutMs / 1000}s.`);
    }
    throw new ProviderError(provider, `Could not reach ${provider}.`);
  } finally {
    clearTimeout(timer);
  }
}

async function describeFailure(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  let detail = '';
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string; detail?: string };
    detail = parsed.message ?? parsed.error ?? parsed.detail ?? '';
  } catch {
    detail = text.slice(0, 160);
  }

  if (response.status === 429) return 'Rate limit reached upstream. Try again shortly.';
  if (response.status === 401 || response.status === 403) {
    return 'Upstream rejected the request (missing or invalid API credentials).';
  }
  return detail ? `Upstream error ${response.status}: ${detail}` : `Upstream error ${response.status}.`;
}

/** Small TTL cache for responses that are expensive and slow-moving. */
export function createTtlCache<T>(ttlMs: number) {
  let value: T | null = null;
  let expiresAt = 0;
  let inFlight: Promise<T> | null = null;

  return async function get(load: () => Promise<T>): Promise<T> {
    if (value !== null && Date.now() < expiresAt) return value;
    // Collapse concurrent misses onto one upstream call.
    inFlight ??= load()
      .then((loaded) => {
        value = loaded;
        expiresAt = Date.now() + ttlMs;
        return loaded;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}

/** LI.FI returns 0x-hex for value/gasLimit but decimal strings for amounts. */
export function hexToDecimalString(input: string | undefined): string {
  if (!input) return '0';
  return input.startsWith('0x') ? BigInt(input).toString(10) : input;
}
