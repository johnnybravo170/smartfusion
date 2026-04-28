'use client';

import { Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { MemberReminder } from '@/lib/db/queries/reminders';
import type { ReminderKind } from '@/server/actions/reminders';
import { upsertReminderAction } from '@/server/actions/reminders';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const REMINDER_DEFINITIONS: Array<{
  kind: ReminderKind;
  title: string;
  description: string;
  defaultTime: string;
  defaultDays: number[];
}> = [
  {
    kind: 'daily_logging',
    title: 'Daily logging reminder',
    description:
      "Henry texts you at the end of the workday so today's hours and receipts don't fall through the cracks.",
    defaultTime: '17:30',
    defaultDays: [1, 2, 3, 4, 5],
  },
  {
    kind: 'weekly_review',
    title: 'Weekly review',
    description:
      'A Friday-afternoon nudge to skim your open quotes, jobs, and unpaid invoices for the week.',
    defaultTime: '15:00',
    defaultDays: [5],
  },
];

export function RemindersCard({
  reminders,
  notificationPhone,
}: {
  reminders: MemberReminder[];
  notificationPhone: string | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      {!notificationPhone ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          You haven't added a phone number yet. Add one in{' '}
          <a href="/settings/profile" className="underline">
            Settings → Profile
          </a>{' '}
          so Henry knows where to text you.
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Reminders will be sent by SMS to <span className="font-mono">{notificationPhone}</span>.
        </p>
      )}

      {REMINDER_DEFINITIONS.map((def) => {
        const existing = reminders.find((r) => r.kind === def.kind);
        return (
          <ReminderRow
            key={def.kind}
            kind={def.kind}
            title={def.title}
            description={def.description}
            initialEnabled={existing?.enabled ?? false}
            initialTime={existing?.localTime ?? def.defaultTime}
            initialDays={existing?.daysOfWeek ?? def.defaultDays}
          />
        );
      })}
    </div>
  );
}

function ReminderRow({
  kind,
  title,
  description,
  initialEnabled,
  initialTime,
  initialDays,
}: {
  kind: ReminderKind;
  title: string;
  description: string;
  initialEnabled: boolean;
  initialTime: string;
  initialDays: number[];
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [time, setTime] = useState(initialTime);
  const [days, setDays] = useState<number[]>(initialDays);
  const [pending, startTransition] = useTransition();
  const [dirty, setDirty] = useState(false);

  function toggleDay(dow: number) {
    setDays((prev) =>
      prev.includes(dow) ? prev.filter((d) => d !== dow) : [...prev, dow].sort((a, b) => a - b),
    );
    setDirty(true);
  }

  function persist(nextEnabled = enabled) {
    if (days.length === 0) {
      toast.error('Pick at least one day.');
      return;
    }
    startTransition(async () => {
      const res = await upsertReminderAction({
        kind,
        localTime: time,
        daysOfWeek: days,
        enabled: nextEnabled,
      });
      if (res.ok) {
        setDirty(false);
        toast.success(nextEnabled ? 'Reminder saved.' : 'Reminder turned off.');
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Checkbox
              id={`${kind}-enabled`}
              checked={enabled}
              onCheckedChange={(v) => {
                const next = v === true;
                setEnabled(next);
                persist(next);
              }}
              disabled={pending}
              aria-label={`${title} on/off`}
            />
            <Label htmlFor={`${kind}-enabled`} className="text-muted-foreground font-normal">
              {enabled ? 'On' : 'Off'}
            </Label>
          </div>
        </div>
      </CardHeader>
      {enabled ? (
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${kind}-time`} className="text-xs">
                Local time
              </Label>
              <Input
                id={`${kind}-time`}
                type="time"
                value={time}
                onChange={(e) => {
                  setTime(e.target.value);
                  setDirty(true);
                }}
                className="w-32"
                disabled={pending}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Days</Label>
              <div className="flex gap-1">
                {DAY_LABELS.map((label, dow) => {
                  const on = days.includes(dow);
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => toggleDay(dow)}
                      disabled={pending}
                      className={`size-8 rounded-md border text-xs font-medium transition-colors ${
                        on
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input bg-background text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {label[0]}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => persist()} disabled={pending || !dirty}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}
