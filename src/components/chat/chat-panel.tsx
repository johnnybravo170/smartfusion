'use client';

import { Keyboard, Mic, Sparkles, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
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
    sendMessage,
    togglePanel,
    clearHistory,
    voice,
  } = useChatContext();

  // When voice mode is on, user can temporarily switch to keyboard input.
  const [showKeyboard, setShowKeyboard] = useState(false);

  const showPushToTalk = voice.voiceEnabled && !showKeyboard;

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

          {/* Voice indicator */}
          <VoiceIndicator voiceState={voice.voiceState} onStopSpeaking={voice.stopSpeaking} />

          {/* Messages */}
          <ChatMessages messages={messages} activeTool={activeTool} />

          {/* Input area: push-to-talk OR text input */}
          {showPushToTalk ? (
            <PushToTalkInput
              voiceState={voice.voiceState}
              onStartPTT={voice.startPushToTalk}
              onStopPTT={voice.stopPushToTalk}
              onSwitchToKeyboard={() => setShowKeyboard(true)}
            />
          ) : (
            <div className="relative">
              <ChatInput onSend={sendMessage} isLoading={isLoading} focusTrigger={isPanelOpen} />
              {voice.voiceEnabled && (
                <button
                  type="button"
                  onClick={() => setShowKeyboard(false)}
                  aria-label="Switch to voice input"
                  className="absolute top-3 right-14 flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Mic className="size-4" />
                </button>
              )}
            </div>
          )}
        </aside>
      )}
    </>
  );
}

/** Hold-to-talk mic button that replaces the text input when voice mode is on. */
function PushToTalkInput({
  voiceState,
  onStartPTT,
  onStopPTT,
  onSwitchToKeyboard,
}: {
  voiceState: string;
  onStartPTT: () => void;
  onStopPTT: () => void;
  onSwitchToKeyboard: () => void;
}) {
  const isActive = voiceState === 'listening';

  return (
    <div className="border-t p-3">
      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={onSwitchToKeyboard}
          aria-label="Switch to keyboard"
          className="flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Keyboard className="size-4" />
        </button>
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            onStartPTT();
          }}
          onPointerUp={onStopPTT}
          onPointerLeave={onStopPTT}
          aria-label={isActive ? 'Release to send' : 'Hold to talk'}
          className={cn(
            'flex size-14 items-center justify-center rounded-full transition-all',
            isActive
              ? 'scale-110 bg-red-500 text-white shadow-lg shadow-red-500/30'
              : 'bg-primary text-primary-foreground hover:scale-105 active:scale-110',
          )}
        >
          <Mic className="size-6" />
        </button>
        {/* Spacer to keep the mic centered */}
        <div className="size-9" />
      </div>
      <p className="mt-2 text-center text-xs text-muted-foreground">
        {isActive ? 'Release to send' : 'Hold to talk'}
      </p>
    </div>
  );
}
