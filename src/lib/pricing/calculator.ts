/**
 * Pure pricing functions for the quoting engine.
 *
 * Zero framework imports. These are deterministic functions that take data in
 * and return numbers out. All monetary values are in cents (integers) to avoid
 * floating-point drift.
 *
 * Source of truth is `catalog_items` (the unified pricebook). The legacy
 * sqft-only `service_catalog` table is gone — the map-based quote builder
 * filters catalog_items by `surface_type` + `pricing_model='per_unit'`.
 */

export type SurfaceInput = {
  surface_type: string;
  sqft: number;
};

/**
 * Catalog row shape consumed by the pricing math. Sub-typed loosely so
 * callers can pass `CatalogItemRow` directly without massaging fields.
 */
export type CatalogEntry = {
  pricing_model: 'fixed' | 'per_unit' | 'hourly' | 'time_and_materials';
  unit_price_cents: number | null;
  min_charge_cents: number | null;
  unit_label?: string | null;
};

/**
 * Calculate the price for a single surface on a map-based quote.
 *
 * The map builder only produces `per_unit`/`sqft` items today — any other
 * pricing model on the catalog entry passed in is treated as a programming
 * error (the quote builder is supposed to filter those out before calling
 * this). Pricing is `max(sqft * rate, min_charge)`.
 */
export function calculateSurfacePrice(surface: SurfaceInput, catalog: CatalogEntry): number {
  if (catalog.pricing_model !== 'per_unit') {
    throw new Error(
      `calculateSurfacePrice expects pricing_model='per_unit', got '${catalog.pricing_model}'. The map quote builder must filter catalog items before pricing.`,
    );
  }
  const unitPrice = catalog.unit_price_cents ?? 0;
  const minCharge = catalog.min_charge_cents ?? 0;
  const computed = Math.round(surface.sqft * unitPrice);
  return Math.max(computed, minCharge);
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
