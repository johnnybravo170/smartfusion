-- 0031_renovation_phase_r1.sql
-- Renovation Phase R1: projects, cost buckets, time/expense logging, voice memos.
--
-- New tables: projects, project_cost_buckets, project_memos, time_entries, expenses, cost_bucket_templates
-- Also adds `vertical` column to tenants.

-- ============================================================
-- 1. Add `vertical` to tenants
-- ============================================================
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS vertical TEXT NOT NULL DEFAULT 'pressure_washing'
  CHECK (vertical IN ('pressure_washing', 'renovation', 'tile'));

-- ============================================================
-- 2. cost_bucket_templates (per-tenant, created on first use)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cost_bucket_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  section     TEXT NOT NULL CHECK (section IN ('interior', 'exterior', 'general')),
  buckets     JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cost_bucket_templates_tenant ON public.cost_bucket_templates(tenant_id);

-- ============================================================
-- 3. projects
-- ============================================================
CREATE TABLE IF NOT EXISTS public.projects (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  customer_id         UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  status              TEXT NOT NULL DEFAULT 'planning'
                        CHECK (status IN ('planning', 'in_progress', 'complete', 'cancelled')),
  phase               TEXT,
  management_fee_rate NUMERIC(5,4) NOT NULL DEFAULT 0.1200,
  start_date          DATE,
  target_end_date     DATE,
  percent_complete    INTEGER NOT NULL DEFAULT 0 CHECK (percent_complete >= 0 AND percent_complete <= 100),
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_projects_tenant ON public.projects(tenant_id);
CREATE INDEX idx_projects_customer ON public.projects(customer_id);
CREATE INDEX idx_projects_status ON public.projects(status) WHERE deleted_at IS NULL;

-- ============================================================
-- 4. project_cost_buckets
-- ============================================================
CREATE TABLE IF NOT EXISTS public.project_cost_buckets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  tenant_id             UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  section               TEXT NOT NULL CHECK (section IN ('interior', 'exterior', 'general')),
  description           TEXT,
  estimate_cents        BIGINT NOT NULL DEFAULT 0,
  display_order         INTEGER NOT NULL DEFAULT 0,
  is_visible_in_report  BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_project_cost_buckets_project ON public.project_cost_buckets(project_id);
CREATE INDEX idx_project_cost_buckets_tenant ON public.project_cost_buckets(tenant_id);

-- ============================================================
-- 5. project_memos (voice memo → transcription → extraction)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.project_memos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  audio_url       TEXT,
  transcript      TEXT,
  ai_extraction   JSONB,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'transcribing', 'extracting', 'ready', 'failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_project_memos_project ON public.project_memos(project_id);

-- ============================================================
-- 6. time_entries
-- ============================================================
CREATE TABLE IF NOT EXISTS public.time_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL,
  project_id      UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  bucket_id       UUID REFERENCES public.project_cost_buckets(id) ON DELETE SET NULL,
  job_id          UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
  hours           NUMERIC(6,2) NOT NULL CHECK (hours > 0),
  hourly_rate_cents INTEGER,
  notes           TEXT,
  entry_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT time_entry_requires_parent CHECK (project_id IS NOT NULL OR job_id IS NOT NULL)
);

CREATE INDEX idx_time_entries_tenant ON public.time_entries(tenant_id);
CREATE INDEX idx_time_entries_project ON public.time_entries(project_id);
CREATE INDEX idx_time_entries_job ON public.time_entries(job_id);
CREATE INDEX idx_time_entries_user ON public.time_entries(user_id);
CREATE INDEX idx_time_entries_date ON public.time_entries(entry_date);

-- ============================================================
-- 7. expenses
-- ============================================================
CREATE TABLE IF NOT EXISTS public.expenses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL,
  project_id      UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  bucket_id       UUID REFERENCES public.project_cost_buckets(id) ON DELETE SET NULL,
  job_id          UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
  amount_cents    BIGINT NOT NULL CHECK (amount_cents > 0),
  vendor          TEXT,
  description     TEXT,
  receipt_url     TEXT,
  expense_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_expenses_tenant ON public.expenses(tenant_id);
CREATE INDEX idx_expenses_project ON public.expenses(project_id);
CREATE INDEX idx_expenses_job ON public.expenses(job_id);
CREATE INDEX idx_expenses_user ON public.expenses(user_id);
CREATE INDEX idx_expenses_date ON public.expenses(expense_date);

-- ============================================================
-- 8. RLS policies
-- ============================================================

-- cost_bucket_templates
ALTER TABLE public.cost_bucket_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_cost_bucket_templates ON public.cost_bucket_templates
    FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_cost_bucket_templates ON public.cost_bucket_templates
    FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_cost_bucket_templates ON public.cost_bucket_templates
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_cost_bucket_templates ON public.cost_bucket_templates
    FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

-- projects
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_projects ON public.projects
    FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_projects ON public.projects
    FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_projects ON public.projects
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_projects ON public.projects
    FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

-- project_cost_buckets
ALTER TABLE public.project_cost_buckets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_project_cost_buckets ON public.project_cost_buckets
    FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_project_cost_buckets ON public.project_cost_buckets
    FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_project_cost_buckets ON public.project_cost_buckets
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_project_cost_buckets ON public.project_cost_buckets
    FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

-- project_memos
ALTER TABLE public.project_memos ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_project_memos ON public.project_memos
    FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_project_memos ON public.project_memos
    FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_project_memos ON public.project_memos
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_project_memos ON public.project_memos
    FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

-- time_entries: tenant-scoped + workers see only their own rows
ALTER TABLE public.time_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_time_entries ON public.time_entries
    FOR SELECT TO authenticated
    USING (
      tenant_id = public.current_tenant_id()
      AND (
        -- Owners/admins see all; workers see only their own
        EXISTS (
          SELECT 1 FROM public.tenant_members
          WHERE tenant_members.user_id = auth.uid()
            AND tenant_members.tenant_id = time_entries.tenant_id
            AND tenant_members.role IN ('owner', 'admin')
        )
        OR user_id = auth.uid()
      )
    );
CREATE POLICY tenant_insert_time_entries ON public.time_entries
    FOR INSERT TO authenticated
    WITH CHECK (
      tenant_id = public.current_tenant_id()
      AND user_id = auth.uid()
    );
CREATE POLICY tenant_update_time_entries ON public.time_entries
    FOR UPDATE TO authenticated
    USING (
      tenant_id = public.current_tenant_id()
      AND user_id = auth.uid()
    )
    WITH CHECK (
      tenant_id = public.current_tenant_id()
      AND user_id = auth.uid()
    );
CREATE POLICY tenant_delete_time_entries ON public.time_entries
    FOR DELETE TO authenticated
    USING (
      tenant_id = public.current_tenant_id()
      AND user_id = auth.uid()
    );

-- expenses: same pattern as time_entries
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_select_expenses ON public.expenses
    FOR SELECT TO authenticated
    USING (
      tenant_id = public.current_tenant_id()
      AND (
        EXISTS (
          SELECT 1 FROM public.tenant_members
          WHERE tenant_members.user_id = auth.uid()
            AND tenant_members.tenant_id = expenses.tenant_id
            AND tenant_members.role IN ('owner', 'admin')
        )
        OR user_id = auth.uid()
      )
    );
CREATE POLICY tenant_insert_expenses ON public.expenses
    FOR INSERT TO authenticated
    WITH CHECK (
      tenant_id = public.current_tenant_id()
      AND user_id = auth.uid()
    );
CREATE POLICY tenant_update_expenses ON public.expenses
    FOR UPDATE TO authenticated
    USING (
      tenant_id = public.current_tenant_id()
      AND user_id = auth.uid()
    )
    WITH CHECK (
      tenant_id = public.current_tenant_id()
      AND user_id = auth.uid()
    );
CREATE POLICY tenant_delete_expenses ON public.expenses
    FOR DELETE TO authenticated
    USING (
      tenant_id = public.current_tenant_id()
      AND user_id = auth.uid()
    );

-- ============================================================
-- 9. Storage bucket for project memos (audio files)
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('project-memos', 'project-memos', false)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: tenant-scoped paths (project-memos/{tenant_id}/...)
CREATE POLICY storage_select_project_memos ON storage.objects
    FOR SELECT TO authenticated
    USING (bucket_id = 'project-memos' AND (storage.foldername(name))[1] = (
      SELECT t.id::text FROM public.tenants t
      INNER JOIN public.tenant_members tm ON tm.tenant_id = t.id
      WHERE tm.user_id = auth.uid()
      LIMIT 1
    ));

CREATE POLICY storage_insert_project_memos ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'project-memos' AND (storage.foldername(name))[1] = (
      SELECT t.id::text FROM public.tenants t
      INNER JOIN public.tenant_members tm ON tm.tenant_id = t.id
      WHERE tm.user_id = auth.uid()
      LIMIT 1
    ));
