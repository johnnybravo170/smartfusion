'use client';

import { Sparkles, User } from 'lucide-react';
import type { HenryMessage } from '@/hooks/use-henry';
import { cn } from '@/lib/utils';

export function ChatBubble({ message }: { message: HenryMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={cn('flex gap-2 px-4', isUser ? 'flex-row-reverse' : 'flex-row')}>
      {/* Avatar */}
      <div
        className={cn(
          'mt-1 flex size-7 shrink-0 items-center justify-center rounded-full',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
        )}
      >
        {isUser ? <User className="size-4" /> : <Sparkles className="size-4" />}
      </div>

      {/* Bubble */}
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
        )}
      >
        <span className="whitespace-pre-wrap break-words">{message.content}</span>
        {message.isStreaming && (
          <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-current align-text-bottom" />
        )}
      </div>
    </div>
  );
}
