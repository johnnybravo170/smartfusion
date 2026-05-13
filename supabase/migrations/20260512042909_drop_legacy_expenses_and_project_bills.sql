-- Cost unification, final step: drop the legacy expenses + project_bills
-- tables. After PRs #1–#7 the unified `project_costs` is the canonical
-- store; PR #8 inverts every write path so the legacy tables haven't
-- been touched by application code since the deploy. This migration
-- physically removes them.
--
-- Safety preflight (verified pre-merge against prod):
--   - Per-id parity between expenses + project_costs receipts already
--     locked in by PR #1 verification (zero drift on amount, project_id,
--     budget_category_id, cost_line_id, worker_*).
--   - Codebase grep: no remaining `from('expenses')` or
--     `from('project_bills')` references in src/ after PR #8 inversion.
--   - Both tables have no incoming FKs (every outbound FK from
--     cost_line_actuals etc. points TO these tables, never the other
--     way), so the drop is a clean cascade.
--
-- This migration is IRREVERSIBLE without a backup. If we ever need to
-- recover the legacy tables, restore from a point-in-time backup taken
-- before this migration runs.

-- Sanity: confirm `project_costs` still has at least as many rows as
-- the legacy `expenses` table (the backfill is supposed to have
-- copied them all). On a fresh DB (CI, a new dev environment) both
-- tables are empty — the drop is then a no-op and we let it proceed.
-- The hard floor of 300 was specific to the prod row count at PR #6
-- verification time; it doesn't apply to fresh DBs.
DO $$
DECLARE
  expenses_count BIGINT;
  costs_count    BIGINT;
BEGIN
  SELECT COUNT(*) INTO expenses_count FROM public.expenses;
  SELECT COUNT(*) INTO costs_count    FROM public.project_costs;

  -- Fresh DB / never-used environment: nothing to lose, allow the drop.
  IF expenses_count = 0 THEN
    RAISE NOTICE 'expenses is empty; legacy drop is a no-op on this DB.';
  ELSIF costs_count < expenses_count THEN
    RAISE EXCEPTION
      'project_costs has % rows but expenses has % rows — backfill missing. Run the project_costs backfill migration first.',
      costs_count, expenses_count;
  END IF;
END $$;

-- QBO Class denormalization (migration 20260512041409) added
-- qbo_class_id + qbo_class_name to `expenses` after project_costs
-- already existed. The QBO import paths in PR #8 write these
-- straight to project_costs, so carry the columns over here and
-- backfill from the legacy expenses rows before the drop.
ALTER TABLE public.project_costs
  ADD COLUMN IF NOT EXISTS qbo_class_id   TEXT,
  ADD COLUMN IF NOT EXISTS qbo_class_name TEXT;

CREATE INDEX IF NOT EXISTS idx_project_costs_qbo_class
  ON public.project_costs (tenant_id, qbo_class_name)
  WHERE qbo_class_name IS NOT NULL;

UPDATE public.project_costs c
SET
  qbo_class_id   = e.qbo_class_id,
  qbo_class_name = e.qbo_class_name
FROM public.expenses e
WHERE c.id = e.id
  AND c.source_type = 'receipt'
  AND (e.qbo_class_id IS NOT NULL OR e.qbo_class_name IS NOT NULL);

DROP TABLE IF EXISTS public.project_bills CASCADE;
DROP TABLE IF EXISTS public.expenses CASCADE;
