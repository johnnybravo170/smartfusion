/**
 * Pure helper that materializes the invoice line_items array given a
 * customer-facing view mode + the project's underlying data.
 *
 * Drives the live-preview surface on the draft invoice page. The same
 * helper runs on Apply to persist the chosen mode's output into
 * `invoices.line_items`. Identical inputs → identical output, so the
 * preview the operator saw is byte-equal to what gets stored.
 *
 * Modes (mirrors `projects.customer_view_mode`):
 *   lump_sum   — one line, sum of all cost lines (optional mgmt-bake-in)
 *   sections   — one line per customer-facing section; unsectioned → "Other"
 *   categories — one line per priced budget category
 *   detailed   — one line per priced cost line (current generator behavior,
 *                byte-identical to the inline iteration this replaces)
 *
 * mgmtFeeInline semantics:
 *   lump_sum  → mgmt fee folded into the headline total when true.
 *   any other → mgmt fee always shown as a separate line. The toggle is
 *               surfaced in the UI but effectively a no-op outside
 *               lump_sum. Reason: distributing mgmt proportionally across
 *               detailed line items breaks the unit_price_cents × qty
 *               invariant and produces dishonest per-unit prices.
 *
 * Prior-invoices credit is appended unchanged at the end across every
 * mode — the operator needs to see the running balance regardless of how
 * detailed the breakdown is.
 *
 * What this does NOT do:
 *   - Query Supabase. Caller fetches inputs.
 *   - Compute GST. Caller handles tax via `canadianTax.getCustomerFacingContext`.
 *   - Decide visibility / RLS. Caller's job.
 *   - Subtotal invariance across modes is a tested guarantee — switching
 *     modes never changes what the customer owes.
 */

import type { InvoiceLineItem } from '@/lib/db/queries/invoices';
import type { CustomerViewMode } from '@/lib/validators/project-customer-view';

export type CustomerViewCostLine = {
  label: string;
  qty: number;
  unit_price_cents: number;
  line_price_cents: number;
  notes: string | null;
  budget_category_id: string | null;
};

export type CustomerViewCategory = {
  id: string;
  name: string;
  description_md: string | null;
  customer_section_id: string | null;
};

export type CustomerViewSection = {
  id: string;
  name: string;
  description_md: string | null;
};

/** Cost-plus breakdown — used when isCostPlus=true. Shape mirrors
 *  `computeCostPlusBreakdown`'s output. */
export type CustomerViewCostPlusBreakdown = {
  labourCents: number;
  materialsCents: number;
  mgmtFeeCents: number;
};

export type BuildCustomerViewArgs = {
  mode: CustomerViewMode;
  mgmtFeeInline: boolean;
  projectName: string;
  customerSummaryMd: string | null;
  /** Fixed-price inputs. Empty when isCostPlus=true. */
  costLines: ReadonlyArray<CustomerViewCostLine>;
  categories: ReadonlyArray<CustomerViewCategory>;
  sections: ReadonlyArray<CustomerViewSection>;
  /** Sum of already-billed prior invoices, gross. Subtracted as a negative line. */
  priorBilledCents: number;
  /** Decimal — e.g. 0.12 for 12%. */
  mgmtRate: number;
  isCostPlus: boolean;
  /** Required when isCostPlus=true; ignored otherwise. */
  costPlusBreakdown?: CustomerViewCostPlusBreakdown;
  /** ISO date used in the cost-plus lump_sum headline ("period through {date}"). */
  asOfDate?: string;
};

/** Modes available on a given project type. Cost-plus can't do sections /
 *  categories because cost-plus draws from time_entries + project_costs,
 *  not estimate sections. UI uses this to grey out unavailable radios. */
export function availableModesFor(isCostPlus: boolean): CustomerViewMode[] {
  return isCostPlus ? ['lump_sum', 'detailed'] : ['lump_sum', 'sections', 'categories', 'detailed'];
}

export function buildCustomerViewLineItems(args: BuildCustomerViewArgs): {
  items: InvoiceLineItem[];
} {
  const items = args.isCostPlus ? buildCostPlus(args) : buildFixedPrice(args);

  if (args.priorBilledCents > 0) {
    items.push({
      description: 'Less: Prior Invoices',
      quantity: 1,
      unit_price_cents: -args.priorBilledCents,
      total_cents: -args.priorBilledCents,
    });
  }

  return { items };
}

// ─── Fixed-price ────────────────────────────────────────────────────────────

function buildFixedPrice(args: BuildCustomerViewArgs): InvoiceLineItem[] {
  // Cost-plus modes (sections/categories) fall back to detailed when caller
  // hands us a cost-plus project on a fixed-price mode. Defensive — the UI
  // should already block this.
  const mode: CustomerViewMode =
    args.isCostPlus && (args.mode === 'sections' || args.mode === 'categories')
      ? 'detailed'
      : args.mode;

  const costLinesSubtotal = args.costLines.reduce((s, l) => s + l.line_price_cents, 0);
  const mgmtFeeCents = Math.round(costLinesSubtotal * args.mgmtRate);

  if (mode === 'lump_sum') {
    const total = costLinesSubtotal + (args.mgmtFeeInline ? mgmtFeeCents : 0);
    const items: InvoiceLineItem[] = [
      {
        description: lumpSumDescription(args),
        quantity: 1,
        unit_price_cents: total,
        total_cents: total,
      },
    ];
    if (!args.mgmtFeeInline && mgmtFeeCents > 0) {
      items.push(mgmtFeeLine(args.mgmtRate, mgmtFeeCents));
    }
    return items;
  }

  if (mode === 'sections') {
    const items = buildSectionsItems(args);
    if (mgmtFeeCents > 0) items.push(mgmtFeeLine(args.mgmtRate, mgmtFeeCents));
    return items;
  }

  if (mode === 'categories') {
    const items = buildCategoriesItems(args);
    if (mgmtFeeCents > 0) items.push(mgmtFeeLine(args.mgmtRate, mgmtFeeCents));
    return items;
  }

  // detailed — current generator behavior, byte-identical.
  const items: InvoiceLineItem[] = args.costLines.map((l) => ({
    description: l.notes ? `${l.label} — ${l.notes}` : l.label,
    quantity: Number(l.qty),
    unit_price_cents: l.unit_price_cents,
    total_cents: l.line_price_cents,
  }));
  if (mgmtFeeCents > 0) items.push(mgmtFeeLine(args.mgmtRate, mgmtFeeCents));
  return items;
}

function buildCategoriesItems(args: BuildCustomerViewArgs): InvoiceLineItem[] {
  const byCat = new Map<string, number>();
  let uncategorizedCents = 0;
  for (const line of args.costLines) {
    if (!line.budget_category_id) {
      uncategorizedCents += line.line_price_cents;
      continue;
    }
    byCat.set(
      line.budget_category_id,
      (byCat.get(line.budget_category_id) ?? 0) + line.line_price_cents,
    );
  }

  const items: InvoiceLineItem[] = [];
  for (const cat of args.categories) {
    const total = byCat.get(cat.id) ?? 0;
    if (total <= 0) continue;
    items.push({
      description: cat.description_md ? `${cat.name} — ${cat.description_md}` : cat.name,
      quantity: 1,
      unit_price_cents: total,
      total_cents: total,
    });
  }
  if (uncategorizedCents > 0) {
    items.push({
      description: 'Other work',
      quantity: 1,
      unit_price_cents: uncategorizedCents,
      total_cents: uncategorizedCents,
    });
  }
  return items;
}

function buildSectionsItems(args: BuildCustomerViewArgs): InvoiceLineItem[] {
  // Map category -> section so we can route each cost line.
  const catToSection = new Map<string, string | null>();
  for (const cat of args.categories) {
    catToSection.set(cat.id, cat.customer_section_id);
  }

  const bySection = new Map<string, number>();
  let otherCents = 0;
  for (const line of args.costLines) {
    const sectionId = line.budget_category_id
      ? (catToSection.get(line.budget_category_id) ?? null)
      : null;
    if (!sectionId) {
      otherCents += line.line_price_cents;
      continue;
    }
    bySection.set(sectionId, (bySection.get(sectionId) ?? 0) + line.line_price_cents);
  }

  const items: InvoiceLineItem[] = [];
  for (const s of args.sections) {
    const total = bySection.get(s.id) ?? 0;
    if (total <= 0) continue;
    items.push({
      description: s.description_md ? `${s.name} — ${s.description_md}` : s.name,
      quantity: 1,
      unit_price_cents: total,
      total_cents: total,
    });
  }
  if (otherCents > 0) {
    items.push({
      description: 'Other work',
      quantity: 1,
      unit_price_cents: otherCents,
      total_cents: otherCents,
    });
  }
  return items;
}

function lumpSumDescription(args: BuildCustomerViewArgs): string {
  if (args.customerSummaryMd?.trim()) {
    return args.customerSummaryMd.trim();
  }
  return `Project work — ${args.projectName}`;
}

function mgmtFeeLine(mgmtRate: number, mgmtFeeCents: number): InvoiceLineItem {
  return {
    description: `Management fee (${Math.round(mgmtRate * 100)}%)`,
    quantity: 1,
    unit_price_cents: mgmtFeeCents,
    total_cents: mgmtFeeCents,
  };
}

// ─── Cost-plus ──────────────────────────────────────────────────────────────

function buildCostPlus(args: BuildCustomerViewArgs): InvoiceLineItem[] {
  const breakdown = args.costPlusBreakdown;
  if (!breakdown) {
    throw new Error('costPlusBreakdown is required when isCostPlus=true');
  }

  // Cost-plus only supports lump_sum + detailed in v1. Sections/categories
  // would need a different aggregation model (cost-plus draws from
  // time_entries + project_costs, not estimate sections). Fall back to
  // detailed for the disallowed modes — UI should already block this.
  const mode: CustomerViewMode = args.mode === 'lump_sum' ? 'lump_sum' : 'detailed';

  if (mode === 'lump_sum') {
    const total =
      breakdown.labourCents +
      breakdown.materialsCents +
      (args.mgmtFeeInline ? breakdown.mgmtFeeCents : 0);
    const headline = args.customerSummaryMd?.trim()
      ? args.customerSummaryMd.trim()
      : args.asOfDate
        ? `Project work — period through ${args.asOfDate}`
        : `Project work — ${args.projectName}`;
    const items: InvoiceLineItem[] = [
      {
        description: headline,
        quantity: 1,
        unit_price_cents: total,
        total_cents: total,
      },
    ];
    if (!args.mgmtFeeInline && breakdown.mgmtFeeCents > 0) {
      items.push({
        description: `Management Fee (${Math.round(args.mgmtRate * 100)}%)`,
        quantity: 1,
        unit_price_cents: breakdown.mgmtFeeCents,
        total_cents: breakdown.mgmtFeeCents,
      });
    }
    return items;
  }

  // detailed — current cost-plus generator behavior, byte-identical.
  const items: InvoiceLineItem[] = [];
  if (breakdown.labourCents > 0) {
    items.push({
      description: 'Labour',
      quantity: 1,
      unit_price_cents: breakdown.labourCents,
      total_cents: breakdown.labourCents,
    });
  }
  if (breakdown.materialsCents > 0) {
    items.push({
      description: 'Materials & Expenses',
      quantity: 1,
      unit_price_cents: breakdown.materialsCents,
      total_cents: breakdown.materialsCents,
    });
  }
  if (breakdown.mgmtFeeCents > 0) {
    items.push({
      description: `Management Fee (${Math.round(args.mgmtRate * 100)}%)`,
      quantity: 1,
      unit_price_cents: breakdown.mgmtFeeCents,
      total_cents: breakdown.mgmtFeeCents,
    });
  }
  return items;
}
