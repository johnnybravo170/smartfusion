-- 0141_invoice_payment_receipts.sql
--
-- Manual record-payment metadata for invoices. When a GC marks an invoice
-- paid via cash/cheque/e-transfer/other, we capture:
--   * payment_reference        — cheque #, e-transfer confirmation, etc.
--   * payment_notes            — free-form note ("paid Tuesday, deposited Friday")
--   * payment_receipt_paths    — storage paths under the photos bucket for
--                                receipt photos (signed cheque, signed receipt,
--                                e-transfer screenshot). Tenant-scoped via the
--                                same RLS as 0020 — first path segment must
--                                match current_tenant_id().
--
-- Stored directly on the invoice row rather than a separate payments table
-- because invoices are paid in full in this product (no partial payments
-- planned for V1). If/when partial payments arrive, migrate to a child table.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS payment_reference TEXT,
  ADD COLUMN IF NOT EXISTS payment_notes TEXT,
  ADD COLUMN IF NOT EXISTS payment_receipt_paths TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.invoices.payment_reference IS 'Cheque #, e-transfer confirmation code, or other reference for manually-recorded payments.';
COMMENT ON COLUMN public.invoices.payment_notes IS 'Free-form notes captured at record-payment time.';
COMMENT ON COLUMN public.invoices.payment_receipt_paths IS 'Storage paths in the photos bucket for receipt images (cheque photo, signed receipt, e-transfer screenshot).';
