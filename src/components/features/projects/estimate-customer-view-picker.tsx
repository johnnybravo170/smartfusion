'use client';

/**
 * Customer-view mode picker on the operator's estimate preview page.
 *
 * Same toggle UX as the invoice preview's mode picker, but persists
 * immediately to `projects.customer_view_mode` (no "Apply" button) —
 * the estimate render reads its mode from the project on every load,
 * so saving the mode is the apply.
 *
 * The customer sees whatever mode is saved when they open the public
 * `/estimate/[code]` link. Operator can preview each mode here before
 * committing.
 */

import { Eye } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { CustomerViewMode } from '@/lib/validators/project-customer-view';
import { updateCustomerViewModeAction } from '@/server/actions/project-customer-view';

const MODE_CHOICES: Array<{ value: CustomerViewMode; label: string; hint: string }> = [
  { value: 'lump_sum', label: 'Lump sum', hint: 'One total + scope summary.' },
  { value: 'sections', label: 'Sections', hint: 'Customer-facing groupings.' },
  { value: 'categories', label: 'Categories', hint: 'One line per category.' },
  { value: 'detailed', label: 'Detailed', hint: 'Every cost line.' },
];

export function EstimateCustomerViewPicker({
  projectId,
  initialMode,
}: {
  projectId: string;
  initialMode: CustomerViewMode;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<CustomerViewMode>(initialMode);
  const [pending, startTransition] = useTransition();

  function pick(next: CustomerViewMode) {
    if (next === mode) return;
    const previous = mode;
    setMode(next);
    startTransition(async () => {
      const res = await updateCustomerViewModeAction({ projectId, mode: next });
      if (!res.ok) {
        setMode(previous);
        toast.error(res.error);
        return;
      }
      // Re-render the page so EstimateRender below picks up the new mode.
      router.refresh();
    });
  }

  return (
    <Card className="mb-4">
      <CardHeader>
        <div className="flex items-start gap-2">
          <Eye className="mt-0.5 size-5" />
          <div className="flex-1">
            <CardTitle>Customer view</CardTitle>
            <CardDescription>
              How much of the breakdown the customer sees on this estimate. Saves immediately to the
              project — the preview below and the customer&apos;s shared link both update.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2">
          {MODE_CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              disabled={pending}
              onClick={() => pick(c.value)}
              className={cn(
                'min-w-0 rounded-md border px-3 py-2 text-left text-xs transition',
                c.value === mode
                  ? 'border-foreground bg-foreground text-background'
                  : 'hover:bg-muted',
                pending && 'opacity-60',
              )}
            >
              <div className="font-medium">{c.label}</div>
              <div
                className={cn(
                  'mt-0.5 text-[10px]',
                  c.value === mode ? 'opacity-80' : 'text-muted-foreground',
                )}
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
