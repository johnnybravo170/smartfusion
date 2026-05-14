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
-- only if there's actual data we would lose — i.e. legacy tables hold
-- rows but project_costs doesn't have at least as many. A fresh DB
-- (CI, local dev, brand-new tenant install) has 0 rows in all three,
-- which is trivially safe to drop.
DO $$
DECLARE
  expenses_count      BIGINT;
  project_bills_count BIGINT;
  legacy_count        BIGINT;
  costs_count         BIGINT;
BEGIN
  SELECT COUNT(*) INTO expenses_count      FROM public.expenses;
  SELECT COUNT(*) INTO project_bills_count FROM public.project_bills;
  SELECT COUNT(*) INTO costs_count         FROM public.project_costs;
  legacy_count := expenses_count + project_bills_count;

  -- Empty legacy → empty project_costs is fine (fresh DB). The dangerous
  -- case is "legacy has rows, but the backfill didn't replicate them."
  IF legacy_count > 0 AND costs_count < legacy_count THEN
    RAISE EXCEPTION
      'project_costs has % rows but legacy expenses+project_bills holds % — refusing to drop. The backfill migration must complete first.',
      costs_count, legacy_count;
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
