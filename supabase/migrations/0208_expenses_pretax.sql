-- 0207_expenses_pretax.sql
-- GST/HST split on receipts so cost-plus markup applies to the contractor's
-- *real cost* (the pre-tax amount), not the GST-inclusive total. The
-- contractor reclaims the GST as an ITC, so it's not their cost — and if
-- markup were applied to it, the client invoice would charge GST on GST
-- when tax_cents is added at the bottom.
--
-- We re-use the existing `expenses.tax_cents` column (added in 0101) for
-- the GST/HST portion. Only the pre-tax subtotal is new. Together they
-- form the breakdown: pre_tax_amount_cents + tax_cents = amount_cents
-- within ~1¢ rounding.
--
-- See `generateFinalInvoiceAction` (cost-plus fallback path) and
-- `extractReceiptFieldsAction`. Nullable: legacy rows pre-dating this
-- migration, and manual-entry expenses with no receipt, fall back to
-- `amount_cents` for the markup base. That preserves existing behaviour
-- for those rows (slight over-markup) until the manual-entry form gets
-- proper pre-tax/tax fields (separate card).
--
-- Discriminator for "do we have a trustworthy breakdown?" is
-- `pre_tax_amount_cents IS NOT NULL` — `tax_cents` cannot be used because
-- it defaults to 0 and we can't distinguish "no breakdown" from "zero
-- tax" with that column alone.

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS pre_tax_amount_cents BIGINT;

COMMENT ON COLUMN public.expenses.pre_tax_amount_cents IS
  'Receipt subtotal before GST/HST/PST, in cents. Set by OCR extraction (live single-receipt flow and bulk-import wizard) or future manual operator entry. NULL for legacy rows and manual-entry expenses without a tax breakdown — markup falls back to amount_cents in that case. When non-NULL, pre_tax_amount_cents + tax_cents should equal amount_cents within ~1¢ rounding.';
