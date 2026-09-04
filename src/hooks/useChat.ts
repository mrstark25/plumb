'use client';

import { useCallback, useRef, useState } from 'react';
import type { Attachment, ChatMessage, ChatResponse } from '@/types/chat';
import type { useConversations } from './useConversations';

interface WalletContext {
  readonly address: string | null;
  readonly chainId: number | null;
  readonly agentAddress?: string | null;
}

type Store = ReturnType<typeof useConversations>;

export function useChat(store: Store, wallet: WalletContext) {
  const [isThinking, setIsThinking] = useState(false);
  const inFlight = useRef<AbortController | null>(null);

  const messages = store.active?.messages ?? [];

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isThinking) return;

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: trimmed,
        createdAt: Date.now(),
      };

      // Captured before the state update so the request is never a turn behind.
      const history = [...messages, userMessage].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      store.appendMessages([userMessage]);
      setIsThinking(true);

      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: history, wallet }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed (${response.status}).`);
        }

        const data = (await response.json()) as ChatResponse;
        appendAssistant(data.content, data.attachments);
      } catch (cause) {
        if (controller.signal.aborted) return;
        appendAssistant('', [{ type: 'error', message: describe(cause) }]);
      } finally {
        if (inFlight.current === controller) inFlight.current = null;
        setIsThinking(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, isThinking, wallet.address, wallet.chainId, wallet.agentAddress, store.appendMessages],
  );

  function appendAssistant(content: string, attachments: readonly Attachment[]) {
    store.appendMessages([
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content,
        attachments,
        createdAt: Date.now(),
      },
    ]);
  }

  const stop = useCallback(() => {
    inFlight.current?.abort();
    setIsThinking(false);
  }, []);

  return { messages, isThinking, send, stop };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Something went wrong reaching Plumb.';
}
