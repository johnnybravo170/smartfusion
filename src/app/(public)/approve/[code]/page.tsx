import { ChangeOrderDiffView } from '@/components/features/change-orders/change-order-diff-view';
import { PublicViewLogger } from '@/components/features/public/public-view-logger';
import type { ChangeOrderLineRow } from '@/lib/db/queries/change-orders';
import { createAdminClient } from '@/lib/supabase/admin';
import { ApprovalForm } from './approval-form';

export const metadata = {
  title: 'Change Order — HeyHenry',
};

export default async function ApprovalPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const admin = createAdminClient();

  // Look up change order by approval code
  const { data: co } = await admin
    .from('change_orders')
    .select(
      `id, project_id, title, description, reason, cost_impact_cents, timeline_impact_days,
       status, approved_by_name, approved_at, declined_at, declined_reason, approval_code,
       flow_version, category_notes,
       management_fee_override_rate,
       projects:project_id (name, management_fee_rate, customers:customer_id (name)),
       tenants:tenant_id (name)`,
    )
    .eq('approval_code', code)
    .single();

  if (!co) {
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <h1 className="text-2xl font-semibold">Change Order Not Found</h1>
        <p className="mt-2 text-muted-foreground">
          This link may have expired or the change order may have been voided.
        </p>
      </div>
    );
  }

  const coData = co as Record<string, unknown>;
  const project = coData.projects as Record<string, unknown> | null;
  const tenant = coData.tenants as Record<string, unknown> | null;
  const _customerRaw = project?.customers as Record<string, unknown> | null;
  const projectName = (project?.name as string) ?? 'Project';
  const businessName = (tenant?.name as string) ?? 'Your Contractor';

  // Already responded
  if (coData.status === 'approved') {
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
          <svg
            className="h-8 w-8 text-emerald-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            role="img"
            aria-label="Approved"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold">Already Approved</h1>
        <p className="mt-2 text-muted-foreground">
          This change order was approved by {coData.approved_by_name as string} on{' '}
          {new Date(coData.approved_at as string).toLocaleDateString('en-CA', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })}
          .
        </p>
      </div>
    );
  }

  if (coData.status === 'declined') {
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <h1 className="text-2xl font-semibold">Change Order Declined</h1>
        <p className="mt-2 text-muted-foreground">
          This change order was declined.
          {coData.declined_reason ? ` Reason: ${coData.declined_reason}` : ''}
        </p>
      </div>
    );
  }

  if (coData.status === 'voided') {
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <h1 className="text-2xl font-semibold">Change Order Voided</h1>
        <p className="mt-2 text-muted-foreground">
          This change order has been cancelled by the contractor.
        </p>
      </div>
    );
  }

  if (coData.status !== 'pending_approval') {
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <h1 className="text-2xl font-semibold">Not Available</h1>
        <p className="mt-2 text-muted-foreground">
          This change order is not currently awaiting approval.
        </p>
      </div>
    );
  }

  const costCents = coData.cost_impact_cents as number;
  const costFormatted = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
  }).format(Math.abs(costCents) / 100);
  const costSign = costCents >= 0 ? '+' : '-';

  // Management fee on this CO. Mirrors the customer-facing estimate page
  // (which breaks out "Management fee (X%)" as a separate line) so the
  // customer sees the same shape for change orders. Operator may override
  // the rate per CO — the customer sees that rate, not the project default.
  const projectFeeRate = (project?.management_fee_rate as number | null) ?? 0;
  const overrideFeeRate = coData.management_fee_override_rate as number | null;
  const coFeeRate = overrideFeeRate ?? projectFeeRate;
  const coFeeCents = Math.round(costCents * coFeeRate);
  const totalImpactCents = costCents + coFeeCents;

  const fmtCurrency = (cents: number) =>
    new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(
      Math.abs(cents) / 100,
    );
  const formatPct = (rate: number) => (rate * 100).toFixed(2).replace(/\.?0+$/, '');

  const timelineDays = coData.timeline_impact_days as number;

  // Running project total — current cost_lines + the same project-rate
  // management fee the customer signed off on at estimate-approval time.
  // Adding this CO's cost + its (possibly-overridden) fee gives the new
  // running total. Customer sees the full running revenue, not just the
  // line subtotal.
  const projectIdForTotal = coData.project_id as string;
  const { data: linesForTotal } = await admin
    .from('project_cost_lines')
    .select('line_price_cents')
    .eq('project_id', projectIdForTotal);
  const currentLinesCents = ((linesForTotal ?? []) as { line_price_cents: number }[]).reduce(
    (s, l) => s + l.line_price_cents,
    0,
  );
  const currentFeeCents = Math.round(currentLinesCents * projectFeeRate);
  const currentProjectTotalCents = currentLinesCents + currentFeeCents;
  const newProjectTotalCents = currentProjectTotalCents + totalImpactCents;

  // For v2 COs, surface the line-level diff + per-category notes so the
  // homeowner sees exactly what changed before signing. v1 stays text-only.
  const flowVersion = (coData.flow_version as number | null) ?? 1;
  const categoryNotes =
    (coData.category_notes as { budget_category_id: string; note: string }[] | null) ?? [];

  let diffLines: ChangeOrderLineRow[] = [];
  let budgetCategoryNamesById: Record<string, string> = {};
  if (flowVersion === 2) {
    const { data: lines } = await admin
      .from('change_order_lines')
      .select(
        'id, change_order_id, action, original_line_id, budget_category_id, category, label, qty, unit, unit_cost_cents, unit_price_cents, line_cost_cents, line_price_cents, notes, before_snapshot',
      )
      .eq('change_order_id', coData.id as string)
      .order('created_at', { ascending: true });
    diffLines = (lines ?? []) as ChangeOrderLineRow[];

    const projectId = coData.project_id as string;
    const { data: cats } = await admin
      .from('project_budget_categories')
      .select('id, name')
      .eq('project_id', projectId);
    budgetCategoryNamesById = Object.fromEntries(
      ((cats ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]),
    );
  }

  const showDiff = flowVersion === 2 && (diffLines.length > 0 || categoryNotes.length > 0);

  return (
    <div className={`mx-auto px-4 py-12 ${showDiff ? 'max-w-2xl' : 'max-w-lg'}`}>
      <PublicViewLogger resourceType="change_order" identifier={code} />
      <div className="mb-8 text-center">
        <p className="text-sm font-medium text-muted-foreground">{businessName}</p>
        <h1 className="mt-1 text-2xl font-semibold">Change Order</h1>
        <p className="mt-1 text-sm text-muted-foreground">{projectName}</p>
      </div>

      <div className="rounded-lg border p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold">{coData.title as string}</h2>
          <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">
            {coData.description as string}
          </p>
          {coData.reason ? (
            <p className="mt-2 text-sm text-muted-foreground">Reason: {coData.reason as string}</p>
          ) : null}
        </div>

        <div className="rounded-md bg-muted/50 p-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Total Cost Impact</p>
              <p className="text-xl font-semibold">
                {totalImpactCents >= 0 ? '+' : '-'}
                {fmtCurrency(totalImpactCents)}
              </p>
              <p className="text-xs text-muted-foreground">
                New project total{' '}
                <span className="font-medium text-foreground tabular-nums">
                  {fmtCurrency(newProjectTotalCents)}
                </span>
                {currentProjectTotalCents > 0 ? (
                  <> (was {fmtCurrency(currentProjectTotalCents)})</>
                ) : null}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Timeline Impact</p>
              <p className="text-xl font-semibold">
                {timelineDays === 0
                  ? 'None'
                  : `${timelineDays > 0 ? '+' : ''}${timelineDays} day${Math.abs(timelineDays) === 1 ? '' : 's'}`}
              </p>
            </div>
          </div>

          {coFeeCents !== 0 ? (
            <div className="mt-3 space-y-1 border-t pt-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Cost of work</span>
                <span className="tabular-nums">
                  {costSign}
                  {costFormatted}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  Management fee ({formatPct(coFeeRate)}%)
                </span>
                <span className="tabular-nums">
                  {coFeeCents >= 0 ? '+' : '-'}
                  {fmtCurrency(coFeeCents)}
                </span>
              </div>
              <div className="flex justify-between border-t pt-1.5 font-medium">
                <span>Total</span>
                <span className="tabular-nums">
                  {totalImpactCents >= 0 ? '+' : '-'}
                  {fmtCurrency(totalImpactCents)}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        {showDiff ? (
          <ChangeOrderDiffView
            diffLines={diffLines}
            categoryNotes={categoryNotes}
            budgetCategoryNamesById={budgetCategoryNamesById}
          />
        ) : null}

        <ApprovalForm approvalCode={code} />
      </div>
    </div>
  );
}
