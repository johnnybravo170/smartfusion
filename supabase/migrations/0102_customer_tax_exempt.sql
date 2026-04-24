-- Customer tax-exempt flag.
--
-- Some customers legitimately don't pay GST/HST: other GST-registered
-- contractors (usually B2B with their own GST number), non-profits with
-- charitable status, First Nations with status cards, and some
-- government bodies. Setting this flag zero-rates the customer's
-- invoices + estimates from the tax calculation path.
--
-- Defaults to FALSE so every existing customer keeps being taxed.

BEGIN;

ALTER TABLE public.customers
  ADD COLUMN tax_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN tax_exempt_reason TEXT;

COMMIT;
