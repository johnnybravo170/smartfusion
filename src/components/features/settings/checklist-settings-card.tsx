'use client';

import { ListChecks } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { setChecklistHideHoursAction } from '@/server/actions/project-checklist';

type Choice = { label: string; value: 24 | 48 | 168 | null };

const CHOICES: Choice[] = [
  { label: '24 hours', value: 24 },
  { label: '48 hours', value: 48 },
  { label: '7 days', value: 168 },
  { label: 'Never', value: null },
];

export function ChecklistSettingsCard({ currentHours }: { currentHours: number | null }) {
  const [selected, setSelected] = useState<24 | 48 | 168 | null>(
    currentHours === null ? null : currentHours === 24 ? 24 : currentHours === 168 ? 168 : 48,
  );
  const [pending, startTransition] = useTransition();

  function handleClick(value: 24 | 48 | 168 | null) {
    if (value === selected) return;
    const previous = selected;
    setSelected(value);
    startTransition(async () => {
      const res = await setChecklistHideHoursAction({ hours: value });
      if (!res.ok) {
        setSelected(previous);
        toast.error(res.error);
      } else {
        toast.success('Saved.');
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ListChecks className="size-5" />
          <div>
            <CardTitle>Team checklists</CardTitle>
            <CardDescription>
              Hide checked-off items after this long so the list stays focused.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {CHOICES.map((c) => (
            <button
              key={c.label}
              type="button"
              disabled={pending}
              onClick={() => handleClick(c.value)}
              className={cn(
                'rounded-md border px-3 py-1.5 text-sm transition',
                c.value === selected
                  ? 'border-foreground bg-foreground text-background'
                  : 'hover:bg-muted',
                pending && 'opacity-60',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
