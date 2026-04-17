'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
};

export type UseChatReturn = {
  messages: ChatMessage[];
  isLoading: boolean;
  isPanelOpen: boolean;
  activeTool: string | null;
  sendMessage: (content: string) => void;
  togglePanel: () => void;
  clearHistory: () => void;
};

const PANEL_STORAGE_KEY = 'heyhenry-chat-open';

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function readPanelState(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(PANEL_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Hydrate panel state from localStorage after mount.
  useEffect(() => {
    setIsPanelOpen(readPanelState());
  }, []);

  const togglePanel = useCallback(() => {
    setIsPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PANEL_STORAGE_KEY, String(next));
      } catch {
        // localStorage unavailable
      }
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setMessages([]);
    setActiveTool(null);
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed || isLoading) return;

      const userMsg: ChatMessage = { id: generateId(), role: 'user', content: trimmed };
      const assistantId = generateId();

      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantId, role: 'assistant', content: '', isStreaming: true },
      ]);
      setIsLoading(true);
      setActiveTool(null);

      // Build the history to send: exclude any currently-streaming message.
      const history = [...messages, userMsg]
        .filter((m) => !m.isStreaming)
        .map((m) => ({ role: m.role, content: m.content }));

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: history }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => 'Request failed');
          throw new Error(text);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error('No response stream');

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          // Keep the last (possibly incomplete) line in the buffer.
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            try {
              const chunk = JSON.parse(trimmedLine) as {
                type: string;
                content?: string;
                name?: string;
                message?: string;
              };

              switch (chunk.type) {
                case 'text':
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, content: m.content + (chunk.content ?? '') }
                        : m,
                    ),
                  );
                  break;
                case 'tool_start':
                  setActiveTool(chunk.name ?? null);
                  break;
                case 'tool_end':
                  setActiveTool(null);
                  break;
                case 'done':
                  setMessages((prev) =>
                    prev.map((m) => (m.id === assistantId ? { ...m, isStreaming: false } : m)),
                  );
                  setIsLoading(false);
                  setActiveTool(null);
                  return;
                case 'error':
                  throw new Error(chunk.message ?? 'Unknown error');
              }
            } catch (e) {
              // If it's our own thrown error, re-throw.
              if (e instanceof Error && e.message !== 'Unknown error') {
                // Only re-throw if it came from our switch/case, not JSON.parse.
                const isParseError =
                  e instanceof SyntaxError ||
                  e.message.startsWith('Unexpected') ||
                  e.message.startsWith('Expected');
                if (!isParseError) throw e;
              }
              // Otherwise skip malformed JSON lines silently.
            }
          }
        }

        // Stream ended without a `done` chunk; finalize anyway.
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, isStreaming: false } : m)),
        );
        setIsLoading(false);
        setActiveTool(null);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;

        // Show error in the assistant message.
        const errorText =
          err instanceof Error ? err.message : 'Something went wrong. Please try again.';
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Sorry, something went wrong: ${errorText}`, isStreaming: false }
              : m,
          ),
        );
        setIsLoading(false);
        setActiveTool(null);
      }
    },
    [isLoading, messages],
  );

  return { messages, isLoading, isPanelOpen, activeTool, sendMessage, togglePanel, clearHistory };
}
