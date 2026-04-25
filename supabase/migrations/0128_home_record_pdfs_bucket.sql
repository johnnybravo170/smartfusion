-- 0128_home_record_pdfs_bucket.sql
-- Slice 6b of the Customer Portal & Home Record build.
--
-- Private bucket for generated Home Record PDFs. Path layout matches
-- the photos / project-docs convention so the same RLS pattern
-- (split_part on path → current_tenant_id) applies and the signed-URL
-- minting flow is reusable.
--
-- Path: {tenant_id}/{project_id}/{slug}.pdf — slug from home_records.

INSERT INTO storage.buckets (id, name, public)
VALUES ('home-record-pdfs', 'home-record-pdfs', FALSE)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "tenant_select_home_record_pdfs" ON storage.objects;
CREATE POLICY "tenant_select_home_record_pdfs" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'home-record-pdfs'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

DROP POLICY IF EXISTS "tenant_insert_home_record_pdfs" ON storage.objects;
CREATE POLICY "tenant_insert_home_record_pdfs" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'home-record-pdfs'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

DROP POLICY IF EXISTS "tenant_update_home_record_pdfs" ON storage.objects;
CREATE POLICY "tenant_update_home_record_pdfs" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'home-record-pdfs'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  )
  WITH CHECK (
    bucket_id = 'home-record-pdfs'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

DROP POLICY IF EXISTS "tenant_delete_home_record_pdfs" ON storage.objects;
CREATE POLICY "tenant_delete_home_record_pdfs" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'home-record-pdfs'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );
