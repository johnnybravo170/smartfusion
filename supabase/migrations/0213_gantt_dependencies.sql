-- 0213_gantt_dependencies.sql
-- Gantt v2 — predecessor edges + auto-cascade.
--
-- One row per directed edge from a predecessor task to a successor.
-- v2 only models the canonical residential-reno relationship —
-- finish_to_start (default) — but the `kind` column is open for
-- start_to_start / finish_to_finish later if a real use case shows up.
--
-- Cascade math lives in src/server/actions/project-schedule.ts:
-- when a task's date or duration changes, the server walks the
-- successor graph in topological order and shifts any successor that
-- would otherwise start before the predecessor's end + lag_days.
--
-- Cascade is FORWARD-ONLY for v2 — pulling a task earlier doesn't
-- pull its successors earlier (they might have their own constraints
-- the GC has already firmed up). Shift-forward is the conservative,
-- "respect dependencies but don't surprise" rule.

CREATE TABLE IF NOT EXISTS public.project_schedule_dependencies (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id                UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  project_id               UUID NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,

  predecessor_task_id      UUID NOT NULL REFERENCES public.project_schedule_tasks (id) ON DELETE CASCADE,
  successor_task_id        UUID NOT NULL REFERENCES public.project_schedule_tasks (id) ON DELETE CASCADE,

  kind                     TEXT NOT NULL DEFAULT 'finish_to_start'
    CHECK (kind IN ('finish_to_start', 'start_to_start', 'finish_to_finish')),

  -- Buffer days between predecessor's end (or start, depending on kind)
  -- and successor's start. Negative allowed for "start successor 1 day
  -- before predecessor finishes" overlap patterns; the cascade math
  -- treats negative lag as "successor's earliest start is X days before
  -- predecessor's end".
  lag_days                 INTEGER NOT NULL DEFAULT 0,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (predecessor_task_id, successor_task_id),
  -- A task can't depend on itself. The harder cycle case (A → B → A)
  -- is checked in the action layer at insert time so we get a clear
  -- error message instead of a hard-to-debug runtime loop.
  CHECK (predecessor_task_id <> successor_task_id)
);

CREATE INDEX IF NOT EXISTS idx_psd_predecessor
  ON public.project_schedule_dependencies (predecessor_task_id);

CREATE INDEX IF NOT EXISTS idx_psd_successor
  ON public.project_schedule_dependencies (successor_task_id);

CREATE INDEX IF NOT EXISTS idx_psd_project
  ON public.project_schedule_dependencies (project_id);

-- Auto-stamp tenant_id on insert from the linked project — same trigger
-- pattern as project_schedule_tasks (migration 0206). Server actions
-- still pass tenant_id explicitly so RLS WITH CHECK sees a value at
-- INSERT time.
CREATE OR REPLACE FUNCTION public.stamp_psd_tenant_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    SELECT tenant_id INTO NEW.tenant_id
    FROM public.projects
    WHERE id = NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_psd_stamp_tenant ON public.project_schedule_dependencies;
CREATE TRIGGER trg_psd_stamp_tenant
  BEFORE INSERT ON public.project_schedule_dependencies
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_psd_tenant_id();

ALTER TABLE public.project_schedule_dependencies ENABLE ROW LEVEL SECURITY;

-- Same shape as project_schedule_tasks (mirror of project_phases).
CREATE POLICY psd_tenant_all ON public.project_schedule_dependencies
  FOR ALL TO authenticated
  USING (
    tenant_id = public.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.tenant_members tm
      WHERE tm.user_id = auth.uid()
        AND tm.tenant_id = public.project_schedule_dependencies.tenant_id
        AND tm.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.tenant_members tm
      WHERE tm.user_id = auth.uid()
        AND tm.tenant_id = public.project_schedule_dependencies.tenant_id
        AND tm.role IN ('owner', 'admin', 'member')
    )
  );

COMMENT ON TABLE public.project_schedule_dependencies IS
  'Directed predecessor → successor edges between project_schedule_tasks. Drives the cascade-on-edit behavior in the operator schedule UI: when a task moves, downstream tasks shift forward to respect the dependency. v2 of the Gantt module.';
