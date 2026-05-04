/**
 * Customer-facing invoice total — pure helper, no server-only imports.
 *
 * Lives outside `db/queries/invoices.ts` so client components can import
 * it without dragging `next/headers` (via `supabase/server`) into the
 * client bundle.
 */
export function invoiceTotalCents(row: {
  amount_cents: number | null | undefined;
  tax_cents: number | null | undefined;
  tax_inclusive?: boolean | null | undefined;
}): number {
  const amount = row.amount_cents ?? 0;
  const tax = row.tax_cents ?? 0;
  return row.tax_inclusive ? amount : amount + tax;
}
