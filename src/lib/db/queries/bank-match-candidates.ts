/**
 * Fetches the matchable pool (unpaid invoices + expenses + unpaid bills)
 * for the auto-match engine. Tenant-scoped via RLS — caller must already
 * be acting as the tenant via the Supabase server client.
 *
 * Constraints (keep this query cheap; called on every statement import):
 *   - Window: only candidates whose date is within ±30 days of the
 *     statement date range. Stops the pool exploding on a busy tenant.
 *   - Caps: 500 of each kind. If we hit that on a real customer, we'll
 *     paginate or narrow the date window further.
 */

import type {
  MatchableBill,
  MatchableExpense,
  MatchableInvoice,
  MatchPool,
} from '@/lib/bank-recon/matcher';
import { invoiceTotalCents } from '@/lib/db/queries/invoices';
import { createClient } from '@/lib/supabase/server';

const HARD_CAP = 500;
const DATE_WINDOW_DAYS = 30;

export type MatchPoolWindow = {
  /** Earliest bank transaction date in the import. */
  min_date: string;
  /** Latest bank transaction date in the import. */
  max_date: string;
};

export async function getMatchPool(window: MatchPoolWindow): Promise<MatchPool> {
  const supabase = await createClient();
  const start = shiftIso(window.min_date, -DATE_WINDOW_DAYS);
  const end = shiftIso(window.max_date, DATE_WINDOW_DAYS);

  const [invoiceRes, expenseRes, billRes] = await Promise.all([
    supabase
      .from('invoices')
      .select(
        'id, amount_cents, tax_cents, tax_inclusive, line_items, sent_at, created_at, customer:customers(name)',
      )
      .eq('status', 'sent')
      .is('paid_at', null)
      .is('deleted_at', null)
      .or(`sent_at.gte.${start},and(sent_at.is.null,created_at.gte.${start}T00:00:00Z)`)
      .lte('created_at', `${end}T23:59:59Z`)
      .limit(HARD_CAP),
    supabase
      .from('expenses')
      .select('id, amount_cents, expense_date, vendor, description')
      .gte('expense_date', start)
      .lte('expense_date', end)
      .limit(HARD_CAP),
    supabase
      .from('project_bills')
      .select('id, amount_cents, bill_date, vendor, description')
      .in('status', ['pending', 'approved'])
      .gte('bill_date', start)
      .lte('bill_date', end)
      .limit(HARD_CAP),
  ]);

  if (invoiceRes.error) throw new Error(`Invoice fetch failed: ${invoiceRes.error.message}`);
  if (expenseRes.error) throw new Error(`Expense fetch failed: ${expenseRes.error.message}`);
  if (billRes.error) throw new Error(`Bill fetch failed: ${billRes.error.message}`);

  const invoices: MatchableInvoice[] = (invoiceRes.data ?? []).map((r) => ({
    id: r.id as string,
    amount_cents: invoiceTotalCents({
      amount_cents: r.amount_cents as number | null,
      tax_cents: r.tax_cents as number | null,
      tax_inclusive: r.tax_inclusive as boolean | null,
    }),
    sent_at: (r.sent_at as string | null) ?? null,
    created_at: r.created_at as string,
    customer_name: customerName(r.customer),
  }));

  const expenses: MatchableExpense[] = (expenseRes.data ?? []).map((r) => ({
    id: r.id as string,
    amount_cents: r.amount_cents as number,
    expense_date: r.expense_date as string,
    vendor: (r.vendor as string | null) ?? null,
    description: (r.description as string | null) ?? null,
  }));

  const bills: MatchableBill[] = (billRes.data ?? []).map((r) => ({
    id: r.id as string,
    amount_cents: r.amount_cents as number,
    bill_date: r.bill_date as string,
    vendor: r.vendor as string,
    description: (r.description as string | null) ?? null,
  }));

  return { invoices, expenses, bills };
}

function customerName(rel: unknown): string | null {
  if (!rel) return null;
  // Supabase returns the joined relation as { name } | null (singular)
  // with `.select('customer:customers(name)')`.
  if (Array.isArray(rel)) {
    return (rel[0] as { name?: string } | undefined)?.name ?? null;
  }
  return (rel as { name?: string }).name ?? null;
}

function shiftIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
