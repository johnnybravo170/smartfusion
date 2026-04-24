-- ============================================================
-- Temporary staging bucket for intake-audio uploads.
--
-- Vercel enforces a ~4.5 MB body-size ceiling on server actions
-- regardless of Next's bodySizeLimit config. Large voice memos
-- (10-25 MB m4a is common from iOS) have to bypass that path.
-- The client uploads straight to this bucket from the browser,
-- then sends the storage path to parseInboundLeadAction. The
-- action downloads via the service-role client, runs Whisper,
-- and deletes the staging file.
--
-- Scoped by tenant id / user id prefix. RLS only allows an
-- authenticated user to write into their own prefix.
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('intake-audio', 'intake-audio', false)
ON CONFLICT (id) DO NOTHING;

-- Path layout: <tenant_id>/<user_id>/<random>.<ext>

DROP POLICY IF EXISTS "intake_audio_insert_own" ON storage.objects;
CREATE POLICY "intake_audio_insert_own"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'intake-audio'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

DROP POLICY IF EXISTS "intake_audio_select_own" ON storage.objects;
CREATE POLICY "intake_audio_select_own"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'intake-audio'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

DROP POLICY IF EXISTS "intake_audio_delete_own" ON storage.objects;
CREATE POLICY "intake_audio_delete_own"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'intake-audio'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );
