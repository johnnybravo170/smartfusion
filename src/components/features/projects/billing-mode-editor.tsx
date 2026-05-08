'use client';

/**
 * Project billing-mode toggle (cost-plus vs fixed-price). Sibling to
 * `management-fee-editor.tsx` on the Overview facts grid.
 *
 * Why a small custom toggle instead of a generic switch: this surface
 * needs the same look-and-feel as the surrounding facts tiles
 * (xs label, sm font-medium value, click affords edit). A bare shadcn
 * Switch in the tile breaks the visual rhythm.
 */

import { Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { updateProjectIsCostPlusAction } from '@/server/actions/projects';

type Props = {
  projectId: string;
  isCostPlus: boolean;
};

export function BillingModeEditor({ projectId, isCostPlus }: Props) {
  const [value, setValue] = useState(isCostPlus);
  const [isPending, startTransition] = useTransition();

  function flip(next: boolean) {
    if (next === value || isPending) return;
    const previous = value;
    setValue(next); // optimistic
    startTransition(async () => {
      const res = await updateProjectIsCostPlusAction({
        id: projectId,
        isCostPlus: next,
      });
      if (!res.ok) {
        setValue(previous);
        toast.error(res.error);
        return;
      }
      toast.success(`Billing mode set to ${next ? 'cost-plus' : 'fixed-price'}.`);
    });
  }

  return (
    <div className="inline-flex items-center gap-2">
      <fieldset
        className={cn(
          'inline-flex rounded-md border bg-muted/50 p-0.5 text-xs',
          isPending && 'opacity-60',
        )}
        aria-label="Billing mode"
      >
        <button
          type="button"
          onClick={() => flip(true)}
          disabled={isPending}
          aria-pressed={value === true}
          className={cn(
            'rounded px-2 py-1 font-medium transition-colors',
            value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          Cost-plus
        </button>
        <button
          type="button"
          onClick={() => flip(false)}
          disabled={isPending}
          aria-pressed={value === false}
          className={cn(
            'rounded px-2 py-1 font-medium transition-colors',
            !value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          Fixed-price
        </button>
      </fieldset>
      {isPending ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null}
    </div>
  );
}
