'use client';

import { createContext, type ReactNode, useContext } from 'react';
import { type UseChatReturn, useChat } from '@/hooks/use-chat';

const ChatContext = createContext<UseChatReturn | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const chat = useChat();
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

export function useChatContext(): UseChatReturn {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChatContext must be used within ChatProvider');
  return ctx;
}
