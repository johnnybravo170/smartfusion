-- 0191_photos_import_batch.sql
-- Phase E of the onboarding-import wizard. Bulk-attach a folder of
-- historical project photos to a chosen project, with provenance + the
-- standard rollback path.
--
-- Two changes:
--   1. Expand `import_batches.kind` to allow 'photos' and 'time_entries'
--      (Phase F lands the latter in 0192). Phases A–D's existing rows
--      are unaffected.
--   2. Add `import_batch_id` to public.photos with the same partial
--      index pattern other entities use.

-- ============================================================
-- 1. Expand import_batches.kind
-- ============================================================
ALTER TABLE public.import_batches
  DROP CONSTRAINT IF EXISTS import_batches_kind_check;

ALTER TABLE public.import_batches
  ADD CONSTRAINT import_batches_kind_check
    CHECK (kind IN ('customers', 'projects', 'invoices', 'expenses', 'photos', 'time_entries'));

-- ============================================================
-- 2. photos.import_batch_id
-- ============================================================
ALTER TABLE public.photos
  ADD COLUMN IF NOT EXISTS import_batch_id UUID
    REFERENCES public.import_batches (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_photos_import_batch
  ON public.photos (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

COMMENT ON COLUMN public.photos.import_batch_id IS
  'Set when the photo was bulk-imported via the onboarding wizard. NULL for live captures (mobile_pwa, web, etc).';
