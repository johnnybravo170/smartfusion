'use client';

import { Eye } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { CustomerViewMode } from '@/lib/validators/project-customer-view';
import { updateCustomerViewModeAction } from '@/server/actions/project-customer-view';

type Props = {
  projectId: string;
  currentMode: CustomerViewMode;
};

const CHOICES: Array<{ value: CustomerViewMode; label: string; hint: string }> = [
  {
    value: 'lump_sum',
    label: 'Lump sum',
    hint: 'One total + your scope summary. No breakdown.',
  },
  {
    value: 'sections',
    label: 'Sections',
    hint: 'Customer-facing groupings (e.g. "Bathroom", "Kitchen") with subtotals.',
  },
  {
    value: 'categories',
    label: 'Categories',
    hint: 'Every internal category visible. Variance shown.',
  },
  {
    value: 'detailed',
    label: 'Detailed',
    hint: 'Every cost line broken out. Variance shown.',
  },
];

export function CustomerViewModeCard({ projectId, currentMode }: Props) {
  const [selected, setSelected] = useState<CustomerViewMode>(currentMode);
  const [pending, startTransition] = useTransition();

  function pick(next: CustomerViewMode) {
    if (next === selected) return;
    const previous = selected;
    setSelected(next);
    startTransition(async () => {
      const res = await updateCustomerViewModeAction({ projectId, mode: next });
      if (!res.ok) {
        setSelected(previous);
        toast.error(res.error);
      } else {
        toast.success('Customer view updated.');
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Eye className="size-5" />
          <div>
            <CardTitle>Customer view</CardTitle>
            <CardDescription>
              How much of the budget the customer sees in the portal. Variance is shown only in
              Categories and Detailed modes.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2">
          {CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              disabled={pending}
              onClick={() => pick(c.value)}
              className={cn(
                'min-w-0 rounded-md border px-3 py-2 text-left text-xs transition',
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
                    ? 'mt-0.5 text-[10px] opacity-80'
                    : 'mt-0.5 text-[10px] text-muted-foreground'
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
