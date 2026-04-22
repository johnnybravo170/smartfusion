-- ============================================================
-- 0077_project_notes_kinds.sql
--
-- Extend project_notes to carry different kinds of entries through
-- the Notes feed:
--   - text          plain operator note (default)
--   - reply_draft   reply Henry drafted to send back to a customer
--   - henry_q       a question the operator asked Henry
--   - henry_a       Henry's answer
--
-- metadata holds kind-specific extras (customer name, model, etc).
-- ============================================================

ALTER TABLE public.project_notes
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS metadata JSONB;

ALTER TABLE public.project_notes
  DROP CONSTRAINT IF EXISTS project_notes_kind_check;
ALTER TABLE public.project_notes
  ADD  CONSTRAINT project_notes_kind_check
  CHECK (kind IN ('text', 'reply_draft', 'henry_q', 'henry_a'));

CREATE INDEX IF NOT EXISTS idx_project_notes_kind
  ON public.project_notes (project_id, kind, created_at DESC);
