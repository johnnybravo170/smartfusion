/**
 * Pure pricing functions for the quoting engine.
 *
 * Zero framework imports. These are deterministic functions that take data in
 * and return numbers out. All monetary values are in cents (integers) to avoid
 * floating-point drift.
 */

export type SurfaceInput = {
  surface_type: string;
  sqft: number;
};

export type CatalogEntry = {
  surface_type: string;
  price_per_sqft_cents: number;
  min_charge_cents: number;
};

/**
 * Calculate the price for a single surface. The price is the greater of
 * (sqft * rate) or the minimum charge for that surface type.
 */
export function calculateSurfacePrice(surface: SurfaceInput, catalog: CatalogEntry): number {
  const computed = Math.round(surface.sqft * catalog.price_per_sqft_cents);
  return Math.max(computed, catalog.min_charge_cents);
}

/**
 * Roll up surface prices into a quote total with tax.
 *
 * @param surfaces - Array of priced surfaces (each has `price_cents`).
 * @param taxRate  - Decimal tax rate, e.g. 0.05 for 5% GST.
 */
export function calculateQuoteTotal(
  surfaces: { price_cents: number }[],
  taxRate: number,
): { subtotal_cents: number; tax_cents: number; total_cents: number } {
  const subtotal_cents = surfaces.reduce((sum, s) => sum + s.price_cents, 0);
  const tax_cents = Math.round(subtotal_cents * taxRate);
  return { subtotal_cents, tax_cents, total_cents: subtotal_cents + tax_cents };
}

export type Currency = 'CAD' | 'USD';

/** Intl locale paired with each currency. */
function localeFor(currency: Currency): string {
  return currency === 'USD' ? 'en-US' : 'en-CA';
}

/**
 * Format cents as a currency string. Currency defaults to CAD because
 * every existing call site is Canadian — migrate to pass tenant currency
 * when the surface is USD-capable (invoices, estimates, expenses, etc.
 * for US tenants).
 */
export function formatCurrency(cents: number, currency: Currency = 'CAD'): string {
  return new Intl.NumberFormat(localeFor(currency), {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

/**
 * Compact currency format: drops trailing .00 on whole-dollar amounts
 * (e.g. $1,234.56 stays, $5,000.00 becomes $5,000). Use in dense tables
 * where the extra three chars per cell cause collisions.
 */
export function formatCurrencyCompact(cents: number, currency: Currency = 'CAD'): string {
  const dollars = cents / 100;
  const isWhole = Math.abs(cents % 100) === 0;
  return new Intl.NumberFormat(localeFor(currency), {
    style: 'currency',
    currency,
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: isWhole ? 0 : 2,
  }).format(dollars);
}
