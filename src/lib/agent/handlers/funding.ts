import { chainName, resolveChain, type SupportedChainId } from '@/lib/chains';
import { findToken } from '@/lib/tokens';
import { toFiatCurrency, type FiatCurrency } from '@/lib/wallet-session';
import { getFiatPrice } from '@/lib/providers/coingecko';

export interface FundArgs {
  chain?: string | null;
  asset?: string | null;
  currency?: string | null;
  amount?: string | null;
}

export interface FundingPlan {
  readonly chainId: SupportedChainId;
  readonly asset: string;
  readonly currency: FiatCurrency | null;
  /** The code the user actually said, when it is not one the onramp takes. */
  readonly unsupportedCurrency: string | null;
  readonly amount: string | null;
  /**
   * Live market price of one unit of the asset in the chosen currency.
   *
   * Null when unknown — no rate is better than a remembered one. Ten of the
   * currencies the on-ramp accepts cannot be priced, and those show nothing
   * rather than a figure converted through dollars.
   */
  readonly rate: number | null;
  /** What `amount` of the currency buys at that rate, before the provider's fee. */
  readonly estimate: number | null;
}

/** Where a buy lands when the user does not say. Deep USDC liquidity, cheap gas. */
const DEFAULT_CHAIN: SupportedChainId = 8453;
const DEFAULT_ASSET = 'USDC';

/**
 * Turns "buy USDC with INR" into something the funding card can open.
 *
 * This runs on the server and deliberately produces a *plan*, never a purchase.
 * The onramp is opened by the user clicking the card, in their own browser,
 * through Privy — the same division as everywhere else here, where the server
 * prepares and the browser acts. It matters more than usual on this path: a
 * payment sheet that opened itself because a model emitted a tool call would
 * be a real problem, and text arriving from a webpage or token name is exactly
 * how that would be triggered.
 */
export function planFunding(args: FundArgs): FundingPlan {
  const chainId = args.chain ? resolveChain(args.chain) : DEFAULT_CHAIN;
  const requested = (args.asset ?? DEFAULT_ASSET).trim();

  // Resolved through the same vetted registry as every other path. An asset we
  // have no verified address for is refused rather than approximated.
  const token = findToken(chainId, requested);
  if (!token) {
    throw new Error(
      `I don't have a verified ${requested.toUpperCase()} address on ${chainName(chainId)}, so I won't set up a purchase of it. Try USDC, or name a chain where it exists.`,
    );
  }

  const currency = toFiatCurrency(args.currency);

  return {
    chainId,
    asset: token.symbol,
    currency,
    // Said out loud rather than quietly falling back to dollars: someone who
    // asked to pay in a currency the onramp cannot take needs to know that,
    // not discover it inside a payment sheet.
    unsupportedCurrency: args.currency && !currency ? args.currency.trim().slice(0, 12) : null,
    amount: normaliseAmount(args.amount),
    rate: null,
    estimate: null,
  };
}

/**
 * Adds the live market rate to a plan.
 *
 * Separate from `planFunding` so the plan itself stays synchronous and
 * testable, and so a slow or rate-limited price source delays nothing: a plan
 * without a rate is still a usable card.
 */
export async function withLiveRate(plan: FundingPlan): Promise<FundingPlan> {
  if (!plan.currency) return plan;

  const rate = await getFiatPrice(plan.asset, plan.currency).catch(() => undefined);
  if (rate === undefined) return plan;

  const paid = plan.amount === null ? null : Number(plan.amount);
  return {
    ...plan,
    rate,
    estimate: paid !== null && Number.isFinite(paid) && paid > 0 ? paid / rate : null,
  };
}

/** A prefill only; the onramp validates it properly. Nonsense is dropped. */
function normaliseAmount(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[^0-9.]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? cleaned : null;
}

/** What the model is told, so it can write a sentence without inventing one. */
export function describeFunding(plan: FundingPlan): string {
  const parts = [
    `Funding card shown: buy ${plan.asset} on ${chainName(plan.chainId)}${
      plan.currency ? ` paying in ${plan.currency.toUpperCase()}` : ''
    }.`,
  ];
  if (plan.unsupportedCurrency) {
    parts.push(
      `${plan.unsupportedCurrency.toUpperCase()} is not one of the currencies the onramp accepts, so the card will open on its default instead. Say so plainly.`,
    );
  }
  parts.push(
    'The user completes the purchase with the provider, not with you. Availability and limits depend on their country and provider, so do not promise it will work. Do not restate the card.',
  );
  return parts.join(' ');
}

/*
 * ---------------------------------------------------------------------------
 * Zero-token intent detection
 * ---------------------------------------------------------------------------
 *
 * Buying with fiat used to be a ninth tool. On a free Groq key that was the
 * wrong trade: every tool schema is resent on every round of every request, so
 * one more pushed two back-to-back exchanges past the 8,000-token minute and
 * made the user wait between questions — a permanent cost on every message, to
 * serve a request most of them will make once.
 *
 * A fiat purchase does not need a language model. There is nothing to price,
 * nothing to route and nothing to reason about: the destination is a token in
 * the registry and the payment happens inside the provider's own sheet. So it
 * is matched here instead, before the model runs, and the request never
 * reaches Groq at all. Zero tokens, and a faster answer than the tool gave.
 *
 * The matcher is deliberately narrow. The failure that matters is mistaking a
 * SWAP for a purchase — "buy ETH with USDC" is a trade — so a buy verb alone
 * never triggers this. It needs a buy verb AND real fiat, and USDC is not
 * fiat. Anything it does not confidently recognise falls through to the model,
 * which is the safe direction to fail in.
 */

/** Currency words a person actually types, mapped to the code the onramp takes. */
const CURRENCY_WORDS: Readonly<Record<string, string>> = {
  rupee: 'inr', rupees: 'inr', '₹': 'inr',
  euro: 'eur', euros: 'eur', '€': 'eur',
  pound: 'gbp', pounds: 'gbp', sterling: 'gbp', '£': 'gbp',
  yen: 'jpy', '¥': 'jpy',
  won: 'krw', rand: 'zar', peso: 'mxn', pesos: 'mxn',
  real: 'brl', reais: 'brl', naira: 'ngn', lira: 'try',
  dirham: 'aed', dirhams: 'aed', ringgit: 'myr', baht: 'thb',
  shilling: 'kes', shillings: 'kes', zloty: 'pln', hryvnia: 'uah',
};

/**
 * Fiat codes that may trigger on their own.
 *
 * `usd` and `$` are excluded on purpose. This app prices everything in dollars
 * — yields, portfolio, quotes — so "buy $500 of USDC" reads at least as much
 * like a swap sized in dollars as a card purchase. Guessing wrong would send
 * someone to a payment sheet when they wanted a trade, so USD only counts when
 * a payment method is named outright.
 */
const AMBIGUOUS_CODES = new Set(['usd']);

/** Phrases that mean fiat on their own, whatever currency is involved. */
const PAYMENT_PHRASES = [
  'with card', 'with a card', 'with my card', 'credit card', 'debit card',
  'bank transfer', 'with fiat', 'add funds', 'top up', 'top-up',
  'onramp', 'on-ramp', 'on ramp', 'apple pay', 'google pay',
];

const BUY_VERBS = /\b(buy|buying|purchase|purchasing|acquire)\b/;

/** The registry symbols worth recognising as a purchase target. */
const ASSET_PATTERN = /\b(usdc|usdt|dai|weth|eth|wbtc|cbbtc|usds|pol|arb)\b/;

const CHAIN_PATTERN = /\b(ethereum|mainnet|base|arbitrum|polygon)\b/;

export interface FundingIntent {
  readonly plan: FundingPlan;
  /** Deterministic reply text, since no model runs on this path. */
  readonly reply: string;
}

/**
 * Recognises a fiat purchase, or returns null and lets the model handle it.
 *
 * Returning null is always safe: the request proceeds exactly as it did
 * before. Returning a plan wrongly is not, so the bar is set high.
 */
export async function detectFundingIntent(message: string): Promise<FundingIntent | null> {
  const text = message.toLowerCase();

  const named = namedCurrency(text);
  const hasPhrase = PAYMENT_PHRASES.some((phrase) => text.includes(phrase));
  const hasVerb = BUY_VERBS.test(text);

  // Either an unambiguous foreign currency alongside a buy verb, or someone
  // naming a payment method outright.
  const currency = named && hasVerb ? named : hasPhrase ? (named ?? null) : null;
  if (!hasPhrase && !(named && hasVerb)) return null;

  // "buy ETH with USDC" names two crypto assets and no fiat: that is a swap,
  // and the swap handler quotes it properly. Never intercept it.
  if (!currency && !hasPhrase) return null;

  const asset = text.match(ASSET_PATTERN)?.[1]?.toUpperCase() ?? DEFAULT_ASSET;
  const chain = text.match(CHAIN_PATTERN)?.[1];

  const plan = await withLiveRate(
    planFunding({
      chain: chain === 'mainnet' ? 'ethereum' : (chain ?? null),
      asset,
      currency,
      amount: amountFrom(text),
    }),
  );

  return { plan, reply: replyFor(plan) };
}

function namedCurrency(text: string): string | null {
  for (const [word, code] of Object.entries(CURRENCY_WORDS)) {
    // Symbols have no word boundary, so they are matched as plain substrings.
    const found = /^[a-z]+$/.test(word)
      ? new RegExp(`\\b${word}\\b`).test(text)
      : text.includes(word);
    if (found) return code;
  }

  // A bare three-letter code, as long as it is not one of the ambiguous ones.
  const code = text.match(/\b([a-z]{3})\b/g)?.find(
    (candidate) =>
      !AMBIGUOUS_CODES.has(candidate) && toFiatCurrency(candidate) !== null,
  );
  return code ?? null;
}

/** The first plain number in the message, if there is one. */
function amountFrom(text: string): string | null {
  const match = text.match(/\b(\d[\d,]*(?:\.\d+)?)\b/);
  return match?.[1] ?? null;
}

function replyFor(plan: FundingPlan): string {
  const paying = plan.currency ? plan.currency.toUpperCase() : 'your local currency';
  const lines = [
    `You can buy ${plan.asset} on ${chainName(plan.chainId)} with ${paying} through the card below — it opens the payment provider, and the ${plan.asset} lands in your own wallet.`,
  ];
  if (plan.rate !== null) {
    // Stated as market, and immediately qualified. A rate shown without that
    // qualification reads as a promise of what the user will actually receive.
    lines.push(
      `The market rate right now is about ${formatRate(plan.rate)} ${plan.currency!.toUpperCase()} per ${plan.asset}; the provider adds its own fee and spread on top, so you will receive a little less.`,
    );
  }
  if (plan.unsupportedCurrency) {
    lines.push(
      `${plan.unsupportedCurrency.toUpperCase()} is not one of the currencies the on-ramp accepts, so it will open on its default instead.`,
    );
  }
  lines.push(
    'Which payment methods appear depends on your country, so I cannot promise it will be available to you.',
  );
  return lines.join(' ');
}

/** Two decimals is the right precision for every fiat this prices. */
export function formatRate(rate: number): string {
  return rate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
