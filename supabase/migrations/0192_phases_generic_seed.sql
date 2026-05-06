-- 0192_phases_generic_seed.sql
-- Phase 1 of PORTAL_PHASES_PLAN.md.
--
-- Two changes:
--
-- 1. Replace the per-vertical phase seed with a single generic 4-phase
--    set for every project (any vertical):
--      Planning → Active → Walkthrough → Done
--
--    Phases on a project belong to the contractor, not us. Per-vertical
--    seed sets ("Demo / Framing / Drywall" for renovation, "Tear-off /
--    Sheathing" for roofing, etc.) bake in domain assumptions we're not
--    equipped to maintain as the platform broadens (a barn build doesn't
--    fit any of those moulds). The generic seed is just a starting point
--    — the contractor edits the rail per project on the Portal tab.
--
--    Existing projects are NOT touched. Their existing phase rows stay
--    as they were; the contractor can prune via the new edit UI.
--
-- 2. Drop UNIQUE (project_id, display_order) so per-row reorder
--    operations don't deadlock against the constraint mid-update. The
--    application enforces ordering correctness; uniqueness was a
--    belt-and-braces guarantee that costs more in operational pain than
--    it provides in safety. Replaced with a non-unique index for the
--    `ORDER BY display_order` lookup path.

CREATE OR REPLACE FUNCTION public.seed_project_phases_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Idempotency guard: cloned project, manual seed, replay, etc.
  IF EXISTS (SELECT 1 FROM public.project_phases WHERE project_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.project_phases
    (tenant_id, project_id, name, display_order, status, started_at)
  VALUES
    (NEW.tenant_id, NEW.id, 'Planning',     1, 'in_progress', NOW()),
    (NEW.tenant_id, NEW.id, 'Active',       2, 'upcoming',    NULL),
    (NEW.tenant_id, NEW.id, 'Walkthrough',  3, 'upcoming',    NULL),
    (NEW.tenant_id, NEW.id, 'Done',         4, 'upcoming',    NULL);

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.seed_project_phases_on_insert() IS
  'Seeds project_phases on project insert with a generic 4-phase set (Planning / Active / Walkthrough / Done). Contractor edits per-project on the Portal tab.';

-- Drop the unique constraint. Replace with a plain index so the
-- ORDER BY display_order lookup stays fast.
ALTER TABLE public.project_phases
  DROP CONSTRAINT IF EXISTS project_phases_project_id_display_order_key;

-- The original 0122 migration also created idx_project_phases_project
-- on (project_id, display_order); that index already covers the lookup.
-- Nothing to add here — just verifying it survives.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'project_phases'
      AND indexname = 'idx_project_phases_project'
  ) THEN
    CREATE INDEX idx_project_phases_project
      ON public.project_phases (project_id, display_order);
  END IF;
END $$;
