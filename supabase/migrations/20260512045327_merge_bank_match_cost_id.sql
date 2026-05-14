-- Bank-recon cleanup after cost unification. Merges the two cost-side
-- match columns into a single `matched_cost_id` with a real FK to
-- `project_costs`, replacing the structurally-dangling pair that PR #8
-- left behind when it dropped `expenses` + `project_bills`.
--
-- Before: `matched_expense_id UUID REFERENCES expenses(id)`
--         `matched_bill_id    UUID REFERENCES project_bills(id)`
--         Both lost their FKs when the parent tables were dropped.
-- After:  `matched_cost_id    UUID REFERENCES project_costs(id) ON DELETE SET NULL`
--         One column, one referential integrity anchor. The
--         receipt-vs-vendor-bill distinction lives on `project_costs.source_type`
--         where the rest of the cost surface reads it.
--
-- `matched_invoice_id` stays — invoices are a separate concept (money
-- coming in vs going out) and its FK still points at a live table.
--
-- Prod safety: queried bank_transactions pre-merge and both columns
-- held 0 non-null values, so the coalesce backfill is a no-op on prod
-- but kept for any environment where matches existed.

-- 1. New column + FK.
ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS matched_cost_id UUID
    REFERENCES public.project_costs(id) ON DELETE SET NULL;

-- 2. Coalesce existing matches into the new column. Bills + expenses
--    can never co-exist on the same row (old one-match CHECK
--    constraint), so a straight COALESCE is correct.
UPDATE public.bank_transactions
   SET matched_cost_id = COALESCE(matched_expense_id, matched_bill_id)
 WHERE matched_cost_id IS NULL
   AND (matched_expense_id IS NOT NULL OR matched_bill_id IS NOT NULL);

-- 3. Drop the old one-match CHECK so we can rebuild it against the
--    merged column before dropping the old columns themselves.
ALTER TABLE public.bank_transactions
  DROP CONSTRAINT IF EXISTS bank_transactions_one_match;

-- 4. Rebuild the one-match guard. A bank txn can match at most one
--    of (invoice, cost). Same semantic as before, fewer columns.
ALTER TABLE public.bank_transactions
  ADD CONSTRAINT bank_transactions_one_match CHECK (
    (CASE WHEN matched_invoice_id IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN matched_cost_id    IS NOT NULL THEN 1 ELSE 0 END)
    <= 1
  );

-- 5. Match-target lookup index — "show me the bank txn that
--    reconciled this cost row" on the cost detail page.
CREATE INDEX IF NOT EXISTS idx_bank_transactions_cost
  ON public.bank_transactions (matched_cost_id)
  WHERE matched_cost_id IS NOT NULL;

-- 6. Drop the legacy columns + their partial indexes.
DROP INDEX IF EXISTS public.idx_bank_transactions_expense;
DROP INDEX IF EXISTS public.idx_bank_transactions_bill;

ALTER TABLE public.bank_transactions
  DROP COLUMN IF EXISTS matched_expense_id,
  DROP COLUMN IF EXISTS matched_bill_id;
