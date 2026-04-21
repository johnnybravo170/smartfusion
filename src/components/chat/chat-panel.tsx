'use client';

import { Sparkles, Trash2, X } from 'lucide-react';
import { ChatInput } from './chat-input';
import { ChatMessages } from './chat-messages';
import { useChatContext } from './chat-provider';
import { VoiceIndicator } from './voice-indicator';
import { VoiceToggle } from './voice-toggle';

export function ChatPanel() {
  const {
    messages,
    isLoading,
    isPanelOpen,
    activeTool,
    error,
    sendMessage,
    togglePanel,
    clearHistory,
    clearError,
    voice,
  } = useChatContext();

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

      {/* Panel -- only rendered when open to prevent mobile overflow */}
      {isPanelOpen && (
        <aside
          className="fixed inset-0 z-50 flex flex-col bg-background sm:inset-auto sm:top-0 sm:right-0 sm:h-full sm:w-[420px] sm:border-l sm:shadow-xl"
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
              <VoiceToggle
                voiceState={voice.voiceState}
                isSupported={voice.isSupported}
                onToggle={voice.toggleVoice}
              />
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

          {/* Voice indicator -- shows listening/processing/speaking state when voice is on */}
          <VoiceIndicator voiceState={voice.voiceState} onStopSpeaking={voice.stopSpeaking} />

          {/* Error banner */}
          {error && (
            <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              <div className="flex items-start justify-between gap-2">
                <span className="break-words">{error}</span>
                <button
                  type="button"
                  onClick={clearError}
                  aria-label="Dismiss error"
                  className="shrink-0 text-red-900/60 hover:text-red-900 dark:text-red-200/60 dark:hover:text-red-200"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Messages */}
          <ChatMessages messages={messages} activeTool={activeTool} />

          {/* Text input is always available. Voice (when on) streams continuously
              and server VAD handles turn-taking -- no push-to-talk button. */}
          <ChatInput onSend={sendMessage} isLoading={isLoading} focusTrigger={isPanelOpen} />
        </aside>
      )}
    </>
  );
}
