-- Worker unavailability: per-day blocks (vacation, sick, other job, etc.).
-- Either the worker or owner/admin can add rows. Scheduling a worker on
-- an unavailable day is allowed but flagged in the UI.

CREATE TABLE IF NOT EXISTS public.worker_unavailability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  worker_profile_id UUID NOT NULL
    REFERENCES public.worker_profiles (id) ON DELETE CASCADE,
  unavailable_date DATE NOT NULL,
  reason_tag TEXT NOT NULL DEFAULT 'other'
    CHECK (reason_tag IN ('vacation', 'sick', 'other_job', 'personal', 'other')),
  reason_text TEXT,
  created_by UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (worker_profile_id, unavailable_date)
);

CREATE INDEX IF NOT EXISTS idx_worker_unavailability_tenant_date
  ON public.worker_unavailability (tenant_id, unavailable_date);
CREATE INDEX IF NOT EXISTS idx_worker_unavailability_worker_date
  ON public.worker_unavailability (worker_profile_id, unavailable_date);

ALTER TABLE public.worker_unavailability ENABLE ROW LEVEL SECURITY;

-- Worker: SELECT/INSERT/DELETE own rows.
CREATE POLICY worker_unavailability_self_select ON public.worker_unavailability
  FOR SELECT
  USING (
    worker_profile_id IN (
      SELECT wp.id
      FROM public.worker_profiles wp
      JOIN public.tenant_members tm ON tm.id = wp.tenant_member_id
      WHERE tm.user_id = auth.uid()
    )
  );

CREATE POLICY worker_unavailability_self_insert ON public.worker_unavailability
  FOR INSERT
  WITH CHECK (
    worker_profile_id IN (
      SELECT wp.id
      FROM public.worker_profiles wp
      JOIN public.tenant_members tm ON tm.id = wp.tenant_member_id
      WHERE tm.user_id = auth.uid()
    )
  );

CREATE POLICY worker_unavailability_self_delete ON public.worker_unavailability
  FOR DELETE
  USING (
    worker_profile_id IN (
      SELECT wp.id
      FROM public.worker_profiles wp
      JOIN public.tenant_members tm ON tm.id = wp.tenant_member_id
      WHERE tm.user_id = auth.uid()
    )
  );

-- Owner/admin: full access within tenant.
CREATE POLICY worker_unavailability_tenant_admin_all ON public.worker_unavailability
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
