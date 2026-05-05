-- 0185_import_batches.sql
-- Onboarding-import audit trail. Every batch the operator commits through
-- the Henry-powered import wizard writes one row here, and every entity
-- created during that commit is tagged with `import_batch_id`. That gives
-- two things:
--
--   1. Audit — operators (and admins) can see at a glance "this customer
--      came from your 2025 QBO export on May 5".
--   2. Rollback — admin op can `delete from customers where
--      import_batch_id = ?` to undo a bad import without hand-grepping.
--
-- Phase A (this migration) covers the customers entity only. Subsequent
-- phases (projects, invoices, expenses) will add `import_batch_id` to
-- their respective tables in their own migrations.
--
-- See the kanban card "Henry-powered onboarding import wizard" and
-- PATTERNS.md §11 (cross-tenant RLS test must register this table).

-- ============================================================
-- 1. import_batches table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.import_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,

  -- Which entity type this batch covered. Phase A only emits 'customers';
  -- later phases add 'projects', 'invoices', 'expenses', etc. A single
  -- contractor onboarding session may write multiple batch rows (one per
  -- entity type) so each can be rolled back independently.
  kind            TEXT NOT NULL CHECK (kind IN ('customers', 'projects', 'invoices', 'expenses')),

  -- Provenance: what file the operator uploaded. Source path lives in
  -- the `imports` storage bucket (see below). filename is the original
  -- name as the operator uploaded it (for the audit UI).
  source_filename     TEXT,
  source_storage_path TEXT,

  -- Counts captured at commit time. Cheap to denormalize, expensive to
  -- recompute later if rows have been edited or deleted.
  --   { created: int, merged: int, skipped: int }
  summary         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Free-form note from the operator at commit time ("Q1 2025 customer
  -- export from QBO"). Optional; helps when there are several batches.
  note            TEXT,

  created_by      UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Set when an admin rolls the batch back. Rows tagged with this
  -- batch_id are deleted as part of the rollback; the batch row itself
  -- is kept (with `rolled_back_at` set) so the audit trail survives.
  rolled_back_at  TIMESTAMPTZ,
  rolled_back_by  UUID REFERENCES auth.users (id) ON DELETE SET NULL
);

-- Tenant rollup query (Settings → Imports list, admin views).
CREATE INDEX IF NOT EXISTS idx_import_batches_tenant_recent
  ON public.import_batches (tenant_id, created_at DESC);

-- Active-batch lookup (rolled_back_at IS NULL) for the imports list.
CREATE INDEX IF NOT EXISTS idx_import_batches_tenant_active
  ON public.import_batches (tenant_id, kind, created_at DESC)
  WHERE rolled_back_at IS NULL;

-- ============================================================
-- 2. RLS — same shape as project_checklist_items (PATTERNS.md §11).
-- ============================================================
ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_import_batches ON public.import_batches
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_import_batches ON public.import_batches
  FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_import_batches ON public.import_batches
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_import_batches ON public.import_batches
  FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

-- ============================================================
-- 3. Tag customers with their originating batch (Phase A).
--    Nullable — pre-existing customers stay null. ON DELETE SET NULL so
--    deleting a batch row (rare; rollback usually marks rolled_back_at
--    instead) doesn't take customer rows down with it. The reverse —
--    rollback deleting customers tagged with the batch — is handled in
--    application code, not via cascade, so the operator can confirm.
-- ============================================================
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS import_batch_id UUID
    REFERENCES public.import_batches (id) ON DELETE SET NULL;

-- Lookup support for "show me everyone from this batch" + the rollback
-- delete query.
CREATE INDEX IF NOT EXISTS idx_customers_import_batch
  ON public.customers (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

-- ============================================================
-- 4. Storage bucket — `imports`. Holds the original source files the
--    operator uploaded (Excel/CSV/etc), so a re-import is always
--    possible if something needs to be redone. Path convention matches
--    the rest of the app: {tenant_id}/{batch_id}/{filename}.
--    Auto-expiry of source files (e.g. 90 days post-import) is left
--    to a future scheduled task — not enforced at the storage layer.
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('imports', 'imports', FALSE)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "tenant_select_imports_storage" ON storage.objects;
CREATE POLICY "tenant_select_imports_storage" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'imports'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

DROP POLICY IF EXISTS "tenant_insert_imports_storage" ON storage.objects;
CREATE POLICY "tenant_insert_imports_storage" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'imports'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

DROP POLICY IF EXISTS "tenant_update_imports_storage" ON storage.objects;
CREATE POLICY "tenant_update_imports_storage" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'imports'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  )
  WITH CHECK (
    bucket_id = 'imports'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

DROP POLICY IF EXISTS "tenant_delete_imports_storage" ON storage.objects;
CREATE POLICY "tenant_delete_imports_storage" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'imports'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

COMMENT ON TABLE public.import_batches IS
  'Onboarding-import audit trail. Each row is one committed batch from the Henry import wizard. Source files live in the `imports` storage bucket. Phase A: customers only.';
COMMENT ON COLUMN public.customers.import_batch_id IS
  'Set when the customer was created via the import wizard. NULL for hand-typed customers and any customer that predated the wizard.';
