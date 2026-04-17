'use client';

import { createContext, type ReactNode, useContext } from 'react';
import { type UseChatReturn, useChat } from '@/hooks/use-chat';
import { type UseVoiceReturn, useVoice } from '@/hooks/use-voice';

type ChatContextValue = UseChatReturn & { voice: UseVoiceReturn };

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const chat = useChat();
  const voice = useVoice(chat.sendMessage, chat.latestCompleteResponse);
  return <ChatContext.Provider value={{ ...chat, voice }}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChatContext must be used within ChatProvider');
  return ctx;
}
