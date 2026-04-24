-- 0118_tasks.sql
-- Tasks module — Phase 1.
--
-- One table for three scopes (personal / project / lead). Both job_id and
-- lead_id are nullable; the CHECK constraint enforces "exactly one scope".
--
-- Workers default to ZERO visibility — only tasks where assignee_id matches
-- their auth.uid() come back from SELECT, and they can only UPDATE the
-- status field via a server action that whitelists the column.
--
-- The "leads" scope keeps lead_id as a plain nullable UUID with no FK target:
-- this app stores leads as `customers` rows with `kind = 'lead'`, and we
-- don't want to bind to that just yet — Phase 3 will reconsider.

CREATE TABLE IF NOT EXISTS public.tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,

  title TEXT NOT NULL,
  description TEXT,

  scope TEXT NOT NULL
    CHECK (scope IN ('personal', 'project', 'lead')),

  job_id UUID REFERENCES public.jobs (id) ON DELETE CASCADE,
  lead_id UUID,

  phase TEXT,

  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN (
      'ready',
      'in_progress',
      'waiting_client',
      'waiting_material',
      'waiting_sub',
      'blocked',
      'done',
      'verified'
    )),

  blocker_reason TEXT,

  assignee_id UUID REFERENCES auth.users (id) ON DELETE SET NULL,

  created_by TEXT NOT NULL,

  visibility TEXT NOT NULL DEFAULT 'internal'
    CHECK (visibility IN ('internal', 'crew', 'client')),

  client_summary TEXT,

  required_photos BOOLEAN NOT NULL DEFAULT FALSE,

  due_date DATE,
  completed_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,

  -- Linked artifacts. change_orders FK exists; the others are kept as plain
  -- nullable UUIDs because the matching tables don't all exist yet (estimate
  -- line items live in `quote_line_items`, material orders aren't built).
  linked_change_order_id UUID REFERENCES public.change_orders (id) ON DELETE SET NULL,
  linked_estimate_line_id UUID,
  linked_material_order_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT tasks_scope_fk_check CHECK (
    (scope = 'personal' AND job_id IS NULL AND lead_id IS NULL)
    OR (scope = 'project' AND job_id IS NOT NULL)
    OR (scope = 'lead' AND lead_id IS NOT NULL)
  )
);

-- Indexes (all partial / tenant-scoped — match existing project conventions).
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_scope_open
  ON public.tasks (tenant_id, scope, status)
  WHERE status NOT IN ('done', 'verified');

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_assignee_open
  ON public.tasks (tenant_id, assignee_id)
  WHERE status NOT IN ('done', 'verified');

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_job
  ON public.tasks (tenant_id, job_id)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_lead
  ON public.tasks (tenant_id, lead_id)
  WHERE lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_due_open
  ON public.tasks (tenant_id, due_date)
  WHERE status NOT IN ('done', 'verified');

-- RLS.
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

-- Owners + admins: full CRUD on their tenant's rows. Workers fall through
-- to the worker-only policies below.
CREATE POLICY tasks_owner_admin_all ON public.tasks
  FOR ALL TO authenticated
  USING (
    tenant_id = public.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.tenant_members tm
      WHERE tm.user_id = auth.uid()
        AND tm.tenant_id = public.tasks.tenant_id
        AND tm.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.tenant_members tm
      WHERE tm.user_id = auth.uid()
        AND tm.tenant_id = public.tasks.tenant_id
        AND tm.role IN ('owner', 'admin')
    )
  );

-- Workers: SELECT only the rows assigned to them.
CREATE POLICY tasks_worker_select ON public.tasks
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.current_tenant_id()
    AND assignee_id = auth.uid()
  );

-- Workers: UPDATE only the rows assigned to them. Field-level whitelisting
-- (status only) is enforced in the server action layer, not at RLS — Postgres
-- can't easily restrict which columns are written through RLS, and the
-- update path goes through a single server action that ignores everything
-- except `status` for worker callers.
CREATE POLICY tasks_worker_update ON public.tasks
  FOR UPDATE TO authenticated
  USING (
    tenant_id = public.current_tenant_id()
    AND assignee_id = auth.uid()
  )
  WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND assignee_id = auth.uid()
  );

COMMENT ON TABLE public.tasks IS
  'Unified task store for personal / project / lead scopes. See PATTERNS.md and the Tasks card on the kanban for the full data model.';
