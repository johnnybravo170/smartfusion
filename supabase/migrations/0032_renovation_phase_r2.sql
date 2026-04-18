-- 0032_renovation_phase_r2.sql
-- Renovation Phase R2: change orders + homeowner portal.
--
-- New tables: change_orders, project_portal_updates
-- Alters: projects (portal_slug, portal_enabled)

-- ============================================================
-- 1. change_orders
-- ============================================================
CREATE TABLE public.change_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  tenant_id           UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL,
  reason              TEXT,
  cost_impact_cents   BIGINT NOT NULL DEFAULT 0,
  timeline_impact_days INTEGER NOT NULL DEFAULT 0,
  affected_buckets    JSONB DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'pending_approval', 'approved', 'declined', 'voided')),
  approval_code       TEXT UNIQUE,
  approved_by_name    TEXT,
  approved_at         TIMESTAMPTZ,
  declined_at         TIMESTAMPTZ,
  declined_reason     TEXT,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_change_orders_project_status ON public.change_orders (project_id, status);
CREATE INDEX idx_change_orders_tenant ON public.change_orders (tenant_id);
CREATE INDEX idx_change_orders_approval_code ON public.change_orders (approval_code);

-- ============================================================
-- 2. project_portal_updates
-- ============================================================
CREATE TABLE public.project_portal_updates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('progress', 'photo', 'milestone', 'message', 'system')),
  title       TEXT NOT NULL,
  body        TEXT,
  photo_url   TEXT,
  is_visible  BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_portal_updates_project_date ON public.project_portal_updates (project_id, created_at DESC);

-- ============================================================
-- 3. Add portal columns to projects
-- ============================================================
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS portal_slug TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS portal_enabled BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- 4. RLS: change_orders (standard tenant CRUD)
-- ============================================================
ALTER TABLE public.change_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_change_orders ON public.change_orders
    FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_change_orders ON public.change_orders
    FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_change_orders ON public.change_orders
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_change_orders ON public.change_orders
    FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

-- Anon: allow SELECT by approval_code (for the public approval page)
CREATE POLICY anon_select_change_orders_by_code ON public.change_orders
    FOR SELECT TO anon
    USING (approval_code IS NOT NULL);

-- ============================================================
-- 5. RLS: project_portal_updates
-- ============================================================
ALTER TABLE public.project_portal_updates ENABLE ROW LEVEL SECURITY;

-- Authenticated tenant CRUD
CREATE POLICY tenant_select_portal_updates ON public.project_portal_updates
    FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_portal_updates ON public.project_portal_updates
    FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_portal_updates ON public.project_portal_updates
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_portal_updates ON public.project_portal_updates
    FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

-- Anon: view updates for portal-enabled projects
CREATE POLICY anon_select_portal_updates ON public.project_portal_updates
    FOR SELECT TO anon
    USING (
      EXISTS (
        SELECT 1 FROM public.projects p
        WHERE p.id = project_portal_updates.project_id
          AND p.portal_enabled = true
      )
      AND is_visible = true
    );

-- ============================================================
-- 6. Anon policy for projects (portal page needs project name + customer)
-- ============================================================
CREATE POLICY anon_select_projects_portal ON public.projects
    FOR SELECT TO anon
    USING (portal_enabled = true AND deleted_at IS NULL);
