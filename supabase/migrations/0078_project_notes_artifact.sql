-- ============================================================
-- 0078_project_notes_artifact.sql
--
-- Add 'artifact' to project_notes.kind so reference sketches /
-- inspiration shots / drawings dropped through intake can live in
-- the Notes feed with a thumbnail, instead of polluting the estimate
-- as fake cost lines.
-- ============================================================

ALTER TABLE public.project_notes
  DROP CONSTRAINT IF EXISTS project_notes_kind_check;
ALTER TABLE public.project_notes
  ADD  CONSTRAINT project_notes_kind_check
  CHECK (kind IN ('text', 'reply_draft', 'henry_q', 'henry_a', 'artifact'));
