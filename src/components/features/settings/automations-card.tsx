'use client';

import { Bot, Sparkles } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { setAutoQuoteFollowupAction } from '@/server/actions/automations';

export function AutomationsCard({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();

  const onToggle = () => {
    const next = !enabled;
    startTransition(async () => {
      const res = await setAutoQuoteFollowupAction(next);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setEnabled(next);
      toast.success(next ? 'Quote follow-up turned on.' : 'Quote follow-up turned off.');
    });
  };

  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {enabled ? (
            <Sparkles className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden />
          ) : (
            <Bot className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">Quote follow-up autopilot</h2>
            <p className="text-sm text-muted-foreground">
              When you send a quote, Henry follows up automatically — SMS at 24h, email at 48h.
              Customers who reply or accept are removed from the sequence.
            </p>
            <p className="text-xs text-muted-foreground">
              You can override per-quote at send time, and customers who reply STOP or unsubscribe
              are honored automatically.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant={enabled ? 'outline' : 'default'}
          size="sm"
          disabled={pending}
          onClick={onToggle}
        >
          {pending ? 'Saving…' : enabled ? 'Turn off' : 'Turn on'}
        </Button>
      </div>
    </section>
  );
}
