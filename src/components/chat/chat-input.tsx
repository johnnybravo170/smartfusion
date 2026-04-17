'use client';

import { Loader2, SendHorizonal } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useRef } from 'react';

export function ChatInput({
  onSend,
  isLoading,
  focusTrigger,
}: {
  onSend: (content: string) => void;
  isLoading: boolean;
  /** Change this value to re-trigger focus (e.g. pass isPanelOpen). */
  focusTrigger?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus when the panel opens.
  useEffect(() => {
    if (focusTrigger) {
      // Small delay so the slide-in animation doesn't fight focus.
      const id = setTimeout(() => textareaRef.current?.focus(), 150);
      return () => clearTimeout(id);
    }
  }, [focusTrigger]);

  const resetHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // Max 4 rows (~96px).
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const value = el.value.trim();
    if (!value || isLoading) return;
    onSend(value);
    el.value = '';
    resetHeight();
  }, [isLoading, onSend, resetHeight]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="border-t p-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          rows={1}
          placeholder="Ask Henry anything..."
          disabled={isLoading}
          onInput={resetHeight}
          onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 resize-none rounded-xl border bg-background px-3 py-2 text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={isLoading}
          aria-label="Send message"
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {isLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <SendHorizonal className="size-4" />
          )}
        </button>
      </div>
    </div>
  );
}
