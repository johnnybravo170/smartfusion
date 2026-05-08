/**
 * Cost-plus billing math for `generateFinalInvoiceAction` (and anywhere
 * else we need the same numbers).
 *
 * Why this lives in its own module:
 *   1. The math has subtle Canadian-tax semantics (ITC reclaim, GST not
 *      part of the cost basis) that deserve their own tests, separate
 *      from the side-effecty server action.
 *   2. The action mixes Supabase fetches, RLS, validation, and formatting
 *      with the math itself. Pulling the pure piece out makes it testable
 *      without spinning up a fake Supabase.
 *
 * What it does NOT do: query, persist, or compute GST on the client
 * invoice. That's the caller's job (see `canadianTax.getCustomerFacingContext`).
 * This module just produces the pre-tax breakdown that the GST line at
 * the bottom of the invoice gets applied to.
 */

export type CostPlusExpense = {
  amount_cents: number;
  /**
   * Receipt subtotal before GST/HST/PST. The contractor's *real* cost.
   * Markup on cost-plus invoices is applied to this — not to
   * amount_cents — because the contractor reclaims the tax as an ITC.
   *
   * Null on legacy rows (pre-migration 0207) and on manual-entry
   * expenses with no receipt breakdown. Those rows fall back to
   * amount_cents (slight over-markup, matches pre-fix behaviour).
   */
  pre_tax_amount_cents: number | null;
};

export type CostPlusBreakdown = {
  /** Total labour billed (no markup applied). */
  labourCents: number;
  /** Materials/expenses line on the invoice — billed at PRE-TAX cost.
   *  The bottom-of-invoice GST line then applies once on the full
   *  subtotal, avoiding the GST-on-GST trap. */
  materialsCents: number;
  /** Management fee = (labour + materials_markup_base) × mgmtRate. */
  mgmtFeeCents: number;
  /** Cents already billed on prior draws — credited as a negative line. */
  priorBilledCents: number;
};

/**
 * Compute the cost-plus invoice line breakdown.
 *
 * Worked example (the bug Mike flagged):
 *   - One $113 receipt with $13 HST → pre_tax = $100
 *   - $0 labour, 20% mgmt fee, no prior invoices
 *   - materialsCents = 10000 (pre-tax — NOT the gross 11300)
 *   - mgmtFeeCents = round(10000 × 0.20) = 2000
 *   - subtotal = 12000, then GST line at the invoice level adds 13% on
 *     top → $1560. Client total: $135.60. Correct.
 *
 * Legacy expense (no pre_tax_amount_cents):
 *   - $113 amount_cents, null pre_tax → falls back to amount_cents
 *   - materialsCents = 11300, mgmtFeeCents = round(11300 × 0.20) = 2260
 *   - Slight over-markup vs. correct. Matches pre-fix behaviour for
 *     existing invoices, no regression on already-sent ones.
 */
export function computeCostPlusBreakdown(args: {
  timeEntries: ReadonlyArray<{ hours: number; hourly_rate_cents: number | null }>;
  expenses: ReadonlyArray<CostPlusExpense>;
  priorInvoices: ReadonlyArray<{ amount_cents: number }>;
  /** Decimal — e.g. 0.12 for 12%. */
  mgmtRate: number;
}): CostPlusBreakdown {
  const labourCents = args.timeEntries.reduce((s, t) => {
    const rate = t.hourly_rate_cents ?? 0;
    return s + Math.round(Number(t.hours) * rate);
  }, 0);

  // Materials line on the invoice = sum of contractor's REAL cost
  // (pre-tax when known, gross as fallback for legacy rows).
  const materialsCents = args.expenses.reduce(
    (s, e) => s + (e.pre_tax_amount_cents ?? e.amount_cents),
    0,
  );

  // Markup base matches the materials line — the contractor reclaims the
  // GST as an ITC, so it's not part of the cost basis the markup applies to.
  const mgmtFeeCents = Math.round((labourCents + materialsCents) * args.mgmtRate);

  const priorBilledCents = args.priorInvoices.reduce((s, i) => s + i.amount_cents, 0);

  return { labourCents, materialsCents, mgmtFeeCents, priorBilledCents };
}
