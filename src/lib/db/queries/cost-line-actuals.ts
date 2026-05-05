/**
 * Per-line spend rollup. Reads time entries, expenses, bills, and PO
 * line items that have been attached to a specific cost_line_id, and
 * aggregates them into a small summary + the transaction list.
 *
 * Migration 0166 added `cost_line_id` (nullable) to time_entries,
 * expenses, and project_bills. PO line items already had it. So the
 * data model now supports line-level drill on every spend type.
 *
 * Existing rows have NULL cost_line_id (only attached at the category
 * level). Going forward, operators can assign a line when categorising
 * a new bill/expense/time entry — the form-side UX is a separate card.
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

export async function getCostLineActuals(costLineId: string): Promise<CostLineActualsSummary> {
  if (!costLineId) return EMPTY;
  const admin = createAdminClient();

  const [timeRes, expensesRes, billsRes, poItemsRes] = await Promise.all([
    admin
      .from('time_entries')
      .select('id, hours, hourly_rate_cents, entry_date, notes, user_id')
      .eq('cost_line_id', costLineId)
      .order('entry_date', { ascending: false }),
    admin
      .from('expenses')
      .select('id, amount_cents, expense_date, vendor, description')
      .eq('cost_line_id', costLineId)
      .order('expense_date', { ascending: false }),
    admin
      .from('project_bills')
      .select('id, amount_cents, bill_date, vendor, notes')
      .eq('cost_line_id', costLineId)
      .order('bill_date', { ascending: false }),
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
  type ExpenseRow = {
    id: string;
    amount_cents: number;
    expense_date: string;
    vendor: string | null;
    description: string | null;
  };
  type BillRow = {
    id: string;
    amount_cents: number;
    bill_date: string;
    vendor: string | null;
    notes: string | null;
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
  const expenseRows = (expensesRes.data ?? []) as ExpenseRow[];
  const billRows = (billsRes.data ?? []) as BillRow[];
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
  for (const e of expenseRows) {
    expensesCents += e.amount_cents;
    rows.push({
      kind: 'expense',
      id: e.id,
      label: e.vendor ?? 'Expense',
      sublabel: e.description ?? null,
      amount_cents: e.amount_cents,
      occurred_at: e.expense_date,
    });
  }

  let billsCents = 0;
  for (const b of billRows) {
    billsCents += b.amount_cents;
    rows.push({
      kind: 'bill',
      id: b.id,
      label: b.vendor ?? 'Bill',
      sublabel: b.notes ?? null,
      amount_cents: b.amount_cents,
      occurred_at: b.bill_date,
    });
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

  const [timeRes, expensesRes, billsRes, poItemsRes] = await Promise.all([
    admin
      .from('time_entries')
      .select('id, hours, hourly_rate_cents, entry_date, notes, cost_line_id')
      .eq('project_id', projectId)
      .not('cost_line_id', 'is', null)
      .order('entry_date', { ascending: false }),
    admin
      .from('expenses')
      .select('id, amount_cents, expense_date, vendor, description, cost_line_id')
      .eq('project_id', projectId)
      .not('cost_line_id', 'is', null)
      .order('expense_date', { ascending: false }),
    admin
      .from('project_bills')
      .select('id, amount_cents, bill_date, vendor, notes, cost_line_id')
      .eq('project_id', projectId)
      .not('cost_line_id', 'is', null)
      .order('bill_date', { ascending: false }),
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

  for (const e of (expensesRes.data ?? []) as Array<{
    id: string;
    amount_cents: number;
    expense_date: string;
    vendor: string | null;
    description: string | null;
    cost_line_id: string;
  }>) {
    const s = bucket(e.cost_line_id);
    s.expenses_cents += e.amount_cents;
    s.total_cents += e.amount_cents;
    s.rows.push({
      kind: 'expense',
      id: e.id,
      label: e.vendor ?? 'Expense',
      sublabel: e.description ?? null,
      amount_cents: e.amount_cents,
      occurred_at: e.expense_date,
    });
  }

  for (const b of (billsRes.data ?? []) as Array<{
    id: string;
    amount_cents: number;
    bill_date: string;
    vendor: string | null;
    notes: string | null;
    cost_line_id: string;
  }>) {
    const s = bucket(b.cost_line_id);
    s.bills_cents += b.amount_cents;
    s.total_cents += b.amount_cents;
    s.rows.push({
      kind: 'bill',
      id: b.id,
      label: b.vendor ?? 'Bill',
      sublabel: b.notes ?? null,
      amount_cents: b.amount_cents,
      occurred_at: b.bill_date,
    });
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
