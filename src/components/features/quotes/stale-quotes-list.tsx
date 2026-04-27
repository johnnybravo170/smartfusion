'use client';

import { Ban, Lock, Mail, Send } from 'lucide-react';
import Link from 'next/link';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { enrollStaleQuoteFollowupAction } from '@/server/actions/automations';

export type StaleQuoteRow = {
  projectId: string;
  projectName: string;
  customerId: string | null;
  customerName: string;
  customerEmail: string | null;
  customerHasKillSwitch: boolean;
  totalFormatted: string;
  sentAt: string;
  daysStale: number;
};

export function StaleQuotesList({
  rows,
  featureUnlocked,
}: {
  rows: StaleQuoteRow[];
  featureUnlocked: boolean;
}) {
  const [pending, startTransition] = useTransition();

  if (!featureUnlocked) {
    return (
      <section className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <div className="flex items-start gap-3">
          <Lock className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div className="flex flex-col gap-2">
            <p className="font-medium">Quote follow-up is a Growth-plan feature.</p>
            <p>Upgrade to enroll your stale quotes in automated follow-up sequences.</p>
            <Button asChild variant="default" size="sm" className="mt-1 w-fit">
              <Link href="/settings/billing">Upgrade</Link>
            </Button>
          </div>
        </div>
      </section>
    );
  }

  if (rows.length === 0) {
    return (
      <section className="rounded-xl border bg-card p-8 text-center">
        <Mail className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <p className="mt-3 text-sm font-medium">No stale quotes right now.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Anything you send from now on will get auto-followed-up if you've turned that on in{' '}
          <Link href="/settings/automations" className="underline">
            Settings → Automations
          </Link>
          .
        </p>
      </section>
    );
  }

  const onEnroll = (projectId: string, customerName: string) => {
    startTransition(async () => {
      const res = await enrollStaleQuoteFollowupAction({ projectId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Enrolled — Henry will follow up with ${customerName}.`);
    });
  };

  const onEnrollAll = () => {
    startTransition(async () => {
      const eligible = rows.filter((r) => !r.customerHasKillSwitch && r.customerEmail);
      let ok = 0;
      let failed = 0;
      for (const row of eligible) {
        const res = await enrollStaleQuoteFollowupAction({ projectId: row.projectId });
        if (res.ok) ok++;
        else failed++;
      }
      if (ok > 0) toast.success(`Enrolled ${ok} quote${ok === 1 ? '' : 's'} for follow-up.`);
      if (failed > 0) toast.error(`${failed} failed — check the page and try again.`);
    });
  };

  const eligibleCount = rows.filter((r) => !r.customerHasKillSwitch && r.customerEmail).length;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {rows.length} stale {rows.length === 1 ? 'quote' : 'quotes'}
          {eligibleCount !== rows.length ? ` (${eligibleCount} eligible)` : ''}
        </p>
        {eligibleCount > 0 ? (
          <Button onClick={onEnrollAll} disabled={pending} size="sm">
            <Send className="size-3.5" />
            Enroll all eligible
          </Button>
        ) : null}
      </div>

      <ul className="flex flex-col divide-y rounded-xl border bg-card">
        {rows.map((r) => (
          <li key={r.projectId} className="flex items-start justify-between gap-4 p-4">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Link href={`/projects/${r.projectId}`} className="hover:underline">
                  {r.projectName}
                </Link>
                <span className="text-muted-foreground font-normal">·</span>
                <span className="text-muted-foreground font-normal">{r.customerName}</span>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{r.totalFormatted}</span>
                <span>·</span>
                <span>{r.daysStale} days stale</span>
                {r.customerHasKillSwitch ? (
                  <>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1 text-amber-700">
                      <Ban className="size-3" aria-hidden />
                      Customer opted out
                    </span>
                  </>
                ) : null}
                {!r.customerEmail && !r.customerHasKillSwitch ? (
                  <>
                    <span>·</span>
                    <span className="text-amber-700">No email on file</span>
                  </>
                ) : null}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={pending || r.customerHasKillSwitch || !r.customerEmail}
              onClick={() => onEnroll(r.projectId, r.customerName)}
            >
              <Send className="size-3.5" />
              Enroll
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
