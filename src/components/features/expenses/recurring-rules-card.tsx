'use client';

/**
 * Active recurring rules at a glance — shown at the bottom of /expenses.
 * Cancel is one click; no edit flow yet (cancel + recreate is simpler
 * than a rule-editor dialog for the monthly-only MVP).
 */

import { RefreshCw, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';
import type { RecurringRuleRow } from '@/lib/db/queries/expense-recurring';
import { formatCurrency } from '@/lib/pricing/calculator';
import { cancelRecurringRuleAction } from '@/server/actions/expense-recurring';

export function RecurringRulesCard({ rules }: { rules: RecurringRuleRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (rules.length === 0) return null;

  function cancel(id: string, label: string) {
    if (!confirm(`Stop recurring "${label}"? Past expenses stay; no new ones will be created.`))
      return;
    startTransition(async () => {
      const res = await cancelRecurringRuleAction({ id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Recurring rule cancelled');
      router.refresh();
    });
  }

  return (
    <section className="rounded-md border bg-muted/10">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2 text-sm">
        <RefreshCw className="size-3.5 text-muted-foreground" />
        <h2 className="font-medium">Recurring rules ({rules.length})</h2>
        <span className="text-xs text-muted-foreground">
          Auto-logged monthly on the day you picked.
        </span>
      </div>
      <ul>
        {rules.map((r) => {
          const catLabel = r.parent_category_name
            ? `${r.parent_category_name} › ${r.category_name}`
            : (r.category_name ?? 'Uncategorized');
          const label = r.vendor ?? r.description ?? catLabel;
          return (
            <li
              key={r.id}
              className="flex items-center justify-between gap-4 border-b px-4 py-3 text-sm last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">
                  {catLabel} · day {r.day_of_month} · next{' '}
                  {new Date(r.next_run_at).toLocaleDateString('en-CA', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="tabular-nums font-medium">{formatCurrency(r.amount_cents)}</span>
                <button
                  type="button"
                  onClick={() => cancel(r.id, label)}
                  disabled={pending}
                  aria-label={`Cancel ${label}`}
                  className="text-muted-foreground transition-colors hover:text-red-600 disabled:opacity-50"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
