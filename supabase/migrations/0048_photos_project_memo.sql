-- 0048_photos_project_memo.sql
-- Photos can now attach to a renovation project (in addition to a job) and
-- optionally to the voice memo that captured them. Both columns are
-- nullable; existing job-scoped photos keep working unchanged.
--
-- job_id was already nullable (since 0034), so a photo row may now be
-- pinned to any combination of (job, project, memo, customer).

ALTER TABLE public.photos
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS memo_id UUID REFERENCES public.project_memos(id) ON DELETE SET NULL;

-- Gallery queries filter by project_id and order by upload time.
CREATE INDEX IF NOT EXISTS photos_project_uploaded_idx
  ON public.photos (project_id, uploaded_at DESC)
  WHERE project_id IS NOT NULL AND deleted_at IS NULL;

-- Look up the photos attached to a specific memo when rendering the memo card.
CREATE INDEX IF NOT EXISTS photos_memo_idx
  ON public.photos (memo_id)
  WHERE memo_id IS NOT NULL;
