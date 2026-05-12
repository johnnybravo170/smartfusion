/**
 * Server-side loader for everything the invoice customer-view preview
 * needs to build line items in every mode. Used by the draft invoice
 * page (to seed the preview) and by `applyCustomerViewToInvoiceAction`
 * (to recompute server-side without trusting client-sent items).
 *
 * Returns null when the invoice has no project (one-off jobs) — the
 * preview surface is skipped in that case.
 */

import { computeCostPlusBreakdown } from '@/lib/invoices/cost-plus-markup';
import type {
  CostPlusDetailedEntry,
  CustomerViewCategory,
  CustomerViewCostLine,
  CustomerViewCostPlusBreakdown,
  CustomerViewSection,
} from '@/lib/invoices/customer-view-line-items';
import { createClient } from '@/lib/supabase/server';
import type { CustomerViewMode } from '@/lib/validators/project-customer-view';

/** Format YYYY-MM-DD or ISO timestamp date string into "Mar 15, 2026"
 *  for customer-facing surfaces. The column is a DATE so no tz conversion
 *  is needed — just parse and format the date verbatim. */
function formatEntryDate(raw: string | null): string | null {
  if (!raw) return null;
  // Postgres returns DATE as "YYYY-MM-DD" or "YYYY-MM-DDT00:00:00.000Z";
  // either way the first 10 chars are the date.
  const ymd = raw.slice(0, 10);
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${months[m - 1]} ${d}, ${y}`;
}

function formatCadShort(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export type InvoiceCustomerViewInputs = {
  projectId: string;
  projectName: string;
  customerSummaryMd: string | null;
  projectDefaultMode: CustomerViewMode;
  isCostPlus: boolean;
  mgmtRate: number;
  priorBilledCents: number;
  costLines: CustomerViewCostLine[];
  categories: CustomerViewCategory[];
  sections: CustomerViewSection[];
  /** Populated only when isCostPlus=true. */
  costPlusBreakdown: CustomerViewCostPlusBreakdown | null;
};

export async function loadInvoiceCustomerViewInputs(
  invoiceId: string,
): Promise<InvoiceCustomerViewInputs | null> {
  const supabase = await createClient();

  const { data: invoice } = await supabase
    .from('invoices')
    .select('id, project_id')
    .eq('id', invoiceId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!invoice?.project_id) return null;
  const projectId = invoice.project_id as string;

  const { data: project } = await supabase
    .from('projects')
    .select('id, name, customer_summary_md, customer_view_mode, management_fee_rate, is_cost_plus')
    .eq('id', projectId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!project) return null;

  const isCostPlus = (project.is_cost_plus as boolean | null) !== false;
  const mgmtRate = Number((project.management_fee_rate as number | null) ?? 0.12);

  const [
    { data: costLineRows },
    { data: categoryRows },
    { data: sectionRows },
    { data: priorInvoiceRows },
  ] = await Promise.all([
    supabase
      .from('project_cost_lines')
      .select('label, qty, unit_price_cents, line_price_cents, notes, budget_category_id')
      .eq('project_id', projectId)
      .gt('line_price_cents', 0)
      .order('sort_order')
      .order('created_at'),
    supabase
      .from('project_budget_categories')
      .select('id, name, description_md, customer_section_id')
      .eq('project_id', projectId)
      .order('display_order')
      .order('name'),
    supabase
      .from('project_customer_sections')
      .select('id, name, description_md')
      .eq('project_id', projectId)
      .order('sort_order')
      .order('created_at'),
    supabase
      .from('invoices')
      .select('amount_cents')
      .eq('project_id', projectId)
      .neq('id', invoiceId)
      .not('status', 'in', '("void")')
      .is('deleted_at', null),
  ]);

  const priorBilledCents = (priorInvoiceRows ?? []).reduce(
    (s, r) => s + ((r.amount_cents as number) ?? 0),
    0,
  );

  let costPlusBreakdown: CustomerViewCostPlusBreakdown | null = null;
  if (isCostPlus) {
    const { getProjectCostBasisRollup } = await import('@/lib/db/queries/project-cost-basis');
    const rollup = await getProjectCostBasisRollup(projectId);
    const expenses = [
      ...rollup.expenseRows,
      ...rollup.billRows.map((b) => ({
        amount_cents: b.amount_cents + b.gst_cents,
        pre_tax_amount_cents: b.amount_cents,
      })),
    ];
    const breakdown = computeCostPlusBreakdown({
      timeEntries: rollup.timeEntries,
      expenses,
      priorInvoices: [],
      mgmtRate,
    });

    // Per-category aggregation for sections / categories modes + per-entry
    // detail for Detailed mode. Both sum to labour + materials (mgmt fee
    // stays as a separate row in the helper, not distributed across rows).
    // Empty-string key in the category map is the uncategorized bucket.
    const byCategoryCents: Record<string, number> = {};
    const detailedEntries: CostPlusDetailedEntry[] = [];

    const [timeCatRes, costCatRes] = await Promise.all([
      supabase
        .from('time_entries')
        .select('budget_category_id, hours, hourly_rate_cents, notes, entry_date')
        .eq('project_id', projectId),
      supabase
        .from('project_costs')
        .select(
          'budget_category_id, source_type, amount_cents, pre_tax_amount_cents, vendor, description, cost_date',
        )
        .eq('project_id', projectId)
        .eq('status', 'active'),
    ]);

    for (const t of (timeCatRes.data ?? []) as {
      budget_category_id: string | null;
      hours: number;
      hourly_rate_cents: number | null;
      notes: string | null;
      entry_date: string | null;
    }[]) {
      const rate = t.hourly_rate_cents ?? 0;
      const hours = Number(t.hours);
      const cents = Math.round(hours * rate);
      if (cents <= 0) continue;
      const key = t.budget_category_id ?? '';
      byCategoryCents[key] = (byCategoryCents[key] ?? 0) + cents;

      const dateLabel = formatEntryDate(t.entry_date) ?? '';
      const rateLabel = `${hours}h × ${formatCadShort(rate)}/hr`;
      detailedEntries.push({
        kind: 'labour',
        title: dateLabel ? `Labour — ${dateLabel}` : 'Labour',
        body_md: t.notes ? `${rateLabel} · ${t.notes}` : rateLabel,
        total_cents: cents,
        date: t.entry_date ? t.entry_date.slice(0, 10) : null,
      });
    }

    for (const c of (costCatRes.data ?? []) as {
      budget_category_id: string | null;
      source_type: 'receipt' | 'vendor_bill';
      amount_cents: number;
      pre_tax_amount_cents: number | null;
      vendor: string | null;
      description: string | null;
      cost_date: string | null;
    }[]) {
      // Pre-tax cost basis for both receipts and bills. Mirrors how
      // computeCostPlusBreakdown bills materials — see cost-plus-markup.ts
      // for the ITC / GST-on-GST rationale.
      const cents = c.pre_tax_amount_cents ?? c.amount_cents;
      if (cents <= 0) continue;
      const key = c.budget_category_id ?? '';
      byCategoryCents[key] = (byCategoryCents[key] ?? 0) + cents;

      const dateLabel = formatEntryDate(c.cost_date);
      const headline = c.vendor?.trim() || c.description?.trim() || 'Materials';
      const bodyParts: string[] = [];
      if (c.vendor && c.description) bodyParts.push(c.description);
      if (dateLabel) bodyParts.push(dateLabel);
      detailedEntries.push({
        kind: 'material',
        title: headline,
        body_md: bodyParts.length > 0 ? bodyParts.join(' · ') : null,
        total_cents: cents,
        date: c.cost_date ? c.cost_date.slice(0, 10) : null,
      });
    }

    // Chronological order — customer reads the invoice as a project timeline.
    // Entries without dates sort to the end.
    detailedEntries.sort((a, b) => {
      if (a.date && b.date) return a.date.localeCompare(b.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    });

    costPlusBreakdown = {
      labourCents: breakdown.labourCents,
      materialsCents: breakdown.materialsCents,
      mgmtFeeCents: breakdown.mgmtFeeCents,
      byCategoryCents,
      detailedEntries,
    };
  }

  return {
    projectId,
    projectName: (project.name as string) ?? '',
    customerSummaryMd: (project.customer_summary_md as string | null) ?? null,
    projectDefaultMode: ((project.customer_view_mode as CustomerViewMode | null) ??
      'detailed') as CustomerViewMode,
    isCostPlus,
    mgmtRate,
    priorBilledCents,
    costLines: (costLineRows ?? []) as CustomerViewCostLine[],
    categories: (categoryRows ?? []) as CustomerViewCategory[],
    sections: (sectionRows ?? []) as CustomerViewSection[],
    costPlusBreakdown,
  };
}
