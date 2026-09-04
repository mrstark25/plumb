/**
 * Tool schemas exposed to the model.
 *
 * Deliberately terse. Every token here is resent on every round of every
 * request and counts against a per-minute budget, so descriptions carry only
 * what changes the model's choice: when to call, and what each argument means.
 * Behavioural guidance lives in the system prompt, not repeated per tool.
 *
 * Optional parameters must accept null — models emit an explicit null for
 * arguments they mean to omit, and the API rejects the whole call otherwise.
 */
const CHAIN = 'ethereum|base|arbitrum|polygon';
const AMOUNT = 'Decimal, e.g. "1.5". Not wei.';

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'build_swap',
      description:
        'Trade one token for another on one chain.',
      parameters: {
        type: 'object',
        properties: {
          chain: { type: 'string', description: CHAIN },
          fromToken: { type: 'string', description: 'Symbol or 0x address to sell.' },
          toToken: { type: 'string', description: 'Symbol or 0x address to buy.' },
          amount: { type: 'string', description: AMOUNT },
          slippageBps: { type: ['number', 'null'], description: 'Basis points, default 50.' },
        },
        required: ['chain', 'fromToken', 'toToken', 'amount'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'build_transfer',
      description:
        'Send tokens to an address on the same chain.',
      parameters: {
        type: 'object',
        properties: {
          chain: { type: 'string', description: CHAIN },
          token: { type: 'string', description: 'Symbol or 0x address.' },
          amount: { type: 'string', description: AMOUNT },
          recipient: { type: 'string', description: '0x address or ENS name the user typed.' },
        },
        required: ['chain', 'token', 'amount', 'recipient'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'build_bridge',
      description: 'Move assets between two different chains.',
      parameters: {
        type: 'object',
        properties: {
          fromChain: { type: 'string', description: CHAIN },
          toChain: { type: 'string', description: CHAIN },
          fromToken: { type: 'string', description: 'Symbol or 0x address.' },
          toToken: { type: ['string', 'null'], description: 'Defaults to same asset.' },
          amount: { type: 'string', description: AMOUNT },
          recipient: {
            type: ['string', 'null'],
            description: 'Only an address the user typed. Omit for their own wallet.',
          },
        },
        required: ['fromChain', 'toChain', 'fromToken', 'amount'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_prices',
      description:
        'Spot price, 24h change, market cap. For "what is X worth".',
      parameters: {
        type: 'object',
        properties: {
          symbols: { type: 'array', items: { type: 'string' }, description: 'Tickers. Max 12.' },
        },
        required: ['symbols'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'earn',
      description:
        'Yield. pools = DeFi APYs, vaults = Morpho, deposit, withdraw.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['pools', 'vaults', 'deposit', 'withdraw'] },
          chain: { type: ['string', 'null'], description: CHAIN },
          asset: { type: ['string', 'null'], description: 'e.g. "USDC".' },
          amount: { type: ['string', 'null'], description: AMOUNT },
          amountUsd: { type: ['number', 'null'], description: 'USD principal, for pools.' },
          stablecoinsOnly: { type: ['boolean', 'null'] },
          riskTolerance: { type: ['string', 'null'], enum: ['low', 'medium', 'high', null] },
          vaultAddress: { type: ['string', 'null'], description: 'Address or vault name. Omit on deposit to take the best.' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'perps',
      description:
        'Hyperliquid perps. open = new position; positions = market limits, price, account. Use for max-leverage questions.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open', 'positions'] },
          coin: { type: ['string', 'null'], description: 'e.g. "BTC".' },
          side: { type: ['string', 'null'], enum: ['long', 'short', null] },
          notionalUsd: { type: ['number', 'null'], description: 'USD size. Min 10.' },
          leverage: { type: ['number', 'null'], description: 'Defaults to 1.' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'predictions',
      description:
        'Polymarket odds; read-only. Call when asked to bet too.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: ['string', 'null'], description: 'Keywords. Omit for top.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'portfolio',
      description:
        'Holdings, Morpho/Sky/Aave positions, 24h move. Call before sizing a relative trade.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFINITIONS)[number]['function']['name'];
