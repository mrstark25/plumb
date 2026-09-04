'use client';

import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@/types/chat';
import type { WalletSession } from '@/lib/wallet-session';
import { MessageBubble } from './MessageBubble';

interface MessageListProps {
  readonly messages: readonly ChatMessage[];
  readonly isThinking: boolean;
  readonly wallet: WalletSession;
}

export function MessageList({ messages, isThinking, wallet }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, isThinking]);

  return (
    <div className="message-list" role="log" aria-live="polite" aria-label="Conversation">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} wallet={wallet} />
      ))}

      {isThinking && (
        <div className="thinking" aria-label="Plumb is working">
          <span /><span /><span />
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}
