-- ============================================================
-- Tenant-level default text for invoices & draws.
--
-- Three fields surfaced on every customer-facing invoice/draw email
-- and the public view (/view/invoice/[id]):
--   - payment_instructions: how to pay (e-transfer, cheque, etc.)
--   - terms:                payment terms (when due, methods accepted)
--   - policies:             late fees, returns, dispute, warranty
--
-- All three are nullable; a separate Settings → Invoicing page lets the
-- operator fill them in. When any are blank, the operator invoice detail
-- page shows an inline setup banner that opens a dialog to fill them
-- without leaving the invoice flow (writes back to these tenant defaults).
--
-- Per-invoice override (one-off variation for a specific invoice) is
-- intentionally deferred to a follow-up migration — most invoices use
-- the same text, and shipping the 80% solution first keeps the surface
-- small.
-- ============================================================

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS invoice_payment_instructions text,
  ADD COLUMN IF NOT EXISTS invoice_terms text,
  ADD COLUMN IF NOT EXISTS invoice_policies text;

COMMENT ON COLUMN public.tenants.invoice_payment_instructions IS
  'How customers pay this tenant (e-transfer, cheque, etc.). Rendered on invoice/draw emails and the public view. Plain text, line breaks preserved.';
COMMENT ON COLUMN public.tenants.invoice_terms IS
  'Payment terms (e.g. "Due within 30 days"). Rendered on invoice/draw emails and the public view. Plain text.';
COMMENT ON COLUMN public.tenants.invoice_policies IS
  'Late fees, returns, dispute, warranty policies. Rendered on invoice/draw emails and the public view. Plain text.';
