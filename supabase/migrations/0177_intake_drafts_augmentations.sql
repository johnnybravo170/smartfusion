-- Add the augmentations column to intake_drafts.
--
-- After Stage B (parse) lands a draft estimate, a third pass asks Henry
-- "what's likely missing from this scope?" — pattern-matching against
-- renovation knowledge to surface common-but-not-mentioned items
-- (transition strips at doorways, casing alongside baseboards, etc.).
--
-- Each suggestion is the operator's to accept ("Add to estimate" →
-- creates a line in the editable draft) or dismiss. Local-only state in
-- this slice; persisting on the row makes the suggestions refresh-safe
-- and gives us a fixture to evaluate against later.

ALTER TABLE public.intake_drafts
  ADD COLUMN IF NOT EXISTS augmentations JSONB NOT NULL DEFAULT '[]'::jsonb;
