/**
 * T4A vendor roll-up.
 *
 * Per CRA, a payer must issue a T4A slip to any non-employee service
 * provider they paid $500 or more in a calendar year. We roll up
 * `expenses.vendor` + `project_bills.vendor` grouped by a normalized
 * vendor key and surface the threshold flag.
 *
 * Caveats the bookkeeper needs to know:
 *   - Vendor is free-text in HeyHenry. We group by `lower(trim(vendor))`
 *     so "Home Depot" and "HOME DEPOT" aggregate; we can't catch
 *     "Home Depot" vs "The Home Depot" automatically — that's manual
 *     merge work for now.
 *   - Material suppliers (Home Depot, Rona) are technically subject to
 *     T4A for services but most contractors only issue slips for
 *     sub-trades. We show everyone over $500 and let the bookkeeper
 *     decide who actually gets a slip.
 *   - Credit card interest, bank fees, and other non-service payments
 *     still show up here. Future card: categorize vendors by "is this a
 *     T4A-eligible service" heuristic.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export type T4aVendorLine = {
  /** lower(trim(vendor)) — the grouping key. */
  key: string;
  /** Prettiest display string we saw for this vendor (most common casing). */
  display: string;
  /** Sum of amount_cents across expenses + bills. Pre-tax subtotal. */
  amount_cents: number;
  /** Count of transactions contributing to the total. */
  transaction_count: number;
  /** CRA T4A threshold for a calendar year: $500 = 50,000 cents. */
  over_threshold: boolean;
};

export type T4aReport = {
  year: number;
  total_cents: number;
  over_threshold_count: number;
  vendors: T4aVendorLine[];
};

const T4A_THRESHOLD_CENTS = 50_000; // $500.00

export async function getT4aReport(tenantId: string, year: number): Promise<T4aReport> {
  const admin = createAdminClient();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const [expensesRes, billsRes] = await Promise.all([
    admin
      .from('expenses')
      .select('vendor, amount_cents')
      .eq('tenant_id', tenantId)
      .gte('expense_date', yearStart)
      .lte('expense_date', yearEnd)
      .not('vendor', 'is', null),
    admin
      .from('project_bills')
      .select('vendor, amount_cents')
      .eq('tenant_id', tenantId)
      .gte('bill_date', yearStart)
      .lte('bill_date', yearEnd)
      .not('vendor', 'is', null),
  ]);

  if (expensesRes.error) throw new Error(`T4A: ${expensesRes.error.message}`);
  if (billsRes.error) throw new Error(`T4A: ${billsRes.error.message}`);

  type Bucket = {
    display: string;
    displayCounts: Map<string, number>;
    amount: number;
    count: number;
  };
  const byKey = new Map<string, Bucket>();

  const bump = (vendor: string | null, amount: number) => {
    if (!vendor) return;
    const trimmed = vendor.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    const existing = byKey.get(key) ?? {
      display: trimmed,
      displayCounts: new Map<string, number>(),
      amount: 0,
      count: 0,
    };
    existing.amount += amount;
    existing.count += 1;
    existing.displayCounts.set(trimmed, (existing.displayCounts.get(trimmed) ?? 0) + 1);
    byKey.set(key, existing);
  };

  for (const r of expensesRes.data ?? []) {
    bump(r.vendor as string | null, (r.amount_cents as number) ?? 0);
  }
  for (const r of billsRes.data ?? []) {
    bump(r.vendor as string | null, (r.amount_cents as number) ?? 0);
  }

  const vendors: T4aVendorLine[] = Array.from(byKey.entries())
    .map(([key, b]) => {
      // Pick the most common casing as the display form.
      let mostCommon = b.display;
      let maxCount = 0;
      for (const [form, c] of b.displayCounts) {
        if (c > maxCount) {
          mostCommon = form;
          maxCount = c;
        }
      }
      return {
        key,
        display: mostCommon,
        amount_cents: b.amount,
        transaction_count: b.count,
        over_threshold: b.amount >= T4A_THRESHOLD_CENTS,
      };
    })
    .sort((a, b) => b.amount_cents - a.amount_cents);

  const total = vendors.reduce((s, v) => s + v.amount_cents, 0);
  const overCount = vendors.filter((v) => v.over_threshold).length;

  return {
    year,
    total_cents: total,
    over_threshold_count: overCount,
    vendors,
  };
}
