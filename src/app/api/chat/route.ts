import { NextResponse } from 'next/server';
import { z } from 'zod';
import { checkRateLimit } from '@/lib/rate-limit';
import { runAgent } from '@/lib/agent/runner';

export const runtime = 'nodejs';
// Quotes and balances are per-wallet and time-sensitive; nothing here is cacheable.
export const dynamic = 'force-dynamic';

const MAX_MESSAGE_CHARS = 2_000;
const MAX_HISTORY = 30;

const RequestSchema = z.object({
  messages: z
    .array(
      z.object({
        // Never 'system': a client-supplied system message would be appended
        // after the real system prompt and compete with it for authority.
        role: z.enum(['user', 'assistant']),
        content: z.string().max(MAX_MESSAGE_CHARS),
      }),
    )
    .min(1)
    .max(MAX_HISTORY),
  wallet: z.object({
    // Validated as an address here so a malformed value never reaches an RPC.
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).nullable(),
    // Any chain id is accepted here; handlers reject unsupported ones with a
    // message the user can act on, rather than a generic 400.
    chainId: z.number().int().positive().nullable(),
    agentAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).nullable().optional(),
  }),
});

export async function POST(request: Request) {
  const limit = checkRateLimit(clientKey(request));
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many requests. Give it a moment.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body was not valid JSON.' }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: 'That request was malformed.' }, { status: 400 });
  }

  try {
    const result = await runAgent(parsed.data);
    return NextResponse.json(result);
  } catch (cause) {
    // Log the detail server-side; return something the user can act on.
    console.error('[liberty] agent failure', cause);
    // Misconfiguration is the operator's problem to fix, and a generic
    // "try again shortly" hides it — those messages are passed through.
    const isConfigError =
      cause instanceof Error &&
      /GROQ_API_KEY|GROQ_MODEL|no longer served|rejected the API key|token limit|rate limit|failed validation/.test(
        cause.message,
      );
    const message = isConfigError
      ? (cause as Error).message
      : 'Plumb could not complete that request. Try rephrasing, or try again shortly.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/** Behind a proxy the socket address is the proxy's, so prefer the forwarded header. */
/**
 * Rate-limit key.
 *
 * `X-Forwarded-For` is only honoured when the operator has declared that this
 * app runs behind a proxy that overwrites it. Otherwise any caller could mint
 * a fresh bucket per request by varying the header, which would leave the
 * operator's Groq and Uniswap quotas completely unguarded.
 */
function clientKey(request: Request): string {
  if (process.env.TRUST_PROXY_HEADERS !== 'true') return 'shared';

  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'shared';
}
