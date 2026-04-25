-- 0126_project_documents.sql
-- Slice 5 of the Customer Portal & Home Record build.
--
-- Per-project document store: contracts, permits, warranties, manuals,
-- inspection reports, COIs, "other". One row per uploaded file. Files
-- live in a new private `project-docs` storage bucket — separate from
-- `photos` (visual documentation), `quotes` (quote PDFs), `sub-quotes`
-- (sub-trade pricing PDFs), `receipts` (expense capture). Mixing them
-- would muddle access patterns and signed-URL paths.
--
-- The bucket follows the same {tenant_id}/{project_id}/{random}.{ext}
-- path convention as the photos bucket so the existing RLS pattern
-- (split_part on path → current_tenant_id) drops in unchanged.
--
-- The DB row carries a `client_visible` flag so the operator can hold
-- a permit or COI back from the homeowner if needed (default true:
-- everything is visible unless explicitly hidden, mirroring the photos
-- portal-tag model from Slice 2).

-- ============================================================
-- 1. Table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.project_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,

  type          TEXT NOT NULL DEFAULT 'other'
    CHECK (type IN (
      'contract', 'permit', 'warranty', 'manual', 'inspection',
      'coi', 'other'
    )),

  title         TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  mime          TEXT,
  bytes         BIGINT,

  -- Optional metadata.
  supplier_id   UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  expires_at    DATE,
  notes         TEXT,

  -- Default visible to homeowner. Operator can flip false for internal
  -- docs that shouldn't appear on /portal/<slug>.
  client_visible BOOLEAN NOT NULL DEFAULT TRUE,

  uploaded_by   UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_project_documents_project_type
  ON public.project_documents (project_id, type, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_project_documents_tenant
  ON public.project_documents (tenant_id);

-- RLS
ALTER TABLE public.project_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_project_documents ON public.project_documents
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_project_documents ON public.project_documents
  FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_project_documents ON public.project_documents
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_project_documents ON public.project_documents
  FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

-- ============================================================
-- 2. Storage bucket + RLS — same shape as the `photos` bucket so the
--    server-side signed-URL signer doesn't need a special case.
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('project-docs', 'project-docs', FALSE)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "tenant_select_project_docs" ON storage.objects;
CREATE POLICY "tenant_select_project_docs" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'project-docs'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

DROP POLICY IF EXISTS "tenant_insert_project_docs" ON storage.objects;
CREATE POLICY "tenant_insert_project_docs" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'project-docs'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

DROP POLICY IF EXISTS "tenant_update_project_docs" ON storage.objects;
CREATE POLICY "tenant_update_project_docs" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'project-docs'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  )
  WITH CHECK (
    bucket_id = 'project-docs'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

DROP POLICY IF EXISTS "tenant_delete_project_docs" ON storage.objects;
CREATE POLICY "tenant_delete_project_docs" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'project-docs'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

COMMENT ON TABLE public.project_documents IS
  'Per-project file store: contracts, permits, warranties, manuals, inspection reports, COIs. Drives the Documents & Warranties section on /portal/<slug> and the Home Record (Slice 6) Documents bundle.';
