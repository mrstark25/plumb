import type { ChatMessage } from '@/types/chat';

export interface Conversation {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly ChatMessage[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

const STORAGE_KEY = 'liberty.conversations.v1';

/**
 * Conversations carry transaction calldata, which is bulky. Capping the list
 * keeps the store inside the browser's quota; the oldest are dropped first.
 */
const MAX_CONVERSATIONS = 40;
const TITLE_MAX_CHARS = 48;

/** First line of the opening message, trimmed to something a sidebar can show. */
export function deriveTitle(text: string): string {
  const firstLine = text.trim().split('\n')[0]?.trim() ?? '';
  if (firstLine.length === 0) return 'New chat';
  if (firstLine.length <= TITLE_MAX_CHARS) return firstLine;

  // Prefer breaking at a word boundary so titles do not end mid-word.
  const clipped = firstLine.slice(0, TITLE_MAX_CHARS);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > 24 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

export type RecencyBucket = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';

export function bucketFor(updatedAt: number, now = Date.now()): RecencyBucket {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const dayMs = 86_400_000;

  if (updatedAt >= startOfToday) return 'Today';
  if (updatedAt >= startOfToday - dayMs) return 'Yesterday';
  if (updatedAt >= startOfToday - 7 * dayMs) return 'Previous 7 days';
  return 'Older';
}

export interface ConversationGroup {
  readonly label: RecencyBucket;
  readonly conversations: readonly Conversation[];
}

/** Groups newest-first, preserving bucket order and dropping empty buckets. */
export function groupByRecency(
  conversations: readonly Conversation[],
  now = Date.now(),
): ConversationGroup[] {
  const order: RecencyBucket[] = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

  return order
    .map((label) => ({
      label,
      conversations: sorted.filter((c) => bucketFor(c.updatedAt, now) === label),
    }))
    .filter((group) => group.conversations.length > 0);
}

export function pruneToLimit(conversations: readonly Conversation[]): Conversation[] {
  return [...conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
}

/**
 * Reads the stored history.
 *
 * Every failure mode returns an empty list rather than throwing: storage can be
 * unavailable in a private window, cleared mid-session, or hold data written by
 * an older version of this app. None of those should stop the user chatting.
 */
export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isConversation);
  } catch {
    return [];
  }
}

export function saveConversations(conversations: readonly Conversation[]): void {
  const pruned = pruneToLimit(conversations);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned));
  } catch {
    // Almost always a quota error. Retry with a much smaller window before
    // giving up, so the recent history survives even when the store is full.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned.slice(0, 5)));
    } catch {
      // Storage is unusable; the session continues in memory only.
    }
  }
}

function isConversation(value: unknown): value is Conversation {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.title === 'string' &&
    typeof c.createdAt === 'number' &&
    typeof c.updatedAt === 'number' &&
    Array.isArray(c.messages)
  );
}
