'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deriveTitle, loadConversations, saveConversations, type Conversation,
} from '@/lib/conversations';
import type { ChatMessage } from '@/types/chat';

/**
 * Conversation history, persisted per browser in localStorage.
 *
 * There is no account system here, so history is deliberately local: it never
 * leaves the device and is not synced. Restoring it is best-effort — a private
 * window or cleared storage simply starts an empty list.
 */
export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isRestored, setIsRestored] = useState(false);

  /*
   * The active id is mirrored in a ref because an in-flight reply appends its
   * answer through a callback captured before the conversation existed. Reading
   * state there would see `null` and start a second, empty conversation.
   */
  const activeIdRef = useRef<string | null>(null);
  const setActive = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
  }, []);

  // Read once on mount. Server-rendered HTML has no storage, so this cannot
  // run during render without causing a hydration mismatch.
  useEffect(() => {
    setConversations(loadConversations());
    setIsRestored(true);
  }, []);

  useEffect(() => {
    if (isRestored) saveConversations(conversations);
  }, [conversations, isRestored]);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  /** Starts a fresh chat. The record is only created once something is said. */
  const startNew = useCallback(() => setActive(null), [setActive]);

  const select = useCallback((id: string) => setActive(id), [setActive]);

  const remove = useCallback(
    (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeIdRef.current === id) setActive(null);
    },
    [setActive],
  );

  const clearAll = useCallback(() => {
    setConversations([]);
    setActive(null);
  }, [setActive]);

  /**
   * Appends to the active conversation, creating it on the first message so
   * that abandoned empty chats never appear in the sidebar.
   */
  const appendMessages = useCallback(
    (messages: readonly ChatMessage[]) => {
      if (messages.length === 0) return;
      const now = Date.now();

      /*
       * The id and the decision to adopt it are both settled here, outside the
       * updater. React may invoke an updater more than once with the same
       * input, so generating a UUID inside it would mint a different id per
       * call and leave a duplicate conversation behind.
       */
      const targetId = activeIdRef.current ?? crypto.randomUUID();
      if (activeIdRef.current !== targetId) setActive(targetId);

      setConversations((prev) => {
        if (prev.some((c) => c.id === targetId)) {
          return prev.map((c) =>
            c.id === targetId
              ? { ...c, messages: [...c.messages, ...messages], updatedAt: now }
              : c,
          );
        }

        const firstUser = messages.find((m) => m.role === 'user');
        return [
          {
            id: targetId,
            title: deriveTitle(firstUser?.content ?? ''),
            messages: [...messages],
            createdAt: now,
            updatedAt: now,
          },
          ...prev,
        ];
      });
    },
    [setActive],
  );

  /** Replaces the active conversation's messages, used to attach a reply. */
  const replaceMessages = useCallback(
    (updater: (messages: readonly ChatMessage[]) => ChatMessage[]) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeIdRef.current
            ? { ...c, messages: updater(c.messages), updatedAt: Date.now() }
            : c,
        ),
      );
    },
    [],
  );

  return {
    conversations,
    active,
    activeId,
    isRestored,
    startNew,
    select,
    remove,
    clearAll,
    appendMessages,
    replaceMessages,
  };
}
