'use client';

import { createBrowserClient } from '@supabase/ssr';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ChangeOrderRow } from '@/lib/db/queries/change-orders';
import { formatCurrency } from '@/lib/pricing/calculator';
import type { ChangeOrderStatus } from '@/lib/validators/change-order';
import { sendChangeOrderAction, voidChangeOrderAction } from '@/server/actions/change-orders';
import { ChangeOrderStatusBadge } from './change-order-status-badge';

export function ChangeOrderDetail({
  changeOrder,
  projectId,
}: {
  changeOrder: ChangeOrderRow;
  projectId: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [co, setCo] = useState(changeOrder);

  // Live-update when the customer approves or declines remotely.
  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    const channel = supabase
      .channel(`change-order-${co.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'change_orders',
          filter: `id=eq.${co.id}`,
        },
        (payload) => {
          const updated = payload.new as Partial<ChangeOrderRow>;
          setCo((prev) => ({ ...prev, ...updated }));
          if (updated.status === 'approved') toast.success('Change order approved by customer.');
          if (updated.status === 'declined') toast.error('Change order declined by customer.');
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [co.id]);

  async function handleSend() {
    setLoading(true);
    setError(null);
    const result = await sendChangeOrderAction(co.id);
    if (!result.ok) {
      setError(result.error);
      setLoading(false);
      return;
    }
    router.refresh();
    setLoading(false);
  }

  async function handleVoid() {
    if (!confirm('Void this change order? This cannot be undone.')) return;
    setLoading(true);
    setError(null);
    const result = await voidChangeOrderAction(co.id);
    if (!result.ok) {
      setError(result.error);
      setLoading(false);
      return;
    }
    router.push(`/projects/${projectId}?tab=change-orders`);
  }

  const costFormatted =
    co.cost_impact_cents >= 0
      ? `+${formatCurrency(co.cost_impact_cents)}`
      : formatCurrency(co.cost_impact_cents);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {error ? <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{co.title}</h2>
          <div className="mt-1">
            <ChangeOrderStatusBadge status={co.status as ChangeOrderStatus} />
          </div>
        </div>
        <div className="flex gap-2">
          {co.status === 'draft' ? (
            <button
              type="button"
              onClick={handleSend}
              disabled={loading}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Send for Approval
            </button>
          ) : null}
          {co.status === 'draft' ? (
            <button
              type="button"
              onClick={async () => {
                if (!confirm('Delete this change order? This cannot be undone.')) return;
                setLoading(true);
                const { deleteChangeOrderAction } = await import('@/server/actions/change-orders');
                const result = await deleteChangeOrderAction(co.id);
                setLoading(false);
                if (!result.ok) {
                  toast.error(result.error ?? 'Failed');
                  return;
                }
                toast.success('Change order deleted.');
                router.push(`/projects/${projectId}?tab=change-orders`);
              }}
              disabled={loading}
              className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Delete
            </button>
          ) : null}
          {co.status === 'pending_approval' ? (
            <button
              type="button"
              onClick={handleVoid}
              disabled={loading}
              className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        <div>
          <p className="text-xs text-muted-foreground">Description</p>
          <p className="text-sm mt-1 whitespace-pre-wrap">{co.description}</p>
        </div>
        {co.reason ? (
          <div>
            <p className="text-xs text-muted-foreground">Reason</p>
            <p className="text-sm mt-1">{co.reason}</p>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border p-4">
          <p className="text-xs text-muted-foreground">Cost Impact</p>
          <p className="text-lg font-semibold">{costFormatted}</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-xs text-muted-foreground">Timeline Impact</p>
          <p className="text-lg font-semibold">
            {co.timeline_impact_days === 0
              ? 'None'
              : `${co.timeline_impact_days > 0 ? '+' : ''}${co.timeline_impact_days} day${Math.abs(co.timeline_impact_days) === 1 ? '' : 's'}`}
          </p>
        </div>
      </div>

      {/* Timeline */}
      <div className="rounded-lg border p-4">
        <p className="text-xs text-muted-foreground mb-3">Timeline</p>
        <div className="space-y-2 text-sm">
          <div className="flex gap-3">
            <span className="font-medium text-muted-foreground w-24">Created</span>
            <span>
              {new Date(co.created_at).toLocaleString('en-CA', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </span>
          </div>
          {co.status !== 'draft' ? (
            <div className="flex gap-3">
              <span className="font-medium text-muted-foreground w-24">Sent</span>
              <span>
                {new Date(co.updated_at).toLocaleString('en-CA', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
            </div>
          ) : null}
          {co.approved_at ? (
            <div className="flex gap-3">
              <span className="font-medium text-emerald-700 w-24">Approved</span>
              <span>
                {new Date(co.approved_at).toLocaleString('en-CA', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}{' '}
                by {co.approved_by_name}
              </span>
            </div>
          ) : null}
          {co.declined_at ? (
            <div className="flex gap-3">
              <span className="font-medium text-red-700 w-24">Declined</span>
              <span>
                {new Date(co.declined_at).toLocaleString('en-CA', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
                {co.declined_reason ? ` — ${co.declined_reason}` : ''}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
