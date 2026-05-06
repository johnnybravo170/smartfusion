-- 0188_expenses_import_batch.sql
-- Phase D of the onboarding-import wizard. Bulk receipt import → one
-- expense per receipt, all tagged with import_batch_id for audit and
-- rollback.
--
-- Receipt files themselves go in the existing `receipts` storage
-- bucket (same one the live single-receipt flow uses), so no new
-- bucket here. The import wizard archives each receipt under
-- {tenant_id}/{user_id}/{uuid}.{ext} matching that flow's convention.

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS import_batch_id UUID
    REFERENCES public.import_batches (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_import_batch
  ON public.expenses (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

COMMENT ON COLUMN public.expenses.import_batch_id IS
  'Set when the expense was created via the bulk-receipt import wizard. NULL for hand-entered expenses. amount_cents + tax_cents + expense_date are FROZEN at the OCR-extracted (or operator-edited) values — same contract as imported invoices.';
