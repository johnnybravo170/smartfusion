-- 0153_invoices_tax_inclusive
--
-- Operator types ONE total when issuing a draw, and that total is what
-- the customer pays. GST is back-computed for ITC tracking + customer
-- transparency, not added on top. Today's invoice flow adds tax to the
-- entered amount; that's wrong for draws.
--
-- This adds a per-row `tax_inclusive` flag. When true (default for new
-- draws), `amount_cents` is the total-including-tax and `tax_cents` is
-- the back-computed portion. When false (default for invoices), the
-- existing add-tax-on-top semantics apply.

BEGIN;

ALTER TABLE public.invoices
  ADD COLUMN tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.invoices.tax_inclusive IS
  'When TRUE (typical for draws): amount_cents is the inclusive total customer pays; tax_cents is back-computed from amount_cents and the GST rate. When FALSE (typical for invoices): amount_cents is the subtotal; tax_cents is added on top.';

COMMIT;
