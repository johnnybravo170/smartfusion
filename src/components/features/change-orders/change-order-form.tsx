'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useHenryForm } from '@/hooks/use-henry-form';
import type { CostBucketSummary } from '@/lib/db/queries/projects';
import { createChangeOrderAction, sendChangeOrderAction } from '@/server/actions/change-orders';

export function ChangeOrderForm({
  projectId,
  jobId,
  costBuckets,
}: {
  projectId?: string;
  jobId?: string;
  costBuckets: CostBucketSummary[];
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [costDollars, setCostDollars] = useState('');
  const [timelineDays, setTimelineDays] = useState('0');
  const [selectedBuckets, setSelectedBuckets] = useState<string[]>([]);

  async function handleSubmit(sendImmediately: boolean) {
    setLoading(true);
    setError(null);

    const costCents = Math.round(parseFloat(costDollars || '0') * 100);

    const result = await createChangeOrderAction({
      project_id: projectId,
      job_id: jobId,
      title,
      description,
      reason,
      cost_impact_cents: costCents,
      timeline_impact_days: parseInt(timelineDays || '0', 10),
      affected_buckets: selectedBuckets,
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

  function toggleBucket(bucketId: string) {
    setSelectedBuckets((prev) =>
      prev.includes(bucketId) ? prev.filter((id) => id !== bucketId) : [...prev, bucketId],
    );
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
      {
        name: 'cost_dollars',
        label: 'Cost impact in dollars (negative for credit)',
        type: 'number',
        currentValue: costDollars,
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
        setCostDollars(value);
        return true;
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

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="co-cost">
            Cost Impact ($)
          </label>
          <input
            id="co-cost"
            type="number"
            step="0.01"
            value={costDollars}
            onChange={(e) => setCostDollars(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            placeholder="0.00"
          />
          <p className="mt-1 text-xs text-muted-foreground">Use negative for credits</p>
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
            className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <p className="mt-1 text-xs text-muted-foreground">Use negative to shorten</p>
        </div>
      </div>

      {costBuckets.length > 0 ? (
        <div>
          <span className="mb-2 block text-sm font-medium">Affected Cost Buckets</span>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {costBuckets.map((bucket) => (
              <label
                key={bucket.id}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-muted/30"
              >
                <input
                  type="checkbox"
                  checked={selectedBuckets.includes(bucket.id)}
                  onChange={() => toggleBucket(bucket.id)}
                  className="rounded border-gray-300"
                />
                <span>{bucket.name}</span>
                <span className="text-xs text-muted-foreground">({bucket.section})</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

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
