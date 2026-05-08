/**
 * Split a GST/HST-inclusive total into pre-tax + tax components, given
 * the tenant's effective tax rate.
 *
 * Why a sync helper instead of `canadianTax.extractTax` (which already
 * does this server-side): the expense forms need to auto-split on every
 * blur of the Total field. A server round-trip per blur would be
 * sluggish. The form takes the rate as a prop at render time and runs
 * the split locally.
 *
 * Math mirrors `canadianTax.extractTax`:
 *   subtotal = round(total / (1 + rate))
 *   tax      = total - subtotal
 *
 * Single-tax-line shape — we don't reproduce the multi-line breakdown
 * (GST + PST split etc.) because the expense form only persists one
 * `tax_cents` value. Province-level breakdown is reconstructed at the
 * invoice level via the same provider when needed.
 */

export type TaxSplit = {
  preTaxCents: number;
  taxCents: number;
};

/**
 * @param totalCents - tax-inclusive grand total
 * @param rate - decimal (0.05, 0.12, 0.13, 0.15) — the tenant's effective rate
 */
export function splitTotalByRate(totalCents: number, rate: number): TaxSplit {
  if (!Number.isFinite(totalCents) || totalCents <= 0) {
    return { preTaxCents: 0, taxCents: 0 };
  }
  if (rate <= 0) {
    // No tax configured (rare, but possible — e.g. tenant in a no-tax
    // jurisdiction). Pass through as fully pre-tax.
    return { preTaxCents: totalCents, taxCents: 0 };
  }
  const preTaxCents = Math.round(totalCents / (1 + rate));
  const taxCents = totalCents - preTaxCents;
  return { preTaxCents, taxCents };
}
