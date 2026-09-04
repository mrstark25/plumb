import type { TxProposal } from './tx';
import type { YieldOpportunity } from '@/lib/providers/defillama';
import type { MorphoVault } from '@/lib/providers/vault-types';
import type { CoinPrice } from '@/lib/providers/coingecko';
import type { PredictionMarket } from '@/lib/providers/polymarket';
import type { PortfolioSnapshot } from '@/lib/portfolio/snapshot';
import type { FundingPlan } from '@/lib/agent/handlers/funding';

export type Role = 'user' | 'assistant' | 'system';

/** Structured payloads an assistant turn can render alongside its prose. */
export type Attachment =
  | { readonly type: 'proposal'; readonly proposal: TxProposal }
  | { readonly type: 'yields'; readonly title: string; readonly pools: readonly YieldOpportunity[] }
  | { readonly type: 'vaults'; readonly title: string; readonly vaults: readonly MorphoVault[] }
  | { readonly type: 'markets'; readonly title: string; readonly markets: readonly PredictionMarket[] }
  | {
      readonly type: 'prices';
      readonly title: string;
      readonly prices: readonly CoinPrice[];
      readonly source: string;
    }
  | { readonly type: 'portfolio'; readonly snapshot: PortfolioSnapshot }
  | { readonly type: 'funding'; readonly plan: FundingPlan }
  | { readonly type: 'error'; readonly message: string };

export interface ChatMessage {
  readonly id: string;
  readonly role: Role;
  readonly content: string;
  readonly attachments?: readonly Attachment[];
  readonly createdAt: number;
}

/** Wire format for POST /api/chat. The system role is server-side only. */
export interface ChatRequest {
  readonly messages: readonly { role: 'user' | 'assistant'; content: string }[];
  readonly wallet: {
    readonly address: string | null;
    readonly chainId: number | null;
    /** Hyperliquid agent address held in this browser, if any. */
    readonly agentAddress?: string | null;
  };
}

export interface ChatResponse {
  readonly content: string;
  readonly attachments: readonly Attachment[];
}
