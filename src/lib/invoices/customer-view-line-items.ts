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
  /** Project_cost_lines.id. Optional for fixed-price (which keys by
   *  budget_category_id and uses line_price_cents directly), required
   *  for cost-plus Detailed (which keys actual spend by cost_line_id). */
  id?: string;
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
  /** Section label from `project_budget_categories.section`. This is the
   *  text-col header the operator uses to group categories in the Budget
   *  tab (e.g. "Master suite addition", "Pizza Oven"). Empty string =
   *  ungrouped. Sections mode aggregates categories by this value. */
  section: string;
};

/** Cost-plus breakdown — used when isCostPlus=true. Shape mirrors
 *  `computeCostPlusBreakdown`'s output, plus optional per-category and
 *  per-cost-line breakdowns of the same labour + materials total so the
 *  helper can produce sections/categories and detailed rows. */
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
  /**
   * Pre-tax cost basis grouped by `cost_line_id` on the project's
   * `project_cost_lines`. Sums to labour + materials. Key `''` (empty
   * string) collects spend not tagged to a specific cost line (rare —
   * shows as "Other work" in Detailed mode). Drives cost-plus Detailed:
   * the customer sees their project's budget cost lines with actual
   * spend per line, NOT individual receipts or time entries.
   */
  byCostLineCents?: Record<string, number>;
};

export type BuildCustomerViewArgs = {
  mode: CustomerViewMode;
  mgmtFeeInline: boolean;
  projectName: string;
  customerSummaryMd: string | null;
  /** Fixed-price inputs. Empty when isCostPlus=true. */
  costLines: ReadonlyArray<CustomerViewCostLine>;
  categories: ReadonlyArray<CustomerViewCategory>;
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
  /** Visual hint for the preview component. Cosmetic only.
   *  - work: regular line/category/section row.
   *  - group_header: presentation-only header that visually contains
   *    the rows immediately following it (Detailed mode). `total_cents`
   *    is the group subtotal. Not included in `items` for persistence.
   *  - mgmt_fee / prior_credit: leaf rows with distinct styling. */
  kind: 'work' | 'group_header' | 'mgmt_fee' | 'prior_credit';
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
    // group_header rows are presentation-only and never persist into
    // invoices.line_items. The customer-facing total stays correct because
    // the leaf rows under each header carry the actual amounts.
    items: rows.filter((r) => r.kind !== 'group_header').map(rowToItem),
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

  // detailed — cost lines grouped under their parent category header.
  // Each category that has priced lines emits a group_header row (with
  // the category's subtotal + description) followed by its line rows
  // indented underneath. Lines whose category isn't in args.categories
  // (or has no budget_category_id) fall under an "Other work" header.
  // When args.categories is empty, the grouping degrades gracefully to
  // a flat list (legacy behaviour for callers that don't pass category
  // metadata).
  const rows: Row[] = buildDetailedGroupedRows(args);
  if (mgmtFeeCents > 0) rows.push(mgmtFeeRow(args.mgmtRate, mgmtFeeCents));
  return rows;
}

function buildDetailedGroupedRows(args: BuildCustomerViewArgs): Row[] {
  const byCat = new Map<string, CustomerViewCostLine[]>();
  const uncategorized: CustomerViewCostLine[] = [];
  for (const line of args.costLines) {
    if (!line.budget_category_id) {
      uncategorized.push(line);
      continue;
    }
    const list = byCat.get(line.budget_category_id) ?? [];
    list.push(line);
    byCat.set(line.budget_category_id, list);
  }

  const out: Row[] = [];

  // Flat fallback when caller doesn't pass categories — no grouping context.
  if (args.categories.length === 0) {
    for (const l of args.costLines) out.push(makeLineRow(l));
    return out;
  }

  for (const cat of args.categories) {
    const lines = byCat.get(cat.id) ?? [];
    if (lines.length === 0) continue;
    const subtotal = lines.reduce((s, l) => s + l.line_price_cents, 0);
    out.push({
      title: cat.name,
      body_md: cat.description_md,
      quantity: 1,
      unit_price_cents: subtotal,
      total_cents: subtotal,
      kind: 'group_header',
    });
    for (const l of lines) out.push(makeLineRow(l));
  }

  if (uncategorized.length > 0) {
    const subtotal = uncategorized.reduce((s, l) => s + l.line_price_cents, 0);
    out.push({
      title: 'Other work',
      body_md: null,
      quantity: 1,
      unit_price_cents: subtotal,
      total_cents: subtotal,
      kind: 'group_header',
    });
    for (const l of uncategorized) out.push(makeLineRow(l));
  }
  return out;
}

function makeLineRow(l: CustomerViewCostLine): Row {
  return {
    title: l.label,
    body_md: l.notes,
    quantity: Number(l.qty),
    unit_price_cents: l.unit_price_cents,
    total_cents: l.line_price_cents,
    kind: 'work',
  };
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
  // Sections come from the `section` text col on each budget category —
  // the same labels the operator sees as headers in the Budget tab
  // ("Pizza Oven", "Master suite addition"). When no category has a
  // non-empty section value, this mode degrades to one row per category
  // (the same shape as Categories mode).
  const catToSection = new Map<string, string>();
  for (const cat of args.categories) {
    catToSection.set(cat.id, cat.section ?? '');
  }

  const anySection = args.categories.some((c) => (c.section ?? '').trim() !== '');
  if (!anySection) {
    // Fallback: no operator-defined sections, so just emit one row per
    // priced category. Same shape as Categories mode.
    return buildCategoriesRows(args);
  }

  // Preserve first-seen order of section labels for stable output.
  const sectionOrder: string[] = [];
  const bySection = new Map<string, number>();
  for (const line of args.costLines) {
    const section = line.budget_category_id
      ? (catToSection.get(line.budget_category_id) ?? '')
      : '';
    const key = section.trim() === '' ? '' : section;
    if (!bySection.has(key)) sectionOrder.push(key);
    bySection.set(key, (bySection.get(key) ?? 0) + line.line_price_cents);
  }

  const rows: Row[] = [];
  for (const key of sectionOrder) {
    if (key === '') continue; // handle 'Other work' last
    const total = bySection.get(key) ?? 0;
    if (total <= 0) continue;
    rows.push({
      title: key,
      body_md: null,
      quantity: 1,
      unit_price_cents: total,
      total_cents: total,
      kind: 'work',
    });
  }
  const otherCents = bySection.get('') ?? 0;
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
    title: `Management Fee (${Math.round(mgmtRate * 100)}%)`,
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
      rows.push(mgmtFeeRow(args.mgmtRate, breakdown.mgmtFeeCents));
    }
    return rows;
  }

  // detailed — cost lines grouped under their parent category header,
  // amounts from byCostLineCents (actual cost-plus spend per line).
  // NO receipt-level or time-entry-level info; the customer sees scope
  // items, not operational data. Lines with $0 spend (planned-but-
  // untouched) are hidden. Spend not tagged to any cost line rolls into
  // "Other work" header. Mgmt fee appended last.
  const rows: Row[] = [];
  const byLine = breakdown.byCostLineCents ?? {};
  const hasLineData = Object.values(byLine).some((v) => v > 0);
  if (hasLineData) {
    // Group cost lines by category for grouped emission with headers.
    const byCat = new Map<string, CustomerViewCostLine[]>();
    const uncategorized: CustomerViewCostLine[] = [];
    for (const line of args.costLines) {
      const spend = byLine[line.id ?? ''] ?? 0;
      if (spend <= 0) continue; // skip planned-but-untouched
      if (!line.budget_category_id) {
        uncategorized.push(line);
        continue;
      }
      const list = byCat.get(line.budget_category_id) ?? [];
      list.push(line);
      byCat.set(line.budget_category_id, list);
    }

    const hasCategories = args.categories.length > 0;

    if (!hasCategories) {
      // Flat fallback — no category metadata, just emit lines.
      for (const line of args.costLines) {
        const spend = byLine[line.id ?? ''] ?? 0;
        if (spend <= 0) continue;
        rows.push({
          title: line.label,
          body_md: line.notes,
          quantity: 1,
          unit_price_cents: spend,
          total_cents: spend,
          kind: 'work',
        });
      }
    } else {
      for (const cat of args.categories) {
        const lines = byCat.get(cat.id) ?? [];
        if (lines.length === 0) continue;
        const subtotal = lines.reduce((s, l) => s + (byLine[l.id ?? ''] ?? 0), 0);
        rows.push({
          title: cat.name,
          body_md: cat.description_md,
          quantity: 1,
          unit_price_cents: subtotal,
          total_cents: subtotal,
          kind: 'group_header',
        });
        for (const l of lines) {
          const spend = byLine[l.id ?? ''] ?? 0;
          rows.push({
            title: l.label,
            body_md: l.notes,
            quantity: 1,
            unit_price_cents: spend,
            total_cents: spend,
            kind: 'work',
          });
        }
      }
      if (uncategorized.length > 0) {
        const subtotal = uncategorized.reduce((s, l) => s + (byLine[l.id ?? ''] ?? 0), 0);
        rows.push({
          title: 'Other work',
          body_md: null,
          quantity: 1,
          unit_price_cents: subtotal,
          total_cents: subtotal,
          kind: 'group_header',
        });
        for (const l of uncategorized) {
          const spend = byLine[l.id ?? ''] ?? 0;
          rows.push({
            title: l.label,
            body_md: l.notes,
            quantity: 1,
            unit_price_cents: spend,
            total_cents: spend,
            kind: 'work',
          });
        }
      }
    }

    // Spend not tagged to any cost_line_id at all (key '').
    const untaggedCents = byLine[''] ?? 0;
    if (untaggedCents > 0) {
      rows.push({
        title: 'Other work',
        body_md: null,
        quantity: 1,
        unit_price_cents: untaggedCents,
        total_cents: untaggedCents,
        kind: 'work',
      });
    }
  } else {
    // No per-line data — fall back to lumped Labour / Materials.
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
  }
  if (breakdown.mgmtFeeCents > 0) {
    rows.push(mgmtFeeRow(args.mgmtRate, breakdown.mgmtFeeCents));
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
  // Use the same `section` text-col primitive as the operator's Budget tab.
  // When no category has a non-empty section value, degrade to one row per
  // category (same shape as Categories mode).
  const byCat = breakdown.byCategoryCents ?? {};
  const anySection = args.categories.some((c) => (c.section ?? '').trim() !== '');
  if (!anySection) {
    return buildCostPlusCategoriesRows(args, breakdown);
  }

  const catToSection = new Map<string, string>();
  for (const cat of args.categories) {
    catToSection.set(cat.id, (cat.section ?? '').trim());
  }

  const sectionOrder: string[] = [];
  const bySection = new Map<string, number>();
  let otherCents = byCat[''] ?? 0; // spend with no category → Other
  for (const cat of args.categories) {
    const amount = byCat[cat.id] ?? 0;
    if (amount <= 0) continue;
    const section = catToSection.get(cat.id) ?? '';
    const key = section === '' ? '' : section;
    if (key === '') {
      otherCents += amount;
      continue;
    }
    if (!bySection.has(key)) sectionOrder.push(key);
    bySection.set(key, (bySection.get(key) ?? 0) + amount);
  }

  const rows: Row[] = [];
  for (const key of sectionOrder) {
    const total = bySection.get(key) ?? 0;
    if (total <= 0) continue;
    rows.push({
      title: key,
      body_md: null,
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
