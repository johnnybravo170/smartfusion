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
  CustomerViewCategory,
  CustomerViewCostLine,
  CustomerViewCostPlusBreakdown,
  CustomerViewSection,
} from '@/lib/invoices/customer-view-line-items';
import { createClient } from '@/lib/supabase/server';
import type { CustomerViewMode } from '@/lib/validators/project-customer-view';

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
    costPlusBreakdown = {
      labourCents: breakdown.labourCents,
      materialsCents: breakdown.materialsCents,
      mgmtFeeCents: breakdown.mgmtFeeCents,
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
