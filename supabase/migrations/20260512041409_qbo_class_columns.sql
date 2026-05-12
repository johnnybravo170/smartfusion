-- QBO Class denormalized onto expenses + bills for project mapping.
--
-- QBO Class is the bookkeeper's standard way to job-cost. Lines carry
-- the class ref (and bill_line_items already captures it via
-- qbo_class_id), but for the "map this QBO class to this HH project"
-- UI we need it on the parent record too — so the rollup query is a
-- simple GROUP BY without a join.
--
-- We store both the QBO id and the display name. The name is what the
-- user sees in the mapping UI; the id is the join key for back-pointing
-- to QBO if needed. Bill rollup uses the header's class; for
-- multi-class bills we just take the first line's class. That covers
-- the 99% case where a bill is single-purpose ("Smith Kitchen Reno").

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS qbo_class_id   TEXT,
  ADD COLUMN IF NOT EXISTS qbo_class_name TEXT;

ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS qbo_class_id   TEXT,
  ADD COLUMN IF NOT EXISTS qbo_class_name TEXT;

-- Indexes for the "extract distinct classes" rollup query and for
-- the bulk UPDATE that backfills project_id once the user picks a
-- mapping. Partial indexes so we don't bloat for tenants who never
-- use QBO Class.
CREATE INDEX IF NOT EXISTS idx_expenses_qbo_class
  ON public.expenses (tenant_id, qbo_class_name)
  WHERE qbo_class_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bills_qbo_class
  ON public.bills (tenant_id, qbo_class_name)
  WHERE qbo_class_name IS NOT NULL;
