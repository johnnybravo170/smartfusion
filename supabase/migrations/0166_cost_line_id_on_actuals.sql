-- 0166_cost_line_id_on_actuals.sql
-- Add `cost_line_id` to time_entries, expenses, and project_bills so
-- actuals can be tracked at the line-item level — not just per bucket.
--
-- Today only `purchase_order_items` carries a cost_line FK. That makes
-- "what's been spent on the 'Tile install' line specifically?" a
-- partial answer at best — bills, expenses, and labour all attach to
-- the bucket, so we can only filter to the bucket. With this column,
-- operators can drill spend to the exact line they're looking at on
-- Budget Executing mode.
--
-- All three columns are nullable: existing rows stay attached at the
-- bucket level only. Going forward, operators can assign a cost_line
-- when categorising new bills / expenses / time, or backfill at their
-- pace via the form pickers (separate card — UX follow-up).
--
-- Indexes are partial (NOT NULL only) since the vast majority of pre-
-- migration rows will be NULL for some time. No point inflating index
-- size with bucket-only entries.

ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS cost_line_id UUID REFERENCES public.project_cost_lines(id) ON DELETE SET NULL;

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS cost_line_id UUID REFERENCES public.project_cost_lines(id) ON DELETE SET NULL;

ALTER TABLE public.project_bills
  ADD COLUMN IF NOT EXISTS cost_line_id UUID REFERENCES public.project_cost_lines(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_time_entries_cost_line
  ON public.time_entries (cost_line_id)
  WHERE cost_line_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_cost_line
  ON public.expenses (cost_line_id)
  WHERE cost_line_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_bills_cost_line
  ON public.project_bills (cost_line_id)
  WHERE cost_line_id IS NOT NULL;
