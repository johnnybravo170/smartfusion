'use client';

import { Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { updateTenantPortalShowBudgetAction } from '@/server/actions/portal-settings';

export function TenantPortalSettingsForm({ initialShowBudget }: { initialShowBudget: boolean }) {
  const [showBudget, setShowBudget] = useState(initialShowBudget);
  const [pending, startTransition] = useTransition();

  function handleToggle(next: boolean) {
    setShowBudget(next);
    startTransition(async () => {
      const res = await updateTenantPortalShowBudgetAction(next);
      if (!res.ok) {
        setShowBudget(!next);
        toast.error(res.error);
      } else {
        toast.success(
          next ? 'Customers will see the budget breakdown.' : 'Budget breakdown hidden.',
        );
      }
    });
  }

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="max-w-md">
        <p className="text-sm font-medium">Show budget breakdown to customers</p>
        <p className="mt-1 text-xs text-muted-foreground">
          When on, customers see per-bucket totals and a "spent so far" progress bar on their
          portal. They never see individual expenses or vendor names. Per-project override available
          on each project's Portal tab.
        </p>
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={() => handleToggle(!showBudget)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          showBudget ? 'bg-primary' : 'bg-gray-200'
        } disabled:opacity-50`}
        role="switch"
        aria-checked={showBudget}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            showBudget ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
        {pending ? (
          <Loader2 className="absolute -right-6 size-3 animate-spin text-muted-foreground" />
        ) : null}
      </button>
    </div>
  );
}
