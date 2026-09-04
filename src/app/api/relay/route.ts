import { NextResponse } from 'next/server';
import { z } from 'zod';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';

/**
 * Relays a client-signed Hyperliquid action to the exchange.
 *
 * The browser cannot POST there directly — the CSP deliberately allows no
 * third-party origins — so this forwards it. The server never signs anything
 * and never sees a private key: it receives a finished signature and passes it
 * on unchanged.
 */
const RequestSchema = z.object({
  // The action is opaque here on purpose. Its bytes were already hashed and
  // signed by the client; re-shaping it server-side would invalidate the
  // signature, so it is forwarded exactly as received.
  action: z.record(z.string(), z.unknown()),
  nonce: z.number().int().positive(),
  signature: z.object({
    r: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    s: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    v: z.number().int(),
  }),
  vaultAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).nullable().optional(),
});

export async function POST(request: Request) {
  const limit = checkRateLimit(clientKey(request));
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, error: 'Too many requests. Give it a moment.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'Malformed signed action.' }, { status: 400 });
  }

  try {
    const response = await fetch(EXCHANGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: parsed.data.action,
        nonce: parsed.data.nonce,
        signature: parsed.data.signature,
        vaultAddress: parsed.data.vaultAddress ?? null,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const body = (await response.json().catch(() => null)) as HyperliquidResponse | null;
    const failure = describeFailure(body, response.status);

    return failure
      ? NextResponse.json({ ok: false, error: failure }, { status: 200 })
      : NextResponse.json({ ok: true, result: body }, { status: 200 });
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Could not reach the Hyperliquid exchange.' },
      { status: 502 },
    );
  }
}

interface HyperliquidResponse {
  status?: string;
  response?: { data?: { statuses?: ({ error?: string } | unknown)[] } } | string;
}

/**
 * Hyperliquid answers 200 even for rejections, and a batch can fail per-order
 * while the envelope reports success. Both shapes have to be inspected or a
 * rejected order looks like a filled one.
 */
function describeFailure(body: HyperliquidResponse | null, httpStatus: number): string | null {
  if (!body) return `The exchange returned an unreadable response (HTTP ${httpStatus}).`;

  if (body.status === 'err') {
    return typeof body.response === 'string' ? body.response : 'The exchange rejected the action.';
  }

  const statuses =
    typeof body.response === 'object' && body.response !== null
      ? (body.response.data?.statuses ?? [])
      : [];

  for (const status of statuses) {
    if (status && typeof status === 'object' && 'error' in status) {
      return String((status as { error: unknown }).error);
    }
  }
  return null;
}

function clientKey(request: Request): string {
  if (process.env.TRUST_PROXY_HEADERS !== 'true') return 'shared';
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'shared';
}
