'use client';

import { MessageSquare, X } from 'lucide-react';
import { useChatContext } from './chat-provider';

export function ChatToggle() {
  const { isPanelOpen, togglePanel } = useChatContext();

  return (
    <button
      type="button"
      onClick={togglePanel}
      aria-label={isPanelOpen ? 'Close chat' : 'Open chat'}
      className="fixed bottom-4 right-4 z-50 flex size-12 items-center justify-center rounded-full bg-[#0a0a0a] text-white shadow-lg transition-transform hover:scale-105 active:scale-95 sm:bottom-6 sm:right-6 sm:size-14 dark:bg-white dark:text-[#0a0a0a]"
    >
      {isPanelOpen ? <X className="size-6" /> : <MessageSquare className="size-6" />}
    </button>
  );
}
