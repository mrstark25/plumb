'use client';

import { useMemo } from 'react';
import { groupByRecency } from '@/lib/conversations';
import type { useConversations } from '@/hooks/useConversations';
import './sidebar.css';

interface SidebarProps {
  readonly store: ReturnType<typeof useConversations>;
  readonly isOpen: boolean;
  readonly onToggle: () => void;
}

export function Sidebar({ store, isOpen, onToggle }: SidebarProps) {
  // Recompute only when the list changes; bucketing walks every conversation.
  const groups = useMemo(() => groupByRecency(store.conversations), [store.conversations]);

  return (
    <>
      {/* Tapping the scrim closes the drawer on small screens. */}
      <div
        className={`sidebar-scrim${isOpen ? ' is-visible' : ''}`}
        onClick={onToggle}
        aria-hidden="true"
      />

      <aside className={`sidebar${isOpen ? '' : ' is-collapsed'}`} aria-label="Conversation history">
        <div className="sidebar-top">
          <button
            type="button"
            className="icon-button"
            onClick={onToggle}
            aria-label={isOpen ? 'Close sidebar' : 'Open sidebar'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
              <path d="M9.5 4v16" stroke="currentColor" strokeWidth="1.7" />
            </svg>
          </button>

          <button type="button" className="new-chat" onClick={store.startNew}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>New chat</span>
          </button>
        </div>

        <nav className="sidebar-history">
          {store.conversations.length === 0 ? (
            <p className="sidebar-empty">
              {store.isRestored
                ? 'Your chats appear here. They stay on this device.'
                : ''}
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.label} className="history-group">
                <h2 className="history-label">{group.label}</h2>
                <ul>
                  {group.conversations.map((conversation) => (
                    <li key={conversation.id}>
                      <div
                        className={`history-item${conversation.id === store.activeId ? ' is-active' : ''}`}
                      >
                        <button
                          type="button"
                          className="history-open"
                          onClick={() => store.select(conversation.id)}
                          title={conversation.title}
                        >
                          {conversation.title}
                        </button>
                        <button
                          type="button"
                          className="history-delete"
                          onClick={() => store.remove(conversation.id)}
                          aria-label={`Delete "${conversation.title}"`}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"
                              stroke="currentColor" strokeWidth="1.7"
                              strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </nav>

        <footer className="sidebar-foot">
          <p>History is stored in this browser only. Plumb never holds your keys.</p>
          {store.conversations.length > 0 && (
            <button type="button" className="sidebar-clear" onClick={store.clearAll}>
              Clear all chats
            </button>
          )}
        </footer>
      </aside>
    </>
  );
}
