-- 0187_invoices_import_batch.sql
-- Phase C of the onboarding-import wizard. Invoices come in with their
-- historical money math FROZEN — amount_cents and tax_cents land
-- exactly as the contractor recorded them in the source, NOT recomputed
-- against today's customer-facing tax rate. This matters because:
--
--   - 2024 BC invoices were charged 5% GST. The current customer-facing
--     helper (canadianTax.getCustomerFacingContext) returns 5% today
--     too — so they'd round-trip cleanly. But if the contractor was on
--     a different province in 2024, or the federal rate had changed,
--     re-deriving the tax would silently rewrite history.
--   - Imported invoices may pre-date the system entirely. They have NO
--     project linkage and may have NO line item breakdown — just a
--     subtotal + tax + total + customer + date. The schema already
--     supports that shape (amount_cents + tax_cents + line_items=[]).
--
-- import_batch_id is the audit + rollback signal. Any code path that
-- considers re-deriving an invoice's tax must check `import_batch_id IS
-- NOT NULL` and skip — that's the contract. (No DB-level enforcement;
-- code-level discipline backed by PATTERNS.md §16.)

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS import_batch_id UUID
    REFERENCES public.import_batches (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_import_batch
  ON public.invoices (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

COMMENT ON COLUMN public.invoices.import_batch_id IS
  'Set when the invoice was created via the import wizard. NULL for invoices created in the app. amount_cents + tax_cents on imported rows are FROZEN at the historical values from the source — do not recompute against current tax rates.';
