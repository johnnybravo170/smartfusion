-- 0133_selection_allowance.sql
-- Allowance tracking on selections.
--
-- Operators set an allowance on a selection (the budget for that paint
-- / tile / fixture pick). When the homeowner picks something that
-- exceeds the allowance, the homeowner sees the overage and the
-- operator gets a paper trail. All amounts are integer cents to match
-- the rest of the money columns in this app.

ALTER TABLE public.project_selections
  ADD COLUMN IF NOT EXISTS allowance_cents BIGINT,
  ADD COLUMN IF NOT EXISTS actual_cost_cents BIGINT;

COMMENT ON COLUMN public.project_selections.allowance_cents IS
  'Budgeted amount for this selection in integer cents. Null = no allowance set.';
COMMENT ON COLUMN public.project_selections.actual_cost_cents IS
  'Actual cost of the chosen product in integer cents. Null = not yet known. Compared to allowance to compute over/under per-line and per-project.';
