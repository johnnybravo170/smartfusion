'use client';

import { Sparkles } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { setEstimatingDetailLevelAction } from '@/server/actions/estimating-prefs';

type Level = 'quick' | 'standard' | 'detailed';

const CHOICES: Array<{ value: Level; label: string; hint: string }> = [
  { value: 'quick', label: 'Quick', hint: '~5 lines · top-level scope only' },
  { value: 'standard', label: 'Standard', hint: '~15 lines · typical breakdown' },
  { value: 'detailed', label: 'Detailed', hint: '~40 lines · every cost broken out' },
];

export function EstimatingDetailLevelCard({ currentLevel }: { currentLevel: Level }) {
  const [selected, setSelected] = useState<Level>(currentLevel);
  const [pending, startTransition] = useTransition();

  function pick(next: Level) {
    if (next === selected) return;
    const previous = selected;
    setSelected(next);
    startTransition(async () => {
      const res = await setEstimatingDetailLevelAction({ detail_level: next });
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
          <Sparkles className="size-5" />
          <div>
            <CardTitle>AI estimating detail</CardTitle>
            <CardDescription>
              How much detail Henry returns when you describe a job. You can override per-quote on
              the generator dialog.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              disabled={pending}
              onClick={() => pick(c.value)}
              className={cn(
                'rounded-md border px-3 py-2 text-left text-xs transition',
                c.value === selected
                  ? 'border-foreground bg-foreground text-background'
                  : 'hover:bg-muted',
                pending && 'opacity-60',
              )}
            >
              <div className="font-medium">{c.label}</div>
              <div
                className={
                  c.value === selected
                    ? 'text-[10px] opacity-80'
                    : 'text-[10px] text-muted-foreground'
                }
              >
                {c.hint}
              </div>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
