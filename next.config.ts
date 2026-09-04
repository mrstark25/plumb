import type { NextConfig } from 'next';
import { PUBLIC_RPC_ORIGINS } from './src/lib/public-rpc';

/*
 * Privy needs its own origins to reach its API, render its modal in an iframe,
 * and run the wallet connectors. These are only added when Privy is actually
 * configured, so an injected-only deployment keeps the tighter policy.
 */
const PRIVY_CONNECT = [
  'https://auth.privy.io',
  'https://api.privy.io',
  'https://explorer-api.walletconnect.com',
  'wss://relay.walletconnect.com',
  'wss://www.walletlink.org',
];
const PRIVY_FRAME = ['https://auth.privy.io', 'https://challenges.cloudflare.com', 'https://verify.walletconnect.com'];
const PRIVY_SCRIPT = ['https://challenges.cloudflare.com'];

/*
 * Privy's funding flow hands off to a third-party on-ramp, which renders in an
 * iframe and calls its own API. Those origins are separate from Privy's, so
 * without them the funding modal opens onto a blank frame — a CSP failure is
 * silent to the user and shows only as a console violation.
 *
 * Scoped to funding rather than folded into PRIVY_FRAME/PRIVY_CONNECT so it
 * stays obvious what widened the policy and why.
 *
 * Stripe is absent deliberately: `@stripe/stripe-js` is aliased to a stub (see
 * `turbopack.resolveAlias` below), so that method is not offered.
 */
const ONRAMP_FRAME = ['https://buy.moonpay.com', 'https://pay.coinbase.com'];
const ONRAMP_CONNECT = ['https://api.moonpay.com', 'https://pay.coinbase.com'];

const usesPrivy = Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID);

/**
 * Security headers are set here rather than in a proxy so the posture travels
 * with the app. `connect-src` is deliberately narrow: the browser only ever
 * talks to our own /api routes and the public RPCs — quote/bridge/yield
 * providers are reached server-side so no third-party key can leak to a client.
 */
/*
 * React's development build uses eval() for debugging features, so dev needs
 * 'unsafe-eval'. Production must never have it — that is the whole point of
 * the policy — so it is added only when NODE_ENV is not production.
 */
const isDev = process.env.NODE_ENV !== 'production';

const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}${
    usesPrivy ? ` ${PRIVY_SCRIPT.join(' ')}` : ''
  }`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "worker-src 'self' blob:",
  // Derived from the same constant the browser client dials, so the two
  // cannot drift apart and silently block receipt polling.
  `connect-src 'self' ${PUBLIC_RPC_ORIGINS.join(' ')}${
    usesPrivy ? ` ${PRIVY_CONNECT.join(' ')} ${ONRAMP_CONNECT.join(' ')}` : ''
  }`,
  usesPrivy ? `frame-src ${PRIVY_FRAME.join(' ')} ${ONRAMP_FRAME.join(' ')}` : "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    resolveAlias: {
      // Privy references Stripe for a fiat on-ramp this app does not enable.
      '@stripe/stripe-js': './src/lib/empty-module.ts',
    },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
