-- Period close flag for bookkeeping.
--
-- Once a quarter is filed with CRA, the bookkeeper wants assurance the
-- operator can't retroactively edit/delete expenses in that period
-- (which would throw off an already-submitted return).
--
-- Single-date design: `books_closed_through` is the last locked day.
-- Expenses, bills, and invoices with their dating field <= this value
-- can't be mutated. Setting NULL (or earlier) unlocks.
--
-- Server actions enforce the guard; no trigger. Trigger-based enforcement
-- would also block legitimate admin cleanup and make the unlock flow
-- awkward. Application-level matches the other soft guardrails in the
-- codebase (soft-delete, manual-approval overrides, etc).

BEGIN;

ALTER TABLE public.tenants
  ADD COLUMN books_closed_through DATE;

COMMENT ON COLUMN public.tenants.books_closed_through IS
  'Last date (inclusive) where the books are locked. Expense/bill/invoice rows with dating <= this value cannot be edited or deleted. NULL = no close in effect.';

COMMIT;
