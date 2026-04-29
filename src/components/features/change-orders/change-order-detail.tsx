'use client';

import { createBrowserClient } from '@supabase/ssr';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ManualApprovalDialog } from '@/components/features/projects/manual-approval-dialog';
import type { ChangeOrderLineRow, ChangeOrderRow } from '@/lib/db/queries/change-orders';
import { formatCurrency } from '@/lib/pricing/calculator';
import type { ChangeOrderStatus } from '@/lib/validators/change-order';
import type { ManualApprovalMethod } from '@/lib/validators/manual-approval';
import { manualApprovalMethodLabels } from '@/lib/validators/manual-approval';
import { sendChangeOrderAction, voidChangeOrderAction } from '@/server/actions/change-orders';
import { ChangeOrderStatusBadge } from './change-order-status-badge';

export function ChangeOrderDetail({
  changeOrder,
  projectId,
  proofSignedUrls = {},
  budgetCategoryNamesById = {},
  diffLines = [],
}: {
  changeOrder: ChangeOrderRow;
  projectId: string;
  proofSignedUrls?: Record<string, string>;
  budgetCategoryNamesById?: Record<string, string>;
  diffLines?: ChangeOrderLineRow[];
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [co, setCo] = useState(changeOrder);
  const [manualDialog, setManualDialog] = useState<{
    open: boolean;
    mode: 'approve' | 'decline';
  }>({ open: false, mode: 'approve' });

  // Live-update when the customer approves or declines remotely.
  useEffect(() => {
    const supabase = createBrowserClient(
      // biome-ignore lint/style/noNonNullAssertion: required env vars
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      // biome-ignore lint/style/noNonNullAssertion: required env vars
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
          {/*
           * Manual override — customer said yes/no off-platform, or operator
           * is backfilling an imported change order. Available in both draft
           * and pending_approval. The dialog warns when triggered from draft
           * (no customer notification will go out).
           */}
          {co.status === 'draft' || co.status === 'pending_approval' ? (
            <>
              <button
                type="button"
                onClick={() => setManualDialog({ open: true, mode: 'approve' })}
                disabled={loading}
                className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                Mark approved
              </button>
              <button
                type="button"
                onClick={() => setManualDialog({ open: true, mode: 'decline' })}
                disabled={loading}
                className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                Mark declined
              </button>
            </>
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

      {co.flow_version === 2 && co.applied_at ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 text-sm">
          <p className="text-xs text-emerald-800">
            <span className="font-semibold">Applied to estimate</span> ·{' '}
            {new Date(co.applied_at).toLocaleDateString('en-CA', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
            {co.apply_warnings && co.apply_warnings.length > 0
              ? ` · ${co.apply_warnings.length} warning${co.apply_warnings.length === 1 ? '' : 's'}`
              : ''}
          </p>
          {co.apply_warnings && co.apply_warnings.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-800">
              {co.apply_warnings.map((w, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: warnings array order is stable for this CO
                <li key={i}>{w.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {co.flow_version === 2 && co.category_notes && co.category_notes.length > 0 ? (
        <div className="rounded-lg border p-4">
          <p className="text-xs text-muted-foreground mb-3">Notes by Category</p>
          <ul className="space-y-2 text-sm">
            {co.category_notes.map((n) => (
              <li key={n.budget_category_id}>
                <span className="font-medium">
                  {budgetCategoryNamesById[n.budget_category_id] ?? n.budget_category_id}
                </span>
                <span className="ml-2 text-muted-foreground italic">{n.note}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {co.flow_version === 2 && diffLines.length > 0 ? (
        <div className="rounded-lg border p-4">
          <p className="text-xs text-muted-foreground mb-3">Line-level Changes</p>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted-foreground">
              <tr className="border-b">
                <th className="py-1.5 text-left font-medium">Action</th>
                <th className="py-1.5 text-left font-medium">Line</th>
                <th className="py-1.5 text-left font-medium">Category</th>
                <th className="py-1.5 text-right font-medium">Before</th>
                <th className="py-1.5 text-right font-medium">After</th>
                <th className="py-1.5 text-right font-medium">Delta</th>
              </tr>
            </thead>
            <tbody>
              {diffLines.map((d) => {
                const before = d.before_snapshot as {
                  label?: string;
                  qty?: number;
                  line_price_cents?: number;
                  // 'modify_envelope' rows store the prior bucket envelope here
                  estimate_cents?: number;
                  kind?: string;
                } | null;
                const isEnvelope = d.action === 'modify_envelope';
                const beforePrice = isEnvelope
                  ? (before?.estimate_cents ?? 0)
                  : (before?.line_price_cents ?? 0);
                const afterPrice = d.action === 'remove' ? 0 : (d.line_price_cents ?? 0);
                const delta = afterPrice - beforePrice;
                const label = isEnvelope
                  ? `Envelope: ${d.label ?? '—'}`
                  : (d.label ?? before?.label ?? '—');
                return (
                  <tr key={d.id} className="border-b last:border-0">
                    <td className="py-1.5 align-top">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          d.action === 'add'
                            ? 'bg-emerald-100 text-emerald-800'
                            : d.action === 'remove'
                              ? 'bg-red-100 text-red-800'
                              : d.action === 'modify_envelope'
                                ? 'bg-blue-100 text-blue-800'
                                : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {d.action === 'modify_envelope' ? 'envelope' : d.action}
                      </span>
                    </td>
                    <td className="py-1.5 align-top">
                      <div>{label}</div>
                      {d.notes ? (
                        <div className="mt-0.5 text-xs italic text-muted-foreground">{d.notes}</div>
                      ) : null}
                    </td>
                    <td className="py-1.5 align-top text-xs text-muted-foreground">
                      {d.budget_category_id
                        ? (budgetCategoryNamesById[d.budget_category_id] ?? '—')
                        : '—'}
                    </td>
                    <td className="py-1.5 text-right align-top tabular-nums text-muted-foreground">
                      {d.action === 'add' ? '—' : formatCurrency(beforePrice)}
                    </td>
                    <td className="py-1.5 text-right align-top tabular-nums">
                      {d.action === 'remove' ? '—' : formatCurrency(afterPrice)}
                    </td>
                    <td
                      className={`py-1.5 text-right align-top font-medium tabular-nums ${delta < 0 ? 'text-emerald-700' : ''}`}
                    >
                      {delta >= 0 ? '+' : ''}
                      {formatCurrency(delta)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : co.cost_breakdown && co.cost_breakdown.length > 0 ? (
        <div className="rounded-lg border p-4">
          <p className="text-xs text-muted-foreground mb-3">Cost Impact by Category</p>
          <table className="w-full text-sm">
            <tbody>
              {co.cost_breakdown.map((row) => {
                const sign = row.amount_cents >= 0 ? '+' : '';
                const note = co.category_notes?.find(
                  (n) => n.budget_category_id === row.budget_category_id,
                )?.note;
                return (
                  <tr key={row.budget_category_id} className="border-b last:border-0 align-top">
                    <td className="py-1.5">
                      <div>
                        {budgetCategoryNamesById[row.budget_category_id] ?? row.budget_category_id}
                      </div>
                      {note ? (
                        <div className="mt-0.5 text-xs italic text-muted-foreground">{note}</div>
                      ) : null}
                    </td>
                    <td
                      className={`py-1.5 text-right tabular-nums ${row.amount_cents < 0 ? 'text-emerald-700' : ''}`}
                    >
                      {sign}
                      {formatCurrency(row.amount_cents)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

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

      {co.approval_method && co.approval_method !== 'digital' ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-4 dark:border-amber-800 dark:bg-amber-950/20">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-200">Manual override</p>
          <p className="mt-1 text-sm">
            Recorded via{' '}
            <span className="font-medium">
              {manualApprovalMethodLabels[co.approval_method as ManualApprovalMethod] ??
                co.approval_method}
            </span>
            .
          </p>
          {co.approval_notes ? (
            <p className="mt-2 text-sm whitespace-pre-wrap">{co.approval_notes}</p>
          ) : null}
          {co.approval_proof_paths && co.approval_proof_paths.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs text-muted-foreground mb-1">Proof</p>
              <ul className="flex flex-wrap gap-2">
                {co.approval_proof_paths.map((p) => {
                  const url = proofSignedUrls[p];
                  const name = p.split('/').pop() ?? p;
                  return (
                    <li key={p}>
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted"
                        >
                          {name}
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground">
                          {name}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <ManualApprovalDialog
        open={manualDialog.open}
        onOpenChange={(o) => setManualDialog((d) => ({ ...d, open: o }))}
        resourceType="change_order"
        resourceId={co.id}
        mode={manualDialog.mode}
        bypassedSend={co.status === 'draft'}
        onSuccess={() => {
          toast.success(
            manualDialog.mode === 'approve'
              ? 'Change order marked approved'
              : 'Change order marked declined',
          );
          router.refresh();
        }}
      />
    </div>
  );
}
