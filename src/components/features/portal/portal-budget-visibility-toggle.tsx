'use client';

import { Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { updateProjectPortalShowBudgetAction } from '@/server/actions/portal-settings';

type Value = 'inherit' | 'show' | 'hide';

function toValue(v: boolean | null | undefined): Value {
  if (v === true) return 'show';
  if (v === false) return 'hide';
  return 'inherit';
}

function fromValue(v: Value): boolean | null {
  if (v === 'show') return true;
  if (v === 'hide') return false;
  return null;
}

export function PortalBudgetVisibilityToggle({
  projectId,
  initialValue,
  tenantDefault,
}: {
  projectId: string;
  initialValue: boolean | null | undefined;
  tenantDefault: boolean;
}) {
  const [value, setValue] = useState<Value>(toValue(initialValue));
  const [pending, startTransition] = useTransition();

  function handleChange(next: Value) {
    const prev = value;
    setValue(next);
    startTransition(async () => {
      const res = await updateProjectPortalShowBudgetAction({
        projectId,
        value: fromValue(next),
      });
      if (!res.ok) {
        setValue(prev);
        toast.error(res.error);
      } else {
        toast.success('Updated.');
      }
    });
  }

  const inheritLabel = `Use my default (${tenantDefault ? 'show' : 'hide'})`;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="max-w-md">
        <p className="text-sm font-medium">Budget breakdown</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Customer sees per-bucket totals and a "spent so far" progress bar. Override the tenant
          default on this specific job — useful for friend / family-discount projects where you
          don't want to show numbers.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <select
          value={value}
          disabled={pending}
          onChange={(e) => handleChange(e.target.value as Value)}
          className="rounded-md border bg-background px-2 py-1.5 text-xs disabled:opacity-50"
        >
          <option value="inherit">{inheritLabel}</option>
          <option value="show">Show</option>
          <option value="hide">Hide</option>
        </select>
        {pending ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null}
      </div>
    </div>
  );
}
