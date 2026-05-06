'use client';

/**
 * Project messaging thread — operator side.
 *
 * Renders the full conversation chronologically and lets the operator
 * post a new outbound message. After submit, a "sending in Ns" chip
 * shows a live countdown with an Undo button; the cron drainer fires
 * the customer notification when the timer elapses (see
 * /api/cron/project-message-notify).
 *
 * Polls every 5 seconds via getProjectMessagesAction so the customer's
 * replies appear without a manual refresh — meets the "Henry handles
 * the page refresh for you" UX requirement.
 */

import { Loader2, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  cancelProjectMessageNotifyAction,
  getProjectMessagesAction,
  type MessageRow,
  markProjectMessagesReadAction,
  postProjectMessageAction,
} from '@/server/actions/project-messages';

const POLL_INTERVAL_MS = 5_000;
const NOTIFY_DELAY_SECONDS = 30;

export function MessagesThread({
  projectId,
  initialMessages,
  customerName,
  portalSlug,
}: {
  projectId: string;
  initialMessages: MessageRow[];
  customerName: string;
  portalSlug: string | null;
}) {
  const [messages, setMessages] = useState<MessageRow[]>(initialMessages);
  const [body, setBody] = useState('');
  const [pending, startTransition] = useTransition();
  const [pendingSendAt, setPendingSendAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom whenever the message count changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on length change only
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Mark inbound as read on mount. Don't await — UI shouldn't block.
  useEffect(() => {
    void markProjectMessagesReadAction(projectId);
  }, [projectId]);

  // Poll for new messages every 5s. Replaces the whole array on each
  // tick — the API is small and the array is short, so the cost is
  // negligible. Scroll only triggers when length changes (see above).
  useEffect(() => {
    const tick = async () => {
      const res = await getProjectMessagesAction(projectId);
      if (res.ok) {
        setMessages((prev) => {
          if (prev.length === res.messages.length) {
            const lastPrev = prev[prev.length - 1]?.id;
            const lastNext = res.messages[res.messages.length - 1]?.id;
            if (lastPrev === lastNext) return prev;
          }
          return res.messages;
        });
      }
    };
    const interval = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [projectId]);

  // Countdown ticker for the pending-send chip.
  useEffect(() => {
    if (!pendingSendAt) return;
    const tick = () => {
      const remaining = Math.max(0, Math.round((pendingSendAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) setPendingSendAt(null);
    };
    tick();
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, [pendingSendAt]);

  const handleSubmit = useCallback(() => {
    const trimmed = body.trim();
    if (!trimmed) return;

    startTransition(async () => {
      const res = await postProjectMessageAction({ projectId, body: trimmed });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setBody('');
      setPendingSendAt(Date.now() + NOTIFY_DELAY_SECONDS * 1000);
      // Optimistically refresh the thread so the new message shows
      // immediately rather than waiting for the next poll.
      const fresh = await getProjectMessagesAction(projectId);
      if (fresh.ok) setMessages(fresh.messages);
    });
  }, [body, projectId]);

  const handleUndo = useCallback(() => {
    startTransition(async () => {
      const res = await cancelProjectMessageNotifyAction(projectId);
      if (res.ok) {
        setPendingSendAt(null);
        toast.success('Customer notification cancelled. The message stays in the thread.');
      }
    });
  }, [projectId]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-2">
          <p className="text-sm font-semibold">Conversation with {customerName}</p>
          {portalSlug ? (
            <p className="text-xs text-muted-foreground">
              Customer sees this on their portal Messages tab.
            </p>
          ) : null}
        </div>

        <div className="max-h-[60vh] min-h-[240px] overflow-y-auto px-4 py-4 space-y-3">
          {messages.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No messages yet. Start the conversation below.
            </p>
          ) : null}
          {messages.map((m) => {
            const fromOperator = m.direction === 'outbound';
            return (
              <div key={m.id} className={`flex ${fromOperator ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 ${
                    fromOperator
                      ? 'bg-primary text-primary-foreground'
                      : 'border bg-muted/40 text-foreground'
                  }`}
                >
                  <p className="mb-0.5 text-[11px] font-medium opacity-80">
                    {m.sender_label ?? (fromOperator ? 'You' : customerName)}
                  </p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.body}</p>
                  <p className="mt-1 text-[10px] opacity-70">
                    {new Date(m.created_at).toLocaleTimeString('en-CA', {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>
            );
          })}
          <div ref={threadEndRef} />
        </div>

        <div className="border-t bg-muted/20 px-4 py-3 space-y-2">
          {pendingSendAt && secondsLeft > 0 ? (
            <div className="flex items-center justify-between rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
              <span>
                Sending notification in <strong>{secondsLeft}s</strong> — collapses if you keep
                typing.
              </span>
              <button
                type="button"
                onClick={handleUndo}
                className="ml-2 rounded px-2 py-0.5 text-xs font-semibold text-amber-900 underline hover:bg-amber-100"
              >
                Undo
              </button>
            </div>
          ) : null}
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`Message to ${customerName}…`}
            rows={3}
            className="resize-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">⌘/Ctrl + Enter to send</p>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={pending || !body.trim()}
              size="sm"
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
