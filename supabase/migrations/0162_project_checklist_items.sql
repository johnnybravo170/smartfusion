-- 0162_project_checklist_items.sql
-- Field-level team checklist per project — lightweight, collaborative, dead
-- simple. Sits next to the heavier `tasks` table (which is PM-level workflow
-- with statuses, assignees, verification). This is for the crew's "I need 2
-- pancake boxes for the electrical panel" notes.
--
-- Anyone in the tenant can add / check / uncheck / delete items on any of
-- their tenant's projects. Cross-tenant isolation is enforced by RLS.
--
-- Optional photo per item lives in a NEW `project-checklist` storage bucket —
-- separate from `photos` (gallery), `project-docs` (contracts/permits), etc.
-- so these ephemeral field snapshots don't pollute the historical photo
-- gallery. Bucket follows the same {tenant_id}/{project_id}/{item_id}.{ext}
-- path convention as `photos` / `project-docs` so the existing signed-URL
-- signer drops in unchanged.
--
-- Auto-expiry of attachments 90 days after the parent project's completed_at
-- is handled by a scheduled task (see roadmap) — not enforced at the DB
-- level. The DB just stores the path; the cron deletes the object and nulls
-- the column.
--
-- See PATTERNS.md §5 (server-action result shape) and §11 (cross-tenant RLS
-- test must register this table).

-- ============================================================
-- 1. Table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.project_checklist_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  project_id   UUID NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,

  title        TEXT NOT NULL,
  category     TEXT,

  -- Optional photo. NULL until someone snaps one. Stored in the
  -- `project-checklist` bucket; auto-deleted 90d after project completion.
  photo_storage_path TEXT,
  photo_mime         TEXT,

  created_by   UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES auth.users (id) ON DELETE SET NULL,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pci_completed_consistency CHECK (
    (completed_at IS NULL AND completed_by IS NULL)
    OR (completed_at IS NOT NULL)
  )
);

-- Per-project list query (open first, then recently completed within the
-- hide window). Partial keeps it tight for the open-only fast path.
CREATE INDEX IF NOT EXISTS idx_pci_project_open
  ON public.project_checklist_items (project_id, created_at DESC)
  WHERE completed_at IS NULL;

-- Per-project full-list query (used when the hide window expands to show
-- recently completed items).
CREATE INDEX IF NOT EXISTS idx_pci_project_completed_at
  ON public.project_checklist_items (project_id, completed_at DESC)
  WHERE completed_at IS NOT NULL;

-- Tenant-wide rollup for the GC dashboard chip + /checklists page.
CREATE INDEX IF NOT EXISTS idx_pci_tenant_open
  ON public.project_checklist_items (tenant_id, project_id)
  WHERE completed_at IS NULL;

-- ============================================================
-- 2. RLS — any authenticated tenant member has full CRUD on their tenant's
--    rows. Collaborative by design; no per-row author restriction.
-- ============================================================
ALTER TABLE public.project_checklist_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_pci ON public.project_checklist_items
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_pci ON public.project_checklist_items
  FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_pci ON public.project_checklist_items
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_pci ON public.project_checklist_items
  FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

-- ============================================================
-- 3. Storage bucket + RLS — same shape as `photos` and `project-docs`.
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('project-checklist', 'project-checklist', FALSE)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "tenant_select_pci_storage" ON storage.objects;
CREATE POLICY "tenant_select_pci_storage" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'project-checklist'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

DROP POLICY IF EXISTS "tenant_insert_pci_storage" ON storage.objects;
CREATE POLICY "tenant_insert_pci_storage" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'project-checklist'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

DROP POLICY IF EXISTS "tenant_update_pci_storage" ON storage.objects;
CREATE POLICY "tenant_update_pci_storage" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'project-checklist'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  )
  WITH CHECK (
    bucket_id = 'project-checklist'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

DROP POLICY IF EXISTS "tenant_delete_pci_storage" ON storage.objects;
CREATE POLICY "tenant_delete_pci_storage" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'project-checklist'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

COMMENT ON TABLE public.project_checklist_items IS
  'Field-level team checklist per project (e.g. "need 2 pancake boxes"). Lightweight parallel to tasks. Photos stored in project-checklist bucket; auto-expired 90d after project completion via scheduled task.';
