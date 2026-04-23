-- Web Share Target scratch storage.
--
-- When an operator shares a file (receipt photo, quote PDF, etc.) to
-- HeyHenry from iOS Share Sheet, the browser POSTs the file to
-- `/share/receive`. We stash it in this bucket under
-- `{tenant_id}/{uuid}.{ext}` and redirect the operator to a project
-- picker with the token. When they pick a project, the intake zone
-- downloads the file from here and parses it.
--
-- RLS mirrors the receipts / sub-quotes buckets: service-role writes
-- on upload, per-tenant path-prefixed reads/writes from authenticated
-- users. Files are intentionally ephemeral; a cron job (future) can
-- sweep anything older than 24h.

INSERT INTO storage.buckets (id, name, public)
VALUES ('share-drafts', 'share-drafts', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "share_drafts_select_own_tenant"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'share-drafts'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

CREATE POLICY "share_drafts_insert_own_tenant"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'share-drafts'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );

CREATE POLICY "share_drafts_delete_own_tenant"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'share-drafts'
    AND (split_part(name, '/', 1))::uuid = public.current_tenant_id()
  );
