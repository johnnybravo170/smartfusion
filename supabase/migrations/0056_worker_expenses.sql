-- Worker expenses (W5): attribute expenses to a worker_profile and support
-- receipt file uploads into a private `receipts` bucket.

-- 1. Schema additions on expenses.
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS worker_profile_id UUID REFERENCES public.worker_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS receipt_storage_path TEXT;

CREATE INDEX IF NOT EXISTS idx_expenses_worker_profile
  ON public.expenses (worker_profile_id);

-- 2. Receipts storage bucket (private, tenant-scoped paths).
INSERT INTO storage.buckets (id, name, public)
VALUES ('receipts', 'receipts', false)
ON CONFLICT (id) DO NOTHING;

-- Tenant isolation on the receipts bucket: the first path segment must be the
-- caller's tenant id. Mirrors the pattern used by project-memos / photos.
DROP POLICY IF EXISTS storage_select_receipts ON storage.objects;
CREATE POLICY storage_select_receipts ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'receipts'
    AND (storage.foldername(name))[1] IN (
      SELECT tm.tenant_id::text
      FROM public.tenant_members tm
      WHERE tm.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS storage_insert_receipts ON storage.objects;
CREATE POLICY storage_insert_receipts ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'receipts'
    AND (storage.foldername(name))[1] IN (
      SELECT tm.tenant_id::text
      FROM public.tenant_members tm
      WHERE tm.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS storage_delete_receipts ON storage.objects;
CREATE POLICY storage_delete_receipts ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'receipts'
    AND (storage.foldername(name))[1] IN (
      SELECT tm.tenant_id::text
      FROM public.tenant_members tm
      WHERE tm.user_id = auth.uid()
    )
  );
