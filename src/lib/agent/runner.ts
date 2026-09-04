import Groq from 'groq-sdk';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'groq-sdk/resources/chat/completions';
import type { Address } from 'viem';
import type { Attachment, ChatRequest, ChatResponse } from '@/types/chat';
import { ProviderError } from '@/lib/providers/http';
import { sanitiseLabel } from '@/lib/sanitise';
import { buildSwapProposal, type SwapArgs } from './handlers/swap';
import { buildBridgeProposal, type BridgeArgs } from './handlers/bridge';
import { buildTransferProposal, type TransferArgs } from './handlers/transfer';
import { findYields, type YieldArgs } from './handlers/yield';
import { buildPortfolio } from './handlers/portfolio';
import { detectFundingIntent } from './handlers/funding';
import { readPrices, type PriceArgs } from './handlers/prices';
import { buildOpenPositionProposal, type OpenPositionArgs } from './handlers/position';
import { describeMarket, readPositions, summarisePositions } from './handlers/perps';
import { readPredictionMarkets, summariseMarkets, type PredictionArgs } from './handlers/predictions';
import { hasApprovedAgent, hasApprovedBuilder } from '@/lib/providers/hyperliquid-info';
import {
  buildDepositProposal, buildWithdrawProposal, listVaults,
  type DepositArgs, type FindVaultsArgs, type WithdrawArgs,
} from './handlers/vault';
import { buildSystemPrompt } from './system-prompt';
import { TOOL_DEFINITIONS } from './tools';

/**
 * Groq retires hosted models on a rolling basis, and a decommissioned id fails
 * at request time rather than at boot. Override with GROQ_MODEL; see
 * https://console.groq.com/docs/models for what is currently served.
 */
const MODEL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';

/**
 * Two rounds is enough for the flows we support: read balances, then build.
 * A hard ceiling also means a model that loops on a failing tool cannot burn
 * the user's rate limit.
 */
const MAX_TOOL_ROUNDS = 3;

/**
 * Ceiling on a whole exchange. Per-call timeouts bound each hop, but four
 * rounds of model call plus tool calls can still stack up past any reasonable
 * wait — and a user watching a spinner cannot cancel a server-side loop.
 */
const TOTAL_BUDGET_MS = 90_000;

/**
 * Replies are meant to be two to four sentences. Reserved output counts
 * against the per-minute token budget whether or not it is used, so a generous
 * ceiling here is paid for on every single round.
 */
const MAX_REPLY_TOKENS = 400;

/**
 * How much conversation is resent each round. The whole history goes up on
 * every call, so an unbounded transcript makes later turns progressively more
 * expensive until they cannot fit the budget at all.
 */
const MAX_HISTORY_MESSAGES = 10;

type Message = Groq.Chat.Completions.ChatCompletionMessageParam;

let client: Groq | null = null;

function groq(): Groq {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set. Add it to .env.local and restart.');
  client ??= new Groq({ apiKey, timeout: 45_000, maxRetries: 1 });
  return client;
}

/**
 * Turns Groq's generic failures into something the operator can act on. A
 * retired model id is the single most likely cause of a working deployment
 * breaking with no code change, and its raw error does not say so.
 */
export function explainModelFailure(cause: unknown): never {
  const message = cause instanceof Error ? cause.message : String(cause);

  if (/does not exist|model_not_found|decommissioned|has been deprecated/i.test(message)) {
    throw new Error(
      `The configured Groq model "${MODEL}" is no longer served. Set GROQ_MODEL in .env.local to a current model id from https://console.groq.com/docs/models and restart.`,
    );
  }
  if (/invalid_api_key|Invalid API Key|401/i.test(message)) {
    throw new Error('Groq rejected the API key. Check GROQ_API_KEY in .env.local.');
  }
  if (isRateLimit(message)) throw new Error(describeRateLimit(message));
  if (/tool call validation failed|tool_use_failed/i.test(message)) {
    throw new Error(
      'The model produced a tool call that failed validation. Rephrasing usually fixes it; if it repeats, the tool schema needs widening.',
    );
  }
  throw cause instanceof Error ? cause : new Error(message);
}

/** Single call site for the model, so every failure gets the same diagnosis. */
/**
 * Rate limits are the normal condition on a free key, not an exceptional one,
 * and Groq states exactly how long to wait. Sitting out that wait once turns
 * most of them into a slightly slower reply instead of a failed request.
 *
 * Only one retry: a second limit inside the same request means the budget is
 * genuinely exhausted, and stacking waits would blow the overall deadline.
 */
async function complete(
  body: ChatCompletionCreateParamsNonStreaming,
  deadline: number,
): Promise<ChatCompletion> {
  try {
    return await groq().chat.completions.create(body);
  } catch (cause) {
    const wait = retryDelayMs(cause);
    const canWait = wait !== null && Date.now() + wait < deadline;
    if (!canWait) explainModelFailure(cause);

    await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await groq().chat.completions.create(body);
    } catch (secondCause) {
      explainModelFailure(secondCause);
    }
  }
}

/**
 * Groq enforces separate per-minute and per-day token budgets, and the error
 * body says which one was hit. The distinction matters: a per-minute limit
 * clears in seconds and is worth waiting out, while a per-day limit means the
 * key is finished until it resets and retrying only burns time.
 */
interface RateLimit {
  readonly period: 'minute' | 'day' | 'unknown';
  readonly waitSeconds: number | null;
}

function isRateLimit(message: string): boolean {
  return /rate_limit_exceeded|rate limit reached|\b429\b/i.test(message);
}

function parseRateLimit(message: string): RateLimit {
  const period = /per day \(TPD\)/i.test(message)
    ? 'day'
    : /per minute \(TPM\)/i.test(message)
      ? 'minute'
      : 'unknown';

  // Stated as "6m44.352s" or "7.38s".
  const match = /try again in (?:(\d+)m)?([0-9.]+)s/i.exec(message);
  const waitSeconds = match
    ? Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)
    : null;

  return { period, waitSeconds };
}

function describeRateLimit(message: string): string {
  const { period, waitSeconds } = parseRateLimit(message);
  const wait = formatWait(waitSeconds);

  if (period === 'day') {
    /*
     * The daily budget is a rolling window, not a midnight reset: the stated
     * wait buys back roughly one request's worth of headroom, not a fresh
     * day's allowance. Saying "resets in 5 min" would set the wrong
     * expectation for someone about to keep retrying.
     */
    return `Groq's daily token allowance for this key is used up.${wait ? ` It refills gradually — about ${wait} for enough headroom to run one more request.` : ''} For sustained use, raise the limit at console.groq.com/settings/billing or use a different key.`;
  }
  if (period === 'minute') {
    return `Groq's per-minute token limit was reached${wait ? ` — try again in about ${wait}` : ', try again shortly'}.`;
  }
  return `Groq's rate limit was reached${wait ? ` — try again in about ${wait}` : ', try again shortly'}.`;
}

function formatWait(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  if (seconds < 90) return `${Math.ceil(seconds)}s`;
  return `${Math.ceil(seconds / 60)} min`;
}

/**
 * How long to sit out before one retry, or null to fail immediately.
 *
 * Only a short per-minute wait is worth absorbing. A daily limit is measured
 * in minutes or hours, so retrying just makes the user wait for the same
 * failure.
 */
const MAX_ABSORBABLE_WAIT_MS = 15_000;

export function retryDelayMs(cause: unknown): number | null {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (!isRateLimit(message)) return null;

  const { period, waitSeconds } = parseRateLimit(message);
  if (period === 'day') return null;
  if (waitSeconds === null) return 3_000;

  const wait = waitSeconds * 1000 + 400;
  return wait <= MAX_ABSORBABLE_WAIT_MS ? wait : null;
}

export async function runAgent(request: ChatRequest): Promise<ChatResponse> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const attachments: Attachment[] = [];
  const wallet = request.wallet.address as Address | null;

  /*
   * Buying with fiat is answered here, before the model is called at all.
   *
   * It was briefly a tool, and on a free Groq key that was the wrong shape:
   * a ninth schema is resent on every round of every request, so a feature
   * most people use once made every other message more expensive. Nothing
   * about a fiat purchase needs a model — there is no price to fetch and no
   * route to choose — so it is matched deterministically and returned
   * directly. Zero tokens, and faster than the tool was.
   *
   * The matcher only fires on an unmistakable fiat purchase; anything else
   * falls through to the model exactly as before.
   */
  const funding = await detectFundingIntent(latestUserMessage(request));
  if (funding) {
    return {
      content: funding.reply,
      attachments: [{ type: 'funding', plan: funding.plan }],
    };
  }

  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt(request.wallet) },
    ...request.messages
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content }) as Message),
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    if (Date.now() > deadline) break;

    const completion = await complete({
      model: MODEL,
      messages,
      tools: [...TOOL_DEFINITIONS],
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: MAX_REPLY_TOKENS,
    }, deadline);

    const choice = completion.choices[0]?.message;
    if (!choice) throw new Error('The model returned an empty response.');

    const toolCalls = choice.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return { content: choice.content ?? '', attachments };
    }

    messages.push(choice as Message);

    for (const call of toolCalls) {
      const result = await invokeTool(
        call.function.name, call.function.arguments, wallet, request.wallet.agentAddress ?? null,
      );
      if (result.attachment) attachments.push(result.attachment);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result.content,
      });
    }
  }

  // Out of rounds or out of time: ask for a final answer with tools switched
  // off so the user always gets prose rather than a silent failure. Any
  // proposals already built are still returned alongside it.
  const final = await complete({
    model: MODEL,
    messages,
    temperature: 0.2,
    max_tokens: MAX_REPLY_TOKENS,
  }, deadline);

  return { content: final.choices[0]?.message?.content ?? '', attachments };
}

interface ToolResult {
  readonly content: string;
  readonly attachment?: Attachment;
}

async function invokeTool(
  name: string,
  rawArgs: string,
  wallet: Address | null,
  agentAddress: string | null,
): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs || '{}') as Record<string, unknown>;
  } catch {
    return { content: 'Error: arguments were not valid JSON. Re-issue the call with valid JSON.' };
  }

  // Models emit an explicit null for arguments they mean to omit. Stripping
  // them here lets every handler use plain `undefined` checks.
  for (const [key, value] of Object.entries(args)) {
    if (value === null) delete args[key];
  }

  try {
    switch (name) {
      case 'build_swap': {
        const address = requireWallet(wallet);
        const proposal = await buildSwapProposal(args as unknown as SwapArgs, address);
        return {
          content: `[card displayed: swap via ${proposal.route}, awaiting signature] Now write your own short reply about the route and its risk. Do not repeat the card's numbers and do not say it executed.`,
          attachment: { type: 'proposal', proposal },
        };
      }
      case 'build_transfer': {
        const address = requireWallet(wallet);
        const proposal = await buildTransferProposal(args as unknown as TransferArgs, address);
        return {
          content: `[card displayed: transfer, awaiting signature] Now write your own short reply. Tell them to check the destination address before signing. Do not repeat the amount or the address, and do not say it has been sent.`,
          attachment: { type: 'proposal', proposal },
        };
      }
      case 'build_bridge': {
        const address = requireWallet(wallet);
        const proposal = await buildBridgeProposal(args as unknown as BridgeArgs, address);
        return {
          content: `[card displayed: bridge via ${proposal.route}, ~${proposal.estimatedSeconds ?? '?'}s, awaiting signature] Now write your own short reply about the route and its risk. Do not repeat the card's numbers and do not say it completed.`,
          attachment: { type: 'proposal', proposal },
        };
      }
      case 'get_prices': {
        const { prices, unknown, title, source } = await readPrices(args as unknown as PriceArgs);
        const missing = unknown.length > 0 ? ` No feed for: ${unknown.join(', ')}.` : '';
        return {
          content: `[card displayed: prices]${missing} Now write your own one-line reply about what moved. Do not repeat the numbers. For your reasoning only: ${prices.map((p) => `${p.symbol} $${p.usd}`).join(', ')}.`,
          attachment: { type: 'prices', title, prices, source },
        };
      }
      case 'earn': {
        const earnArgs = args as {
          action?: string; chain?: string; asset?: string; amount?: string;
          amountUsd?: number; stablecoinsOnly?: boolean; riskTolerance?: string; vaultAddress?: string;
        };

        if (earnArgs.action === 'pools') {
          const { pools, title } = await findYields(earnArgs as unknown as YieldArgs);
          if (pools.length === 0) {
            return { content: 'No pools matched. Suggest relaxing the asset or risk constraints.' };
          }
          return {
            content: `[table displayed: ${pools.length} pools] Now write your own short prose reply about which is worth a look and why. Do not list them, do not repeat their numbers, do not write a markdown table. Data for your reasoning only:\n${summarise(pools)}`,
            attachment: { type: 'yields', title, pools },
          };
        }

        if (earnArgs.action === 'vaults') {
          const { vaults, title } = await listVaults(earnArgs as FindVaultsArgs);
          if (vaults.length === 0) {
            return { content: 'No Morpho vaults matched. Suggest a different asset or chain.' };
          }
          return {
            content: `[table displayed: ${vaults.length} vaults] Now write your own short prose reply about which is worth a look and why. Do not list them, do not repeat their numbers, do not write a markdown table. Data for your reasoning only:\n${summariseVaults(vaults)}`,
            attachment: { type: 'vaults', title, vaults },
          };
        }

        const address = requireWallet(wallet);

        if (earnArgs.action === 'withdraw') {
          const proposal = await buildWithdrawProposal(earnArgs as unknown as WithdrawArgs, address);
          return {
            content: `[card displayed: withdrawal from ${proposal.route}, awaiting signature] Now write your own short reply. Do not repeat the card's numbers and do not say it completed.`,
            attachment: { type: 'proposal', proposal },
          };
        }

        const proposal = await buildDepositProposal(earnArgs as unknown as DepositArgs, address);
        return {
          content: `[card displayed: deposit into ${proposal.route} at ${proposal.vault?.apy.toFixed(2)}% net APY, awaiting signature] Now write your own short reply about the curator and what earns the yield. Do not repeat the card's numbers and do not say it executed.`,
          attachment: { type: 'proposal', proposal },
        };
      }
      case 'perps': {
        const perpArgs = args as { action?: string; coin?: string; side?: string; notionalUsd?: number; leverage?: number };

        if (perpArgs.action === 'positions') {
          /*
           * A market question needs no wallet, and refusing one pushed the
           * model into answering from memory — it claimed BTC caps at 10x when
           * Hyperliquid allows 40x. Market facts are always grounded now.
           */
          const market = perpArgs.coin ? await describeMarket(perpArgs.coin) : null;
          const marketNote = market
            ? `${market.asset.name} mid $${market.mid}, max leverage ${market.asset.maxLeverage}x. `
            : '';

          if (!wallet) {
            return {
              content: marketNote
                ? `${marketNote}No wallet connected, so no account to report.`
                : 'No wallet connected. Ask the user to connect one to see their Hyperliquid account.',
            };
          }

          const { state, title } = await readPositions(
            { ...(perpArgs.coin ? { coin: perpArgs.coin } : {}) },
            wallet,
          );
          return { content: `${marketNote}[${title}] ${summarisePositions(state)}` };
        }

        const address = requireWallet(wallet);

        if (!perpArgs.coin || !perpArgs.side || !perpArgs.notionalUsd) {
          return { content: 'Error: opening a position needs coin, side (long/short) and notionalUsd.' };
        }

        const [agentApproved, builderApproved] = await Promise.all([
          hasApprovedAgent(address, agentAddress),
          hasApprovedBuilder(address),
        ]);

        const proposal = await buildOpenPositionProposal(
          perpArgs as unknown as OpenPositionArgs,
          { wallet: address, agentAddress, agentApproved, builderApproved },
        );
        return {
          content: `[card displayed: ${proposal.route}, awaiting signature] Now write your own short reply about the liquidation risk at this leverage. Do not repeat the card's numbers and do not say it filled.`,
          attachment: { type: 'proposal', proposal },
        };
      }
      case 'predictions': {
        const { markets, title } = await readPredictionMarkets(args as unknown as PredictionArgs);
        return {
          content: `[table displayed: ${markets.length} markets] Plumb is READ-ONLY on Polymarket — it cannot place bets. If the user asked to bet, say plainly that you cannot place it and that the card links to the market. Otherwise write a short prose reply on what the odds imply. Either way do not list the markets or repeat their numbers. Data for your reasoning only:\n${summariseMarkets(markets)}`,
          attachment: { type: 'markets', title, markets },
        };
      }
      case 'portfolio': {
        const address = requireWallet(wallet);
        const { snapshot, summary } = await buildPortfolio(address);
        return {
          attachment: { type: 'portfolio', snapshot },
          content: `[portfolio panel displayed] The user can see every figure already, so do not list holdings back or repeat totals. Answer what they asked, or offer one concrete next step. Data for your reasoning only:\n${summary}`,
        };
      }
      default:
        return { content: `Error: unknown tool "${name}".` };
    }
  } catch (cause) {
    return { content: `Error: ${describe(cause)}` };
  }
}

/** The message this turn is answering; history is not re-scanned. */
function latestUserMessage(request: ChatRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role === 'user') return message.content;
  }
  return '';
}

function requireWallet(wallet: Address | null): Address {
  if (!wallet) throw new Error('No wallet is connected. Ask the user to connect one first.');
  return wallet;
}

function summarise(pools: Awaited<ReturnType<typeof findYields>>['pools']): string {
  return pools
    .map((p) => {
      const risks = p.riskNotes.length > 0 ? ` Risks: ${p.riskNotes.join(' ')}` : '';
      return `- ${sanitiseLabel(p.symbol)} on ${sanitiseLabel(p.project)}/${sanitiseLabel(p.chain)}: ${p.apy.toFixed(2)}% APY (30d mean ${p.apyMean30d.toFixed(2)}%), TVL $${Math.round(p.tvlUsd).toLocaleString('en-US')}, ${p.exposure} exposure, IL risk ${p.ilRisk}.${risks}`;
    })
    .join('\n');
}


function summariseVaults(vaults: Awaited<ReturnType<typeof listVaults>>['vaults']): string {
  return vaults
    .map(
      (v) =>
        `- ${v.name} (${v.asset.symbol} on chain ${v.chainId}, ${v.address}): ${v.netApy.toFixed(2)}% net APY, $${Math.round(v.totalAssetsUsd).toLocaleString('en-US')} deposited, curated by ${v.curator ?? 'an unnamed curator'}.`,
    )
    .join('\n');
}

function describe(cause: unknown): string {
  if (cause instanceof ProviderError) return cause.message;
  return cause instanceof Error ? cause.message : 'An unexpected error occurred.';
}
