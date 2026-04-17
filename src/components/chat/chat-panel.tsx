'use client';

import { Sparkles, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChatInput } from './chat-input';
import { ChatMessages } from './chat-messages';
import { useChatContext } from './chat-provider';

export function ChatPanel() {
  const { messages, isLoading, isPanelOpen, activeTool, sendMessage, togglePanel, clearHistory } =
    useChatContext();

  return (
    <>
      {/* Backdrop on mobile */}
      {isPanelOpen && (
        <button
          type="button"
          aria-label="Close chat overlay"
          className="fixed inset-0 z-40 bg-black/40 sm:hidden"
          onClick={togglePanel}
        />
      )}

      {/* Panel */}
      <aside
        className={cn(
          'fixed top-0 right-0 z-50 flex h-full w-full flex-col border-l bg-background shadow-xl transition-transform duration-300 ease-in-out sm:w-[420px]',
          isPanelOpen ? 'translate-x-0' : 'translate-x-full',
        )}
        aria-label="Chat with Henry"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            <div>
              <h2 className="text-sm font-semibold leading-none">Henry</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Your business assistant</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {messages.length > 0 && (
              <button
                type="button"
                onClick={clearHistory}
                aria-label="Clear chat history"
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Trash2 className="size-4" />
              </button>
            )}
            <button
              type="button"
              onClick={togglePanel}
              aria-label="Close chat"
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <ChatMessages messages={messages} activeTool={activeTool} />

        {/* Input */}
        <ChatInput onSend={sendMessage} isLoading={isLoading} focusTrigger={isPanelOpen} />
      </aside>
    </>
  );
}
