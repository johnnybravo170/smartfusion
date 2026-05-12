/**
 * Per-line spend rollup. Reads time entries, project costs, and PO line
 * items attached to a specific cost_line_id, and aggregates them into a
 * small summary + the transaction list.
 *
 * As of the cost-unification rollout, expenses + project_bills are read
 * from the unified `project_costs` table via the `source_type`
 * discriminator. Variance math is intentionally **byte-identical** to
 * the pre-unification implementation: receipts use the gross
 * `amount_cents`, vendor bills use `pre_tax_amount_cents` (which the
 * backfill copies verbatim from `project_bills.amount_cents`, the
 * pre-GST subtotal). The legacy implementation mixed these semantics;
 * unifying them is deferred to the UI-unification PR so this swap
 * doesn't shift any existing variance numbers.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export type CostLineActualsRow = {
  kind: 'labour' | 'expense' | 'bill' | 'po';
  id: string;
  label: string;
  sublabel?: string | null;
  amount_cents: number;
  /** Hours, only present for labour rows. */
  hours?: number;
  occurred_at: string;
};

export type CostLineActualsSummary = {
  total_cents: number;
  labour_hours: number;
  labour_cents: number;
  expenses_cents: number;
  bills_cents: number;
  po_cents: number;
  rows: CostLineActualsRow[];
};

const EMPTY: CostLineActualsSummary = {
  total_cents: 0,
  labour_hours: 0,
  labour_cents: 0,
  expenses_cents: 0,
  bills_cents: 0,
  po_cents: 0,
  rows: [],
};

type CostRow = {
  id: string;
  source_type: 'receipt' | 'vendor_bill';
  amount_cents: number;
  pre_tax_amount_cents: number | null;
  cost_date: string;
  vendor: string | null;
  description: string | null;
  cost_line_id?: string;
};

/**
 * Variance amount per row, matching pre-unification semantics:
 * receipts = gross `amount_cents`; vendor bills = `pre_tax_amount_cents`
 * (pre-GST) with a safe fallback to `amount_cents` for legacy rows that
 * predate migration 0083's GST split.
 */
function effectiveAmount(
  r: Pick<CostRow, 'source_type' | 'amount_cents' | 'pre_tax_amount_cents'>,
): number {
  if (r.source_type === 'vendor_bill') {
    return r.pre_tax_amount_cents ?? r.amount_cents;
  }
  return r.amount_cents;
}

export async function getCostLineActuals(costLineId: string): Promise<CostLineActualsSummary> {
  if (!costLineId) return EMPTY;
  const admin = createAdminClient();

  const [timeRes, costRes, poItemsRes] = await Promise.all([
    admin
      .from('time_entries')
      .select('id, hours, hourly_rate_cents, entry_date, notes, user_id')
      .eq('cost_line_id', costLineId)
      .order('entry_date', { ascending: false }),
    admin
      .from('project_costs')
      .select('id, source_type, amount_cents, pre_tax_amount_cents, cost_date, vendor, description')
      .eq('cost_line_id', costLineId)
      .eq('status', 'active')
      .order('cost_date', { ascending: false }),
    admin
      .from('purchase_order_items')
      .select(
        'id, label, qty, unit, line_total_cents, created_at, purchase_orders:po_id (vendor, status)',
      )
      .eq('cost_line_id', costLineId)
      .order('created_at', { ascending: false }),
  ]);

  type TimeRow = {
    id: string;
    hours: number;
    hourly_rate_cents: number | null;
    entry_date: string;
    notes: string | null;
    user_id: string | null;
  };
  type PoItemRow = {
    id: string;
    label: string | null;
    qty: number | null;
    unit: string | null;
    line_total_cents: number;
    created_at: string;
    purchase_orders:
      | { vendor: string | null; status: string }
      | { vendor: string | null; status: string }[]
      | null;
  };

  const timeRows = (timeRes.data ?? []) as TimeRow[];
  const costRows = (costRes.data ?? []) as CostRow[];
  const poItemRows = (poItemsRes.data ?? []) as PoItemRow[];

  const rows: CostLineActualsRow[] = [];
  let labourHours = 0;
  let labourCents = 0;
  for (const t of timeRows) {
    const cents = Math.round((t.hours ?? 0) * (t.hourly_rate_cents ?? 0));
    labourHours += t.hours ?? 0;
    labourCents += cents;
    rows.push({
      kind: 'labour',
      id: t.id,
      label: `${t.hours} hrs`,
      sublabel: t.notes ?? null,
      amount_cents: cents,
      hours: t.hours,
      occurred_at: t.entry_date,
    });
  }

  let expensesCents = 0;
  let billsCents = 0;
  for (const c of costRows) {
    const amount = effectiveAmount(c);
    if (c.source_type === 'vendor_bill') {
      billsCents += amount;
      rows.push({
        kind: 'bill',
        id: c.id,
        label: c.vendor ?? 'Bill',
        sublabel: c.description ?? null,
        amount_cents: amount,
        occurred_at: c.cost_date,
      });
    } else {
      expensesCents += amount;
      rows.push({
        kind: 'expense',
        id: c.id,
        label: c.vendor ?? 'Expense',
        sublabel: c.description ?? null,
        amount_cents: amount,
        occurred_at: c.cost_date,
      });
    }
  }

  let poCents = 0;
  for (const p of poItemRows) {
    poCents += p.line_total_cents;
    const po = Array.isArray(p.purchase_orders) ? p.purchase_orders[0] : p.purchase_orders;
    rows.push({
      kind: 'po',
      id: p.id,
      label: po?.vendor ? `${po.vendor} · ${p.label ?? 'PO line'}` : (p.label ?? 'PO line'),
      sublabel: po?.status ? `PO ${po.status}` : null,
      amount_cents: p.line_total_cents,
      occurred_at: p.created_at,
    });
  }

  rows.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));

  return {
    total_cents: labourCents + expensesCents + billsCents + poCents,
    labour_hours: labourHours,
    labour_cents: labourCents,
    expenses_cents: expensesCents,
    bills_cents: billsCents,
    po_cents: poCents,
    rows,
  };
}

/**
 * Project-wide variant: same shape as `getCostLineActuals` but returns
 * a Map keyed by `cost_line_id`. Used by the Budget tab so the page
 * pre-fetches every line's actuals in a single round-trip rather than
 * one fetch per expand. Cost lines with no actuals don't appear in the
 * map; consumers should default to `EMPTY` for missing keys.
 */
export async function getCostLineActualsByProject(
  projectId: string,
): Promise<Map<string, CostLineActualsSummary>> {
  const result = new Map<string, CostLineActualsSummary>();
  if (!projectId) return result;
  const admin = createAdminClient();

  const [timeRes, costRes, poItemsRes] = await Promise.all([
    admin
      .from('time_entries')
      .select('id, hours, hourly_rate_cents, entry_date, notes, cost_line_id')
      .eq('project_id', projectId)
      .not('cost_line_id', 'is', null)
      .order('entry_date', { ascending: false }),
    admin
      .from('project_costs')
      .select(
        'id, source_type, amount_cents, pre_tax_amount_cents, cost_date, vendor, description, cost_line_id',
      )
      .eq('project_id', projectId)
      .eq('status', 'active')
      .not('cost_line_id', 'is', null)
      .order('cost_date', { ascending: false }),
    admin
      .from('purchase_order_items')
      .select(
        'id, label, qty, unit, line_total_cents, created_at, cost_line_id, purchase_orders!inner(vendor, status, project_id)',
      )
      .eq('purchase_orders.project_id', projectId)
      .not('cost_line_id', 'is', null)
      .order('created_at', { ascending: false }),
  ]);

  function bucket(costLineId: string): CostLineActualsSummary {
    let s = result.get(costLineId);
    if (!s) {
      s = {
        total_cents: 0,
        labour_hours: 0,
        labour_cents: 0,
        expenses_cents: 0,
        bills_cents: 0,
        po_cents: 0,
        rows: [],
      };
      result.set(costLineId, s);
    }
    return s;
  }

  for (const t of (timeRes.data ?? []) as Array<{
    id: string;
    hours: number;
    hourly_rate_cents: number | null;
    entry_date: string;
    notes: string | null;
    cost_line_id: string;
  }>) {
    const s = bucket(t.cost_line_id);
    const cents = Math.round((t.hours ?? 0) * (t.hourly_rate_cents ?? 0));
    s.labour_hours += t.hours ?? 0;
    s.labour_cents += cents;
    s.total_cents += cents;
    s.rows.push({
      kind: 'labour',
      id: t.id,
      label: `${t.hours} hrs`,
      sublabel: t.notes ?? null,
      amount_cents: cents,
      hours: t.hours,
      occurred_at: t.entry_date,
    });
  }

  for (const c of (costRes.data ?? []) as Array<CostRow & { cost_line_id: string }>) {
    const s = bucket(c.cost_line_id);
    const amount = effectiveAmount(c);
    if (c.source_type === 'vendor_bill') {
      s.bills_cents += amount;
      s.total_cents += amount;
      s.rows.push({
        kind: 'bill',
        id: c.id,
        label: c.vendor ?? 'Bill',
        sublabel: c.description ?? null,
        amount_cents: amount,
        occurred_at: c.cost_date,
      });
    } else {
      s.expenses_cents += amount;
      s.total_cents += amount;
      s.rows.push({
        kind: 'expense',
        id: c.id,
        label: c.vendor ?? 'Expense',
        sublabel: c.description ?? null,
        amount_cents: amount,
        occurred_at: c.cost_date,
      });
    }
  }

  for (const p of (poItemsRes.data ?? []) as Array<{
    id: string;
    label: string | null;
    qty: number | null;
    unit: string | null;
    line_total_cents: number;
    created_at: string;
    cost_line_id: string;
    purchase_orders:
      | { vendor: string | null; status: string }
      | { vendor: string | null; status: string }[]
      | null;
  }>) {
    const s = bucket(p.cost_line_id);
    s.po_cents += p.line_total_cents;
    s.total_cents += p.line_total_cents;
    const po = Array.isArray(p.purchase_orders) ? p.purchase_orders[0] : p.purchase_orders;
    s.rows.push({
      kind: 'po',
      id: p.id,
      label: po?.vendor ? `${po.vendor} · ${p.label ?? 'PO line'}` : (p.label ?? 'PO line'),
      sublabel: po?.status ? `PO ${po.status}` : null,
      amount_cents: p.line_total_cents,
      occurred_at: p.created_at,
    });
  }

  // Sort each bucket's rows newest-first.
  for (const s of result.values()) {
    s.rows.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  }

  return result;
}
