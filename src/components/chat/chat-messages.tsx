'use client';

import { Sparkles } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@/hooks/use-chat';
import { ChatBubble } from './chat-bubble';
import { ChatToolIndicator } from './chat-tool-indicator';

export function ChatMessages({
  messages,
  activeTool,
}: {
  messages: ChatMessage[];
  activeTool: string | null;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

  // Auto-scroll whenever messages change or a tool is active.
  // biome-ignore lint/correctness/useExhaustiveDependencies: we intentionally scroll when messages/activeTool props change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    prevCountRef.current = messages.length;
  }, [messages, activeTool]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <Sparkles className="size-6 text-muted-foreground" />
        </div>
        <div>
          <p className="font-medium">Hi! I'm Henry, your business assistant.</p>
          <p className="mt-1 text-sm text-muted-foreground">Ask me anything about your business.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto py-4">
      {messages.map((msg) => (
        <ChatBubble key={msg.id} message={msg} />
      ))}
      {activeTool && <ChatToolIndicator toolName={activeTool} />}
      <div ref={bottomRef} />
    </div>
  );
}
