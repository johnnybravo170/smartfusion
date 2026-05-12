'use client';

/**
 * Live preview of the customer-facing line items on a draft invoice.
 *
 * The operator picks a view mode (lump_sum / sections / categories /
 * detailed) and a management-fee bake-in toggle; the preview recomputes
 * via the pure helper on every keystroke and renders the resulting
 * line items in real time. Nothing is persisted until Apply.
 *
 * "Apply" calls the server action which re-fetches the project data
 * server-side and runs the same helper — we never trust client-sent
 * line_items into the database.
 *
 * Visual structure mirrors `portal-budget-detail.tsx`: one card per row,
 * with the title bold on the left, the formatted total tabular-aligned on
 * the right, and (when present) the row's markdown body rendered below
 * with `RichTextDisplay`. The shape is intentionally familiar — operators
 * who've seen the customer portal recognize the format.
 *
 * Cost-plus projects: sections + categories are disabled with a tooltip
 * (those modes require estimate sections, which cost-plus projects
 * don't have a meaningful concept of in v1).
 */

import { Eye } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RichTextDisplay } from '@/components/ui/rich-text-display';
import {
  availableModesFor,
  buildCustomerViewLineItems,
  type CustomerViewCategory,
  type CustomerViewCostLine,
  type CustomerViewCostPlusBreakdown,
  type CustomerViewPreviewRow,
  type CustomerViewSection,
} from '@/lib/invoices/customer-view-line-items';
import { formatCurrency } from '@/lib/pricing/calculator';
import { cn } from '@/lib/utils';
import type { CustomerViewMode } from '@/lib/validators/project-customer-view';
import { applyCustomerViewToInvoiceAction } from '@/server/actions/invoices';

const MODE_CHOICES: Array<{ value: CustomerViewMode; label: string; hint: string }> = [
  { value: 'lump_sum', label: 'Lump sum', hint: 'One total + scope summary.' },
  { value: 'sections', label: 'Sections', hint: 'Customer-facing groupings.' },
  { value: 'categories', label: 'Categories', hint: 'One line per category.' },
  { value: 'detailed', label: 'Detailed', hint: 'Every cost line.' },
];

type Props = {
  invoiceId: string;
  initialMode: CustomerViewMode;
  initialMgmtFeeInline: boolean;
  projectDefaultMode: CustomerViewMode;
  inputs: {
    projectName: string;
    customerSummaryMd: string | null;
    costLines: CustomerViewCostLine[];
    categories: CustomerViewCategory[];
    sections: CustomerViewSection[];
    priorBilledCents: number;
    mgmtRate: number;
    isCostPlus: boolean;
    costPlusBreakdown: CustomerViewCostPlusBreakdown | null;
  };
  /** Tax rate (decimal). Drives the "+ tax" preview at the bottom. */
  taxRate: number;
  taxLabel: string;
};

export function InvoiceViewModePreview({
  invoiceId,
  initialMode,
  initialMgmtFeeInline,
  projectDefaultMode,
  inputs,
  taxRate,
  taxLabel,
}: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<CustomerViewMode>(initialMode);
  const [mgmtFeeInline, setMgmtFeeInline] = useState(initialMgmtFeeInline);
  const [pending, startTransition] = useTransition();

  const allowedModes = useMemo(() => availableModesFor(inputs.isCostPlus), [inputs.isCostPlus]);

  const previewRows = useMemo(() => {
    const { preview } = buildCustomerViewLineItems({
      mode,
      mgmtFeeInline,
      projectName: inputs.projectName,
      customerSummaryMd: inputs.customerSummaryMd,
      costLines: inputs.costLines,
      categories: inputs.categories,
      sections: inputs.sections,
      priorBilledCents: inputs.priorBilledCents,
      mgmtRate: inputs.mgmtRate,
      isCostPlus: inputs.isCostPlus,
      costPlusBreakdown: inputs.costPlusBreakdown ?? undefined,
      asOfDate: new Date().toISOString().slice(0, 10),
    });
    return preview;
  }, [mode, mgmtFeeInline, inputs]);

  const subtotalCents = previewRows.reduce((s, r) => s + r.total_cents, 0);
  const taxCents = Math.round(subtotalCents * taxRate);
  const totalCents = subtotalCents + taxCents;

  // Sections mode produces a single "Other work" rollup when no
  // customer-facing sections are defined on the project. Tell the
  // operator how to fix it instead of silently producing a useless view.
  const sectionsModeNeedsSetup = mode === 'sections' && inputs.sections.length === 0;

  // mgmt toggle only changes shape in lump_sum (per helper semantics).
  // Disable outside lump_sum with a tooltip so the toggle doesn't look broken.
  const mgmtToggleActive = mode === 'lump_sum';

  function handleApply() {
    startTransition(async () => {
      const res = await applyCustomerViewToInvoiceAction({
        invoiceId,
        mode,
        mgmtFeeInline,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Customer view applied to invoice.');
      router.refresh();
    });
  }

  const isDefault = mode === projectDefaultMode;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-2">
          <Eye className="mt-0.5 size-5" />
          <div className="flex-1">
            <CardTitle>Customer view preview</CardTitle>
            <CardDescription>
              Pick how much detail the customer sees on this invoice. Their total stays the same in
              every mode — only the breakdown changes.{' '}
              {isDefault ? (
                <span className="text-muted-foreground/80">(Currently your project default.)</span>
              ) : (
                <span className="text-foreground/80">
                  (Override for this invoice only — project default is{' '}
                  <span className="font-medium">{projectDefaultMode.replace('_', ' ')}</span>.)
                </span>
              )}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* View mode toggles */}
        <div className="grid gap-2 sm:grid-cols-2">
          {MODE_CHOICES.map((c) => {
            const disabled = !allowedModes.includes(c.value);
            const active = c.value === mode;
            return (
              <button
                key={c.value}
                type="button"
                disabled={disabled || pending}
                onClick={() => setMode(c.value)}
                title={disabled ? 'Available on fixed-price projects only.' : undefined}
                className={cn(
                  'min-w-0 rounded-md border px-3 py-2 text-left text-xs transition',
                  active
                    ? 'border-foreground bg-foreground text-background'
                    : disabled
                      ? 'cursor-not-allowed opacity-40'
                      : 'hover:bg-muted',
                  pending && 'opacity-60',
                )}
              >
                <div className="font-medium">{c.label}</div>
                <div
                  className={cn(
                    'mt-0.5 text-[10px]',
                    active ? 'opacity-80' : 'text-muted-foreground',
                  )}
                >
                  {c.hint}
                </div>
              </button>
            );
          })}
        </div>

        {/* Mgmt fee toggle */}
        <label
          className={cn(
            'flex items-start gap-3 rounded-md border p-3',
            mgmtToggleActive ? '' : 'opacity-50',
          )}
          title={
            mgmtToggleActive
              ? undefined
              : 'Only takes effect in Lump sum mode. In other modes the management fee is always shown separately.'
          }
        >
          <input
            type="checkbox"
            className="mt-0.5"
            checked={mgmtFeeInline}
            disabled={!mgmtToggleActive || pending}
            onChange={(e) => setMgmtFeeInline(e.target.checked)}
          />
          <div className="text-xs">
            <div className="font-medium">Bake management fee into the headline total</div>
            <div className="mt-0.5 text-muted-foreground">
              One number — no separate &quot;Management fee&quot; line.
            </div>
          </div>
        </label>

        {/* Sections-mode empty state — no customer-facing sections
         *  defined yet means everything rolls into "Other work". Tell the
         *  operator how to fix that. */}
        {sectionsModeNeedsSetup ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            <p className="font-medium">Sections mode needs setup.</p>
            <p className="mt-0.5">
              This project has no customer-facing sections defined, so everything rolls into a
              single &quot;Other work&quot; line. Set them up on the project&apos;s Portal tab
              (Customer view card), then come back here.
            </p>
          </div>
        ) : null}

        {/* Live preview */}
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Preview
          </div>
          <PreviewRowsList rows={previewRows} />

          <div className="mt-4 space-y-1 rounded-md bg-muted/40 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="tabular-nums">{formatCurrency(subtotalCents)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{taxLabel}</span>
              <span className="tabular-nums">{formatCurrency(taxCents)}</span>
            </div>
            <div className="flex items-center justify-between border-t pt-1 text-base font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{formatCurrency(totalCents)}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button onClick={handleApply} disabled={pending}>
            {pending ? 'Applying…' : 'Apply to invoice'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PreviewRowsList({ rows }: { rows: CustomerViewPreviewRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
        Nothing to preview — the project has no priced cost lines yet.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <PreviewRowCard key={`${r.kind}-${r.title}-${r.total_cents}`} row={r} />
      ))}
    </div>
  );
}

function PreviewRowCard({ row }: { row: CustomerViewPreviewRow }) {
  const accent =
    row.kind === 'prior_credit'
      ? 'border-blue-200 bg-blue-50/40 dark:border-blue-900 dark:bg-blue-950/20'
      : row.kind === 'mgmt_fee'
        ? 'border-muted bg-muted/30'
        : 'border-border bg-card';
  return (
    <div className={cn('rounded-lg border p-3', accent)}>
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium">{row.title}</span>
        <span className="whitespace-nowrap text-sm font-semibold tabular-nums">
          {formatCurrency(row.total_cents)}
        </span>
      </div>
      {row.body_md ? (
        <div className="mt-1 text-xs text-muted-foreground">
          <RichTextDisplay markdown={row.body_md} />
        </div>
      ) : null}
    </div>
  );
}
