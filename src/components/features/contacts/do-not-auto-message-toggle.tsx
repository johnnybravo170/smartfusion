'use client';

import { Ban, ShieldCheck } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { setDoNotAutoMessageAction } from '@/server/actions/customers';

const SOURCE_LABELS: Record<string, string> = {
  unsubscribe_link: 'clicked unsubscribe link',
  sms_stop: 'replied STOP to a text',
  email_complaint: 'marked an email as spam',
  manual_owner: 'turned off manually',
  manual_admin: 'turned off manually',
};

export function DoNotAutoMessageToggle({
  customerId,
  enabled,
  setAt,
  source,
  timezone,
}: {
  customerId: string;
  enabled: boolean;
  setAt: string | null;
  source: string | null;
  timezone: string;
}) {
  const [pending, startTransition] = useTransition();

  const onToggle = () => {
    const next = !enabled;
    startTransition(async () => {
      const res = await setDoNotAutoMessageAction(customerId, next);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        next
          ? 'Auto-messages turned off for this contact.'
          : 'Auto-messages turned back on for this contact.',
      );
    });
  };

  const setAtFmt = setAt ? new Date(setAt).toLocaleString(undefined, { timeZone: timezone }) : null;
  const sourceLabel = source ? (SOURCE_LABELS[source] ?? source) : null;

  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {enabled ? (
            <Ban className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          ) : (
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold">Contact preferences</h2>
            <p className="text-sm text-muted-foreground">
              {enabled
                ? 'Henry will not send any automated messages to this contact. Your manual sends still go through.'
                : 'Henry can send automated follow-ups, sequences, and reminders to this contact.'}
            </p>
            {enabled && setAtFmt ? (
              <p className="text-xs text-muted-foreground">
                Turned off {setAtFmt}
                {sourceLabel ? ` — ${sourceLabel}` : ''}.
              </p>
            ) : null}
          </div>
        </div>
        <Button
          type="button"
          variant={enabled ? 'outline' : 'destructive'}
          size="sm"
          disabled={pending}
          onClick={onToggle}
        >
          {pending ? 'Saving…' : enabled ? 'Turn back on' : 'Turn off auto-messages'}
        </Button>
      </div>
    </section>
  );
}
