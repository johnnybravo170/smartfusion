'use client';

/**
 * Customer-side messages panel on the public portal.
 *
 * Mirrors the operator MessagesThread but uses the portal-slug-keyed
 * server actions (no auth context). Polls every 5 seconds so messages
 * the contractor sends appear without the customer needing to refresh —
 * Henry handles the refresh.
 */

import { Loader2, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  getCustomerPortalMessagesAction,
  type MessageRow,
  markCustomerPortalMessagesReadAction,
  postCustomerPortalMessageAction,
} from '@/server/actions/project-messages';

const POLL_INTERVAL_MS = 5_000;

export function PortalMessagesPanel({
  portalSlug,
  initialMessages,
  customerName,
  businessName,
}: {
  portalSlug: string;
  initialMessages: MessageRow[];
  customerName: string;
  businessName: string;
}) {
  const [messages, setMessages] = useState<MessageRow[]>(initialMessages);
  const [body, setBody] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on length change only
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Mark outbound (operator → customer) as read on mount.
  useEffect(() => {
    void markCustomerPortalMessagesReadAction(portalSlug);
  }, [portalSlug]);

  useEffect(() => {
    const tick = async () => {
      const res = await getCustomerPortalMessagesAction(portalSlug);
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
  }, [portalSlug]);

  const handleSubmit = useCallback(() => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setError(null);

    startTransition(async () => {
      const res = await postCustomerPortalMessageAction({ portalSlug, body: trimmed });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setBody('');
      const fresh = await getCustomerPortalMessagesAction(portalSlug);
      if (fresh.ok) setMessages(fresh.messages);
    });
  }, [body, portalSlug]);

  return (
    <div className="rounded-lg border bg-white">
      <div className="border-b px-4 py-3">
        <p className="text-sm font-semibold">Messages</p>
        <p className="text-xs text-muted-foreground">
          Send {businessName} a question or update. They see your message right away.
        </p>
      </div>

      <div className="max-h-[60vh] min-h-[240px] overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No messages yet. Send the first one below.
          </p>
        ) : null}
        {messages.map((m) => {
          // From the customer's POV: outbound (operator → customer) is the
          // contractor side; inbound (customer → operator) is the customer
          // themselves. Flip the bubble alignment vs the operator view.
          const fromBusiness = m.direction === 'outbound';
          return (
            <div key={m.id} className={`flex ${fromBusiness ? 'justify-start' : 'justify-end'}`}>
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 ${
                  fromBusiness
                    ? 'border bg-muted/40 text-foreground'
                    : 'bg-primary text-primary-foreground'
                }`}
              >
                <p className="mb-0.5 text-[11px] font-medium opacity-80">
                  {m.sender_label ?? (fromBusiness ? businessName : customerName)}
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
        {error ? <p className="text-xs text-red-600">{error}</p> : null}
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={`Message ${businessName}…`}
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
          <Button type="button" onClick={handleSubmit} disabled={pending || !body.trim()} size="sm">
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
  );
}
