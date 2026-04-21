-- Project assignments: which worker is on which project (optionally day-scheduled).

CREATE TABLE IF NOT EXISTS public.project_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  worker_profile_id UUID NOT NULL
    REFERENCES public.worker_profiles (id) ON DELETE CASCADE,
  -- NULL = ongoing assignment (no specific day). Day-level scheduling
  -- uses a row per day.
  scheduled_date DATE,
  hourly_rate_cents INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One ongoing row per (project, worker); one row per day per (project, worker).
-- NULL scheduled_date is treated as a distinct value by the unique index, so
-- we use a partial unique index for the ongoing case and a plain unique
-- constraint for the day case.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_assignments_ongoing
  ON public.project_assignments (project_id, worker_profile_id)
  WHERE scheduled_date IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_assignments_day
  ON public.project_assignments (project_id, worker_profile_id, scheduled_date)
  WHERE scheduled_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_assignments_worker_date
  ON public.project_assignments (worker_profile_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_project_assignments_project
  ON public.project_assignments (project_id);

ALTER TABLE public.project_assignments ENABLE ROW LEVEL SECURITY;

-- Workers see their own assignments.
CREATE POLICY project_assignments_worker_select ON public.project_assignments
  FOR SELECT
  USING (
    worker_profile_id IN (
      SELECT wp.id
      FROM public.worker_profiles wp
      JOIN public.tenant_members tm ON tm.id = wp.tenant_member_id
      WHERE tm.user_id = auth.uid()
    )
  );

-- Owners/admins manage assignments for their tenant.
CREATE POLICY project_assignments_tenant_admin_all ON public.project_assignments
  FOR ALL
  USING (
    tenant_id IN (
      SELECT tenant_id FROM public.tenant_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM public.tenant_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );
