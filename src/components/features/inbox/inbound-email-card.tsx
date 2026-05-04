'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/pricing/calculator';
import {
  reclassifyInboundEmailAction,
  rejectInboundEmailAction,
} from '@/server/actions/inbound-email';

export type InboundEmailRow = {
  id: string;
  from_address: string;
  from_name: string | null;
  subject: string | null;
  received_at: string;
  classification: string;
  confidence: number | null;
  extracted: Record<string, unknown> | null;
  classifier_notes: string | null;
  project_id: string | null;
  project_match_confidence: number | null;
  status: string;
  error_message: string | null;
  attachment_names: string[];
};

export type ProjectOption = { id: string; name: string };

const STATUS_COLOURS: Record<string, string> = {
  pending: 'bg-muted text-muted-foreground',
  processing: 'bg-blue-100 text-blue-700',
  auto_applied: 'bg-emerald-100 text-emerald-700',
  needs_review: 'bg-amber-100 text-amber-700',
  applied: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-muted text-muted-foreground line-through',
  error: 'bg-destructive/10 text-destructive',
  bounced: 'bg-muted text-muted-foreground line-through',
};

export function InboundEmailCard({
  email,
  projects,
}: {
  email: InboundEmailRow;
  projects: ProjectOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedProject, setSelectedProject] = useState(email.project_id ?? '');

  const canApply = email.classification === 'sub_quote' || email.classification === 'vendor_bill';
  const isTerminal = email.status === 'applied' || email.status === 'auto_applied';
  const needsReview = email.status === 'needs_review';

  function handleConfirm() {
    // Real wiring lands in B2 (bills) and B3 (sub-quotes) — these open the
    // existing review dialogs (StagedBillConfirmDialog / SubQuoteForm).
    toast('Confirm dialog wiring lands in the next deploy.');
  }

  function handleReject() {
    startTransition(async () => {
      const res = await rejectInboundEmailAction(email.id);
      if (res.ok) {
        toast.success('Dismissed.');
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function handleReclassify() {
    startTransition(async () => {
      const res = await reclassifyInboundEmailAction(email.id);
      if (res.ok) {
        toast.success('Reclassified.');
        router.refresh();
      } else toast.error(res.error);
    });
  }

  const classifyLabel =
    email.classification === 'sub_quote'
      ? 'Vendor Quote'
      : email.classification === 'vendor_bill'
        ? 'Vendor Bill'
        : email.classification === 'other'
          ? 'Other'
          : 'Unclassified';

  const extracted = email.extracted;
  const extractedTotal =
    extracted && typeof extracted === 'object'
      ? ('total_cents' in extracted
          ? Number((extracted as { total_cents: number }).total_cents)
          : null) ||
        ('amount_cents' in extracted
          ? Number((extracted as { amount_cents: number }).amount_cents)
          : null)
      : null;
  const vendor =
    extracted && typeof extracted === 'object' && 'vendor' in extracted
      ? String((extracted as { vendor: string }).vendor)
      : null;

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOURS[email.status] ?? 'bg-muted'}`}
            >
              {email.status.replace('_', ' ')}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{classifyLabel}</span>
            {email.confidence !== null && (
              <span className="text-xs text-muted-foreground">
                classifier {(Number(email.confidence) * 100).toFixed(0)}%
              </span>
            )}
            {email.project_match_confidence !== null && (
              <span className="text-xs text-muted-foreground">
                match {(Number(email.project_match_confidence) * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <p className="mt-1 font-medium">{email.subject || '(no subject)'}</p>
          <p className="text-xs text-muted-foreground">
            {email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address}
            {' · '}
            {new Date(email.received_at).toLocaleString('en-CA', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </p>
        </div>
        {extractedTotal !== null && (
          <div className="text-right">
            <p className="text-xs text-muted-foreground">{vendor}</p>
            <p className="text-lg font-semibold">{formatCurrency(extractedTotal)}</p>
          </div>
        )}
      </div>

      {/* Classifier notes */}
      {email.classifier_notes && (
        <p className="text-xs text-muted-foreground italic">{email.classifier_notes}</p>
      )}

      {/* Extracted preview */}
      {canApply &&
        extracted &&
        typeof extracted === 'object' &&
        'items' in extracted &&
        Array.isArray((extracted as { items: unknown[] }).items) && (
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="mb-2 text-xs font-semibold">Line items</p>
            <table className="w-full text-xs">
              <tbody>
                {(
                  extracted as {
                    items: {
                      description: string;
                      qty: number;
                      unit: string;
                      unit_cost_cents: number;
                    }[];
                  }
                ).items
                  .slice(0, 10)
                  .map((item) => (
                    <tr
                      key={`${item.description}-${item.qty}-${item.unit_cost_cents}`}
                      className="border-b last:border-0"
                    >
                      <td className="py-1">{item.description}</td>
                      <td className="py-1 text-right text-muted-foreground">
                        {item.qty} {item.unit}
                      </td>
                      <td className="py-1 text-right">
                        {formatCurrency(item.qty * item.unit_cost_cents)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}

      {email.attachment_names.length > 0 && (
        <p className="text-xs text-muted-foreground">📎 {email.attachment_names.join(', ')}</p>
      )}

      {email.error_message && <p className="text-xs text-destructive">{email.error_message}</p>}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <select
          value={selectedProject}
          onChange={(e) => setSelectedProject(e.target.value)}
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
          disabled={pending}
        >
          <option value="">— pick project —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        {needsReview && canApply && (
          <Button size="sm" onClick={handleConfirm} disabled={pending}>
            Review &amp; confirm
          </Button>
        )}

        <Button size="sm" variant="ghost" onClick={handleReclassify} disabled={pending}>
          Re-classify
        </Button>

        {!isTerminal && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={handleReject}
            disabled={pending}
          >
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}
