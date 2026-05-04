-- Memo extraction: store v1 + v2 (second-pass) side by side.
--
-- Reshape `project_memos.ai_extraction` from a flat extraction object into
-- a versioned envelope:
--   { v1: <extraction>, v2: <extraction|null>, active: 'v1' | 'v2' }
--
-- v1 = first-pass extraction (default model: Opus 4.7, no thinking).
-- v2 = optional second pass with extended thinking, triggered by the user.
--
-- Adds a `rethinking` status so the UI can show a distinct "Henry's having
-- another think" message during the second pass.

ALTER TABLE public.project_memos
  DROP CONSTRAINT IF EXISTS project_memos_status_check;

ALTER TABLE public.project_memos
  ADD CONSTRAINT project_memos_status_check
    CHECK (status IN ('pending', 'transcribing', 'extracting', 'rethinking', 'ready', 'failed'));

-- Backfill existing rows. A row is "old shape" if ai_extraction has a
-- `work_items` key at the top level (the flat layout). Wrap it as v1.
UPDATE public.project_memos
SET ai_extraction = jsonb_build_object(
      'v1', ai_extraction,
      'v2', NULL,
      'active', 'v1'
    )
WHERE ai_extraction IS NOT NULL
  AND ai_extraction ? 'work_items';
