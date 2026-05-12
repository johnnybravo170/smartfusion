/**
 * Pure helper that materializes the invoice line_items array given a
 * customer-facing view mode + the project's underlying data.
 *
 * Drives the live-preview surface on the draft invoice page. The same
 * helper runs on Apply to persist the chosen mode's output into
 * `invoices.line_items`. Identical inputs → identical output, so the
 * preview the operator saw is byte-equal to what gets stored.
 *
 * Returns two parallel arrays of equal length:
 *
 *   items[]    — InvoiceLineItem shape, persisted into invoices.line_items
 *                JSONB on Apply. Descriptions are the "title — body" merged
 *                form that the public/PDF renderer reads byte-for-byte.
 *   preview[]  — Richer per-row metadata for the in-app preview UI: a short
 *                title, an optional markdown body, and the row total. Lets
 *                the preview render portal-style cards with RichTextDisplay
 *                without re-deriving descriptions from inputs.
 *
 * Subtotal invariance across modes: tested. Switching modes only changes
 * the row count and grouping, never the customer's total.
 *
 * Modes (mirrors `projects.customer_view_mode`):
 *   lump_sum   — one row, sum of all cost lines (optional mgmt-bake-in)
 *   sections   — one row per customer-facing section; unsectioned → "Other"
 *   categories — one row per priced budget category
 *   detailed   — one row per priced cost line (current generator behavior,
 *                byte-identical to the inline iteration this replaces)
 *
 * mgmtFeeInline semantics:
 *   lump_sum  → mgmt fee folded into the headline total when true.
 *   any other → mgmt fee always shown as a separate row. The toggle is
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
 *  `computeCostPlusBreakdown`'s output, plus an optional per-category
 *  breakdown of the same labour + materials total so the helper can
 *  produce sections/categories rows. */
export type CustomerViewCostPlusBreakdown = {
  labourCents: number;
  materialsCents: number;
  mgmtFeeCents: number;
  /**
   * Pre-tax cost basis grouped by `budget_category_id`. Sums to
   * labour + materials (NOT including mgmt fee — mgmt is a separate row
   * in sections/categories modes). Key `''` (empty string) is the
   * uncategorized bucket. Optional; required only for sections /
   * categories modes on cost-plus. When missing or empty for those
   * modes the helper falls back to the detailed shape.
   */
  byCategoryCents?: Record<string, number>;
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

/** Richer per-row metadata for the preview UI. */
export type CustomerViewPreviewRow = {
  /** Short title — the row's headline. */
  title: string;
  /** Optional markdown body. Rendered with RichTextDisplay. Null when
   *  the row has no supporting description (mgmt fee, prior credit, lump
   *  sum without a customer_summary_md, etc.). */
  body_md: string | null;
  total_cents: number;
  /** Visual hint for the preview component. Cosmetic only. */
  kind: 'work' | 'mgmt_fee' | 'prior_credit';
};

/** Internal row used inside the helper. Carries everything needed for
 *  both the persisted line item and the preview meta. */
type Row = {
  title: string;
  body_md: string | null;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  kind: CustomerViewPreviewRow['kind'];
};

/** Modes available on a given project type. Both fixed-price and cost-plus
 *  expose all four modes now — cost-plus aggregates time_entries +
 *  project_costs by budget_category_id (see costPlusBreakdown.byCategoryCents).
 *  When that map is empty for a cost-plus project (no costs tagged with
 *  a category yet), sections / categories silently fall back to the
 *  detailed shape inside the helper. */
export function availableModesFor(_isCostPlus: boolean): CustomerViewMode[] {
  return ['lump_sum', 'sections', 'categories', 'detailed'];
}

export function buildCustomerViewLineItems(args: BuildCustomerViewArgs): {
  items: InvoiceLineItem[];
  preview: CustomerViewPreviewRow[];
} {
  const rows = args.isCostPlus ? buildCostPlus(args) : buildFixedPrice(args);

  if (args.priorBilledCents > 0) {
    rows.push({
      title: 'Less: Prior Invoices',
      body_md: null,
      quantity: 1,
      unit_price_cents: -args.priorBilledCents,
      total_cents: -args.priorBilledCents,
      kind: 'prior_credit',
    });
  }

  return {
    items: rows.map(rowToItem),
    preview: rows.map((r) => ({
      title: r.title,
      body_md: r.body_md,
      total_cents: r.total_cents,
      kind: r.kind,
    })),
  };
}

function rowToItem(row: Row): InvoiceLineItem {
  // Public/PDF renderer reads line_items.description directly. We keep the
  // legacy "title — body" merge so the customer-facing surfaces stay
  // byte-identical to the pre-preview generator. body_md should be a single
  // line of plain text for the merge to look right — every callsite below
  // satisfies that.
  return {
    description: row.body_md ? `${row.title} — ${row.body_md}` : row.title,
    quantity: row.quantity,
    unit_price_cents: row.unit_price_cents,
    total_cents: row.total_cents,
  };
}

// ─── Fixed-price ────────────────────────────────────────────────────────────

function buildFixedPrice(args: BuildCustomerViewArgs): Row[] {
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
    const summary = args.customerSummaryMd?.trim() ?? null;
    const rows: Row[] = [
      {
        title: summary ? summary : `Project work — ${args.projectName}`,
        body_md: null,
        quantity: 1,
        unit_price_cents: total,
        total_cents: total,
        kind: 'work',
      },
    ];
    if (!args.mgmtFeeInline && mgmtFeeCents > 0) {
      rows.push(mgmtFeeRow(args.mgmtRate, mgmtFeeCents));
    }
    return rows;
  }

  if (mode === 'sections') {
    const rows = buildSectionsRows(args);
    if (mgmtFeeCents > 0) rows.push(mgmtFeeRow(args.mgmtRate, mgmtFeeCents));
    return rows;
  }

  if (mode === 'categories') {
    const rows = buildCategoriesRows(args);
    if (mgmtFeeCents > 0) rows.push(mgmtFeeRow(args.mgmtRate, mgmtFeeCents));
    return rows;
  }

  // detailed — one row per priced cost line.
  const rows: Row[] = args.costLines.map((l) => ({
    title: l.label,
    body_md: l.notes,
    quantity: Number(l.qty),
    unit_price_cents: l.unit_price_cents,
    total_cents: l.line_price_cents,
    kind: 'work',
  }));
  if (mgmtFeeCents > 0) rows.push(mgmtFeeRow(args.mgmtRate, mgmtFeeCents));
  return rows;
}

function buildCategoriesRows(args: BuildCustomerViewArgs): Row[] {
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

  const rows: Row[] = [];
  for (const cat of args.categories) {
    const total = byCat.get(cat.id) ?? 0;
    if (total <= 0) continue;
    rows.push({
      title: cat.name,
      body_md: cat.description_md,
      quantity: 1,
      unit_price_cents: total,
      total_cents: total,
      kind: 'work',
    });
  }
  if (uncategorizedCents > 0) {
    rows.push({
      title: 'Other work',
      body_md: null,
      quantity: 1,
      unit_price_cents: uncategorizedCents,
      total_cents: uncategorizedCents,
      kind: 'work',
    });
  }
  return rows;
}

function buildSectionsRows(args: BuildCustomerViewArgs): Row[] {
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

  const rows: Row[] = [];
  for (const s of args.sections) {
    const total = bySection.get(s.id) ?? 0;
    if (total <= 0) continue;
    rows.push({
      title: s.name,
      body_md: s.description_md,
      quantity: 1,
      unit_price_cents: total,
      total_cents: total,
      kind: 'work',
    });
  }
  if (otherCents > 0) {
    rows.push({
      title: 'Other work',
      body_md: null,
      quantity: 1,
      unit_price_cents: otherCents,
      total_cents: otherCents,
      kind: 'work',
    });
  }
  return rows;
}

function mgmtFeeRow(mgmtRate: number, mgmtFeeCents: number): Row {
  return {
    title: `Management fee (${Math.round(mgmtRate * 100)}%)`,
    body_md: null,
    quantity: 1,
    unit_price_cents: mgmtFeeCents,
    total_cents: mgmtFeeCents,
    kind: 'mgmt_fee',
  };
}

// ─── Cost-plus ──────────────────────────────────────────────────────────────

function buildCostPlus(args: BuildCustomerViewArgs): Row[] {
  const breakdown = args.costPlusBreakdown;
  if (!breakdown) {
    throw new Error('costPlusBreakdown is required when isCostPlus=true');
  }

  // Sections / categories only work when the loader populated the
  // per-category map. Fall back to detailed when it's missing/empty —
  // cost-plus projects whose costs haven't been tagged with categories
  // can't be meaningfully grouped.
  const hasCategoryData =
    breakdown.byCategoryCents !== undefined &&
    Object.values(breakdown.byCategoryCents).some((v) => v > 0);
  const mode: CustomerViewMode =
    (args.mode === 'sections' || args.mode === 'categories') && !hasCategoryData
      ? 'detailed'
      : args.mode;

  if (mode === 'sections') {
    const rows = buildCostPlusSectionsRows(args, breakdown);
    if (breakdown.mgmtFeeCents > 0) rows.push(mgmtFeeRow(args.mgmtRate, breakdown.mgmtFeeCents));
    return rows;
  }

  if (mode === 'categories') {
    const rows = buildCostPlusCategoriesRows(args, breakdown);
    if (breakdown.mgmtFeeCents > 0) rows.push(mgmtFeeRow(args.mgmtRate, breakdown.mgmtFeeCents));
    return rows;
  }

  if (mode === 'lump_sum') {
    const total =
      breakdown.labourCents +
      breakdown.materialsCents +
      (args.mgmtFeeInline ? breakdown.mgmtFeeCents : 0);
    const summary = args.customerSummaryMd?.trim() ?? null;
    const headline = summary
      ? summary
      : args.asOfDate
        ? `Project work — period through ${args.asOfDate}`
        : `Project work — ${args.projectName}`;
    const rows: Row[] = [
      {
        title: headline,
        body_md: null,
        quantity: 1,
        unit_price_cents: total,
        total_cents: total,
        kind: 'work',
      },
    ];
    if (!args.mgmtFeeInline && breakdown.mgmtFeeCents > 0) {
      rows.push({
        title: `Management Fee (${Math.round(args.mgmtRate * 100)}%)`,
        body_md: null,
        quantity: 1,
        unit_price_cents: breakdown.mgmtFeeCents,
        total_cents: breakdown.mgmtFeeCents,
        kind: 'mgmt_fee',
      });
    }
    return rows;
  }

  // detailed — Labour / Materials / Mgmt rows.
  const rows: Row[] = [];
  if (breakdown.labourCents > 0) {
    rows.push({
      title: 'Labour',
      body_md: null,
      quantity: 1,
      unit_price_cents: breakdown.labourCents,
      total_cents: breakdown.labourCents,
      kind: 'work',
    });
  }
  if (breakdown.materialsCents > 0) {
    rows.push({
      title: 'Materials & Expenses',
      body_md: null,
      quantity: 1,
      unit_price_cents: breakdown.materialsCents,
      total_cents: breakdown.materialsCents,
      kind: 'work',
    });
  }
  if (breakdown.mgmtFeeCents > 0) {
    rows.push({
      title: `Management Fee (${Math.round(args.mgmtRate * 100)}%)`,
      body_md: null,
      quantity: 1,
      unit_price_cents: breakdown.mgmtFeeCents,
      total_cents: breakdown.mgmtFeeCents,
      kind: 'mgmt_fee',
    });
  }
  return rows;
}

function buildCostPlusCategoriesRows(
  args: BuildCustomerViewArgs,
  breakdown: CustomerViewCostPlusBreakdown,
): Row[] {
  const byCat = breakdown.byCategoryCents ?? {};
  const rows: Row[] = [];
  for (const cat of args.categories) {
    const total = byCat[cat.id] ?? 0;
    if (total <= 0) continue;
    rows.push({
      title: cat.name,
      body_md: cat.description_md,
      quantity: 1,
      unit_price_cents: total,
      total_cents: total,
      kind: 'work',
    });
  }
  const uncategorized = byCat[''] ?? 0;
  if (uncategorized > 0) {
    rows.push({
      title: 'Other work',
      body_md: null,
      quantity: 1,
      unit_price_cents: uncategorized,
      total_cents: uncategorized,
      kind: 'work',
    });
  }
  return rows;
}

function buildCostPlusSectionsRows(
  args: BuildCustomerViewArgs,
  breakdown: CustomerViewCostPlusBreakdown,
): Row[] {
  const byCat = breakdown.byCategoryCents ?? {};
  const catToSection = new Map<string, string | null>();
  for (const cat of args.categories) {
    catToSection.set(cat.id, cat.customer_section_id);
  }

  const bySection = new Map<string, number>();
  let otherCents = byCat[''] ?? 0; // uncategorized always falls into Other
  for (const [catId, amount] of Object.entries(byCat)) {
    if (catId === '' || amount <= 0) continue;
    const sectionId = catToSection.get(catId) ?? null;
    if (!sectionId) {
      otherCents += amount;
      continue;
    }
    bySection.set(sectionId, (bySection.get(sectionId) ?? 0) + amount);
  }

  const rows: Row[] = [];
  for (const s of args.sections) {
    const total = bySection.get(s.id) ?? 0;
    if (total <= 0) continue;
    rows.push({
      title: s.name,
      body_md: s.description_md,
      quantity: 1,
      unit_price_cents: total,
      total_cents: total,
      kind: 'work',
    });
  }
  if (otherCents > 0) {
    rows.push({
      title: 'Other work',
      body_md: null,
      quantity: 1,
      unit_price_cents: otherCents,
      total_cents: otherCents,
      kind: 'work',
    });
  }
  return rows;
}
