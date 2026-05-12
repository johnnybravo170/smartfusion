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

-- Sanity: confirm `project_costs` still has the union of rows that the
-- legacy tables held immediately before the drop. Aborts the migration
-- if the count is implausibly low (under the row count we saw at the
-- last PR #6 verification, 376) — a guard against running this against
-- a staging DB that hasn't been backfilled.
DO $$
DECLARE
  costs_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO costs_count FROM public.project_costs;
  IF costs_count < 300 THEN
    RAISE EXCEPTION
      'project_costs has only % rows — refusing to drop legacy tables. Expected >= 300 based on the last verification snapshot. If this is a fresh / staging DB without backfill, run the backfill migration before applying this one.',
      costs_count;
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
