'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useHenryForm } from '@/hooks/use-henry-form';
import type { BudgetCategorySummary } from '@/lib/db/queries/projects';
import { createChangeOrderAction, sendChangeOrderAction } from '@/server/actions/change-orders';

export function ChangeOrderForm({
  projectId,
  jobId,
  budgetCategories,
  defaultManagementFeeRate,
}: {
  projectId?: string;
  jobId?: string;
  budgetCategories: BudgetCategorySummary[];
  /** Project-level mgmt fee rate (0..0.5). Pre-fills the per-CO override
   *  field. Undefined for jobs (older flow without a project context). */
  defaultManagementFeeRate?: number;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [timelineDays, setTimelineDays] = useState('0');
  // Per-CO management fee. Pre-filled with the project default; operator
  // can scale back as the project grows. Reason is required when the
  // value differs from the default — keeps the audit trail honest.
  const defaultRatePct =
    typeof defaultManagementFeeRate === 'number'
      ? (defaultManagementFeeRate * 100).toFixed(2).replace(/\.?0+$/, '')
      : '';
  const [mgmtFeePct, setMgmtFeePct] = useState(defaultRatePct);
  const [mgmtFeeReason, setMgmtFeeReason] = useState('');
  const mgmtFeeRateNum = parseFloat(mgmtFeePct || '0') / 100;
  const mgmtFeeChanged =
    typeof defaultManagementFeeRate === 'number' &&
    Math.abs(mgmtFeeRateNum - defaultManagementFeeRate) > 0.00001;
  // Per-category dollar allocation. Empty string = blank input; "0" or "" both
  // skipped on submit. Total cost impact is derived from the sum.
  const [allocByBucket, setAllocByBucket] = useState<Record<string, string>>({});
  // Per-category narrative notes — explains WHY the category was affected.
  // Stripped of empty strings before submit.
  const [notesByBucket, setNotesByBucket] = useState<Record<string, string>>({});

  // Cost impact is computed from per-category allocations — no separate field.
  const totalCostCents = Object.values(allocByBucket).reduce((sum, v) => {
    const n = Math.round(parseFloat(v || '0') * 100);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
  const breakdown = Object.entries(allocByBucket)
    .map(([id, v]) => ({
      budget_category_id: id,
      amount_cents: Math.round(parseFloat(v || '0') * 100),
    }))
    .filter((r) => Number.isFinite(r.amount_cents) && r.amount_cents !== 0);

  async function handleSubmit(sendImmediately: boolean) {
    setLoading(true);
    setError(null);

    if (mgmtFeeChanged && mgmtFeeReason.trim().length === 0) {
      setError('Please add a reason for the management fee adjustment so the change is auditable.');
      setLoading(false);
      return;
    }

    const result = await createChangeOrderAction({
      project_id: projectId,
      job_id: jobId,
      title,
      description,
      reason,
      cost_impact_cents: totalCostCents,
      timeline_impact_days: parseInt(timelineDays || '0', 10),
      affected_buckets: breakdown.map((r) => r.budget_category_id),
      cost_breakdown: breakdown,
      category_notes: Object.entries(notesByBucket)
        .map(([id, note]) => ({ budget_category_id: id, note: note.trim() }))
        .filter((n) => n.note.length > 0),
      // Only persist an override when it differs from the project default.
      // Otherwise NULL = inherit, which keeps the breakdown clean on the
      // overview revenue card.
      management_fee_override_rate: mgmtFeeChanged ? mgmtFeeRateNum : null,
      management_fee_override_reason: mgmtFeeChanged ? mgmtFeeReason.trim() : null,
    });

    if (!result.ok) {
      setError(result.error);
      setLoading(false);
      return;
    }

    if (sendImmediately && result.id) {
      const sendResult = await sendChangeOrderAction(result.id);
      if (!sendResult.ok) {
        setError(sendResult.error);
        setLoading(false);
        return;
      }
    }

    const returnPath = projectId ? `/projects/${projectId}?tab=change-orders` : `/jobs/${jobId}`;
    router.push(returnPath);
    router.refresh();
  }

  function setAlloc(bucketId: string, value: string) {
    setAllocByBucket((prev) => {
      const next = { ...prev };
      if (value === '' || value === '0') delete next[bucketId];
      else next[bucketId] = value;
      return next;
    });
  }

  useHenryForm({
    formId: `change-order-create-${projectId ?? jobId ?? 'unknown'}`,
    title: 'Creating a change order',
    fields: [
      { name: 'title', label: 'Title', type: 'text', currentValue: title },
      { name: 'description', label: 'Description', type: 'textarea', currentValue: description },
      {
        name: 'reason',
        label: 'Reason (why this change is happening)',
        type: 'text',
        currentValue: reason,
      },
      // Cost impact is computed from per-category allocations; the agent
      // form-fill helper sees a derived total rather than a single field.
      {
        name: 'cost_dollars',
        label: 'Cost impact in dollars (auto-derived from per-category allocations)',
        type: 'number',
        currentValue: (totalCostCents / 100).toFixed(2),
      },
      {
        name: 'timeline_days',
        label: 'Timeline impact in days (negative to shorten)',
        type: 'number',
        currentValue: timelineDays,
      },
    ],
    setField: (name, value) => {
      if (name === 'title') {
        setTitle(value);
        return true;
      }
      if (name === 'description') {
        setDescription(value);
        return true;
      }
      if (name === 'reason') {
        setReason(value);
        return true;
      }
      if (name === 'cost_dollars') {
        // Derived field — agent fill is a no-op; users adjust per-category
        // amounts directly to change the total.
        return false;
      }
      if (name === 'timeline_days') {
        setTimelineDays(value);
        return true;
      }
      return false;
    },
    // Two submit buttons (draft vs send); operator picks which — don't auto-submit.
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {error ? <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="co-title">
          Title
        </label>
        <input
          id="co-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          placeholder="e.g. Add pot lights to kitchen"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="co-desc">
          Description
        </label>
        <textarea
          id="co-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          placeholder="Describe the change in detail..."
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="co-reason">
          Reason (optional)
        </label>
        <input
          id="co-reason"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          placeholder="e.g. Homeowner requested during walkthrough"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor="co-timeline">
          Timeline Impact (days)
        </label>
        <input
          id="co-timeline"
          type="number"
          value={timelineDays}
          onChange={(e) => setTimelineDays(e.target.value)}
          className="w-full max-w-xs rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <p className="mt-1 text-xs text-muted-foreground">Use negative to shorten</p>
      </div>

      {typeof defaultManagementFeeRate === 'number' ? (
        <div className="rounded-md border bg-muted/20 p-3">
          <div className="flex items-baseline justify-between gap-3">
            <label className="block text-sm font-medium" htmlFor="co-mgmt-fee">
              Management fee
            </label>
            <p className="text-xs text-muted-foreground">
              Project default: {(defaultManagementFeeRate * 100).toFixed(2).replace(/\.?0+$/, '')}%
            </p>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              id="co-mgmt-fee"
              type="number"
              step="0.01"
              min="0"
              max="50"
              value={mgmtFeePct}
              onChange={(e) => setMgmtFeePct(e.target.value)}
              className="h-8 w-24 rounded-md border px-2 text-right text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <span className="text-sm">%</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              = ${((Math.max(totalCostCents, 0) * mgmtFeeRateNum) / 100).toFixed(2)} on this CO
            </span>
          </div>
          {mgmtFeeChanged ? (
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium" htmlFor="co-mgmt-fee-reason">
                Reason for adjustment
                <span className="ml-1 text-amber-700">(required)</span>
              </label>
              <input
                id="co-mgmt-fee-reason"
                type="text"
                value={mgmtFeeReason}
                onChange={(e) => setMgmtFeeReason(e.target.value)}
                placeholder="e.g. Scaling back as project size grew past budget"
                className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Recorded on the project overview audit trail. Visible to admins, not the customer.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {budgetCategories.length > 0 ? (
        <div>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <span className="block text-sm font-medium">Cost Impact by Category</span>
            <span className="text-xs text-muted-foreground">
              Type amounts only on affected categories. Use negative for credits.
            </span>
          </div>
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="px-3 py-2 text-left font-medium">Category</th>
                  <th className="w-28 px-3 py-2 text-right font-medium">Section</th>
                  <th className="w-40 px-3 py-2 text-right font-medium">Amount ($)</th>
                </tr>
              </thead>
              <tbody>
                {budgetCategories.map((bucket) => {
                  const hasAmount = !!allocByBucket[bucket.id] && allocByBucket[bucket.id] !== '0';
                  return (
                    <tr key={bucket.id} className="border-b last:border-0 align-top">
                      <td className="px-3 py-2">
                        <div>{bucket.name}</div>
                        {hasAmount ? (
                          <input
                            type="text"
                            value={notesByBucket[bucket.id] ?? ''}
                            onChange={(e) =>
                              setNotesByBucket((prev) => ({
                                ...prev,
                                [bucket.id]: e.target.value,
                              }))
                            }
                            placeholder="Why? (optional — explains the change to the customer)"
                            className="mt-1 h-7 w-full rounded-md border px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
                          />
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                        {bucket.section}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          step="0.01"
                          value={allocByBucket[bucket.id] ?? ''}
                          onChange={(e) => setAlloc(bucket.id, e.target.value)}
                          placeholder="0.00"
                          className="h-8 w-32 rounded-md border px-2 text-right text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t bg-muted/40 font-semibold">
                  <td className="px-3 py-2" colSpan={2}>
                    Total Cost Impact
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${totalCostCents < 0 ? 'text-emerald-700' : ''}`}
                  >
                    ${(totalCostCents / 100).toFixed(2)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {breakdown.length === 0 ? (
            <p className="mt-2 text-xs text-amber-700">
              Enter at least one category amount before saving.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No budget categories on this project — set up categories on the Budget tab first.
        </p>
      )}

      <div className="flex gap-3 pt-4 border-t">
        <button
          type="button"
          onClick={() => handleSubmit(false)}
          disabled={loading}
          className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted/50 disabled:opacity-50"
        >
          {loading ? 'Saving...' : 'Save as Draft'}
        </button>
        <button
          type="button"
          onClick={() => handleSubmit(true)}
          disabled={loading}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? 'Sending...' : 'Save & Send for Approval'}
        </button>
      </div>
    </div>
  );
}
