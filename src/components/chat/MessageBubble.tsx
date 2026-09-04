'use client';

import type { ChatMessage } from '@/types/chat';
import type { WalletSession } from '@/lib/wallet-session';
import { TxProposalCard } from '@/components/tx/TxProposalCard';
import { YieldTable } from '@/components/yield/YieldTable';
import { VaultTable } from '@/components/vault/VaultTable';
import { PriceTable } from '@/components/price/PriceTable';
import { MarketTable } from '@/components/prediction/MarketTable';
import { PortfolioPanel } from '@/components/portfolio/PortfolioPanel';
import { FundingCard } from '@/components/funding/FundingCard';
import { Prose } from '@/components/ui/Prose';

interface MessageBubbleProps {
  readonly message: ChatMessage;
  readonly wallet: WalletSession;
}

/**
 * A turn in the transcript. Both sides are rendered as labelled blocks rather
 * than chat bubbles — this is a record of instructions and quotes, and it
 * should read like one.
 */
export function MessageBubble({ message, wallet }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <article className={`turn turn--${isUser ? 'user' : 'agent'}`}>
      <p className="turn-label label">{isUser ? 'You' : 'Plumb'}</p>

      <div className="turn-body">
        {message.content &&
          (isUser ? <p className="turn-text">{message.content}</p> : <Prose text={message.content} />)}

        {message.attachments?.map((attachment, index) => {
          switch (attachment.type) {
            case 'proposal':
              return (
                <TxProposalCard
                  key={attachment.proposal.id}
                  proposal={attachment.proposal}
                  wallet={wallet}
                />
              );
            case 'yields':
              return (
                <YieldTable key={`yields-${index}`} title={attachment.title} pools={attachment.pools} />
              );
            case 'vaults':
              return (
                <VaultTable key={`vaults-${index}`} title={attachment.title} vaults={attachment.vaults} />
              );
            case 'prices':
              return (
                <PriceTable
                  key={`prices-${index}`}
                  title={attachment.title}
                  prices={attachment.prices}
                  source={attachment.source}
                />
              );
            case 'markets':
              return (
                <MarketTable key={`markets-${index}`} title={attachment.title} markets={attachment.markets} />
              );
            case 'portfolio':
              return <PortfolioPanel key={`portfolio-${index}`} snapshot={attachment.snapshot} />;
            case 'funding':
              return (
                <FundingCard key={`funding-${index}`} plan={attachment.plan} wallet={wallet} />
              );
            case 'error':
              return (
                <p key={`error-${index}`} className="turn-error" role="alert">
                  {attachment.message}
                </p>
              );
          }
        })}
      </div>
    </article>
  );
}
