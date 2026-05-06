-- ============================================================
-- Per-invoice override of the three customer-facing doc fields.
--
-- Tenant defaults shipped in 0184. Most invoices use them as-is, but
-- some need a one-off variation (special payment arrangement, alternate
-- payee, custom warranty for a single job). When a column on this row
-- is non-null, it wins over the tenant default at render time.
--
-- Resolution helper:
-- src/lib/invoices/default-doc-fields.ts → resolveInvoiceDocFields().
-- ============================================================

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS payment_instructions_override text,
  ADD COLUMN IF NOT EXISTS terms_override text,
  ADD COLUMN IF NOT EXISTS policies_override text;

COMMENT ON COLUMN public.invoices.payment_instructions_override IS
  'Per-invoice override of tenants.invoice_payment_instructions. Non-null wins at render time. Plain text.';
COMMENT ON COLUMN public.invoices.terms_override IS
  'Per-invoice override of tenants.invoice_terms. Non-null wins at render time. Plain text.';
COMMENT ON COLUMN public.invoices.policies_override IS
  'Per-invoice override of tenants.invoice_policies. Non-null wins at render time. Plain text.';
