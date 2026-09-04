'use client';

import { useEffect, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useChat } from '@/hooks/useChat';
import { useConversations } from '@/hooks/useConversations';
import { useHyperliquidAgent } from '@/hooks/useHyperliquidAgent';
import { AppHeader } from './AppHeader';
import { Composer } from './Composer';
import { Greeting } from './Greeting';
import { MessageList } from './MessageList';
import { Sidebar } from './Sidebar';
import './chat.css';

export function ChatShell() {
  const wallet = useWallet();
  const store = useConversations();
  const agent = useHyperliquidAgent(wallet.address);
  const chat = useChat(store, {
    address: wallet.address,
    chainId: wallet.chainId,
    agentAddress: agent?.address ?? null,
  });

  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Start collapsed on narrow screens, where the sidebar is an overlay.
  useEffect(() => {
    if (window.matchMedia('(max-width: 900px)').matches) setIsSidebarOpen(false);
  }, []);

  const isNewChat = chat.messages.length === 0;

  return (
    <div className={`app${isSidebarOpen ? '' : ' sidebar-collapsed'}`}>
      <Sidebar
        store={store}
        isOpen={isSidebarOpen}
        onToggle={() => setIsSidebarOpen((open) => !open)}
      />

      <div className="app-body">
        <AppHeader
          wallet={wallet}
          onOpenSidebar={() => setIsSidebarOpen(true)}
          isSidebarOpen={isSidebarOpen}
        />

        <main className={`app-main${isNewChat ? ' is-new' : ''}`}>
          {isNewChat ? (
            <Greeting onSend={chat.send} />
          ) : (
            <MessageList messages={chat.messages} isThinking={chat.isThinking} wallet={wallet} />
          )}

          <Composer onSend={chat.send} isThinking={chat.isThinking} onStop={chat.stop} />
        </main>
      </div>
    </div>
  );
}
