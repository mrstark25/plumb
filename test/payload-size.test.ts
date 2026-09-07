import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { TOOL_DEFINITIONS } from '@/lib/agent/tools';
import { buildSystemPrompt } from '@/lib/agent/system-prompt';

/** ~4 characters per token — close enough to size a rate-limit budget. */
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/*
 * Groq's free tier allows 8,000 tokens per minute, and the system prompt plus
 * every tool schema is resent on every round of every request. These ceilings
 * exist so that adding a tool or a paragraph of guidance fails here rather
 * than silently making the app unusable on a free key.
 */
/*
 * Lowered when Hyperliquid perps and Polymarket predictions were dropped from
 * the payload. Both cost ~208 tokens on every round of every request and
 * served none of the tracks this is built for, and the free Groq tier is
 * 200,000 tokens a DAY — roughly fifty exchanges. The ceilings are set just
 * above today's real size so any re-addition has to be a deliberate choice.
 */
const SYSTEM_PROMPT_CEILING = 540;
const TOOL_SCHEMA_CEILING = 800;
const TOKENS_PER_MINUTE = 8_000;
const MAX_TOOL_ROUNDS = 3;
const MAX_REPLY_TOKENS = 320;

function fixedOverhead(): number {
  const prompt = buildSystemPrompt({
    address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    chainId: 8453,
  });
  return estimateTokens(prompt) + estimateTokens(JSON.stringify(TOOL_DEFINITIONS));
}

describe('request payload budget', () => {
  it('keeps the system prompt within its ceiling', () => {
    const size = estimateTokens(
      buildSystemPrompt({ address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', chainId: 8453 }),
    );
    assert.ok(
      size <= SYSTEM_PROMPT_CEILING,
      `system prompt is ${size} tokens, ceiling is ${SYSTEM_PROMPT_CEILING}`,
    );
  });

  it('keeps the tool schemas within their ceiling', () => {
    const size = estimateTokens(JSON.stringify(TOOL_DEFINITIONS));
    assert.ok(
      size <= TOOL_SCHEMA_CEILING,
      `tool schemas are ${size} tokens, ceiling is ${TOOL_SCHEMA_CEILING}`,
    );
  });

  it('fits a worst-case request inside one minute of free-tier budget', () => {
    // Every round resends the whole fixed payload and reserves its output.
    const worstCase = (fixedOverhead() + MAX_REPLY_TOKENS) * MAX_TOOL_ROUNDS;
    assert.ok(
      worstCase <= TOKENS_PER_MINUTE,
      `worst-case request is ~${worstCase} tokens, over the ${TOKENS_PER_MINUTE}/min limit`,
    );
  });

  it('leaves room for more than one exchange per minute in the typical case', () => {
    /*
     * The common shape is one tool call plus a reply: two rounds.
     *
     * This is the ceiling that decides whether a free key feels usable, and
     * it is why fiat buying is matched before the model rather than added as
     * a ninth tool: a schema is resent on every round of every request, so it
     * would have cost this margin on every message to serve a request most
     * people make once.
     */
    const typical = (fixedOverhead() + MAX_REPLY_TOKENS) * 2;
    assert.ok(
      typical * 2 <= TOKENS_PER_MINUTE,
      `two typical exchanges cost ~${typical * 2} tokens, over the ${TOKENS_PER_MINUTE}/min limit`,
    );
  });

  it('still describes every tool the runner can dispatch', () => {
    // Trimming for size must not drop a tool or leave one undocumented.
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    assert.deepEqual(names.sort(), [
      'build_bridge', 'build_swap', 'build_transfer', 'earn',
      'get_prices', 'portfolio',
    ]);
    for (const tool of TOOL_DEFINITIONS) {
      assert.ok(tool.function.description.length > 30, `${tool.function.name} needs a real description`);
    }
  });

  it('keeps every optional parameter nullable', () => {
    // A plain "string" on an optional field makes the API reject the whole
    // call when the model emits an explicit null.
    for (const tool of TOOL_DEFINITIONS) {
      const { properties, required } = tool.function.parameters;
      for (const [name, schema] of Object.entries(properties as Record<string, { type: unknown }>)) {
        if ((required as readonly string[]).includes(name)) continue;
        assert.ok(
          Array.isArray(schema.type) && schema.type.includes('null'),
          `${tool.function.name}.${name} is optional but not nullable`,
        );
      }
    }
  });
});
