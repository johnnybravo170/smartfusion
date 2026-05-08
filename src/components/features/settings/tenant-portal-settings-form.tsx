'use client';

import { Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  updateTenantNotifyOnScheduleChangeAction,
  updateTenantPortalShowBudgetAction,
} from '@/server/actions/portal-settings';

function ToggleRow({
  label,
  description,
  value,
  pending,
  onToggle,
}: {
  label: string;
  description: string;
  value: boolean;
  pending: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="max-w-md">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={onToggle}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          value ? 'bg-primary' : 'bg-gray-200'
        } disabled:opacity-50`}
        role="switch"
        aria-checked={value}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            value ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
        {pending ? (
          <Loader2 className="absolute -right-6 size-3 animate-spin text-muted-foreground" />
        ) : null}
      </button>
    </div>
  );
}

export function TenantPortalSettingsForm({
  initialShowBudget,
  initialNotifyOnScheduleChange,
}: {
  initialShowBudget: boolean;
  initialNotifyOnScheduleChange: boolean;
}) {
  const [showBudget, setShowBudget] = useState(initialShowBudget);
  const [notifyOnScheduleChange, setNotifyOnScheduleChange] = useState(
    initialNotifyOnScheduleChange,
  );
  const [budgetPending, startBudgetTransition] = useTransition();
  const [notifyPending, startNotifyTransition] = useTransition();

  function handleBudgetToggle() {
    const next = !showBudget;
    setShowBudget(next);
    startBudgetTransition(async () => {
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

  function handleNotifyToggle() {
    const next = !notifyOnScheduleChange;
    setNotifyOnScheduleChange(next);
    startNotifyTransition(async () => {
      const res = await updateTenantNotifyOnScheduleChangeAction(next);
      if (!res.ok) {
        setNotifyOnScheduleChange(!next);
        toast.error(res.error);
      } else {
        toast.success(
          next
            ? 'Customers will get an email when you update their schedule.'
            : 'Schedule notifications turned off.',
        );
      }
    });
  }

  return (
    <div className="space-y-6">
      <ToggleRow
        label="Show budget breakdown to customers"
        description="When on, customers see per-bucket totals and a 'spent so far' progress bar on their portal. They never see individual expenses or vendor names. Per-project override available on each project's Portal tab."
        value={showBudget}
        pending={budgetPending}
        onToggle={handleBudgetToggle}
      />
      <ToggleRow
        label="Notify customer when schedule changes"
        description="When on, dragging or editing a customer-visible Gantt task fires an email + SMS after a 5-minute debounce window. Bulk edits collapse to one rollup. Off by default — turn this on once you've sharpened a draft enough to want the customer following along."
        value={notifyOnScheduleChange}
        pending={notifyPending}
        onToggle={handleNotifyToggle}
      />
    </div>
  );
}
