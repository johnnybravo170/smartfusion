-- Add provider column to henry_interactions.
-- Tracks which voice provider handled each session ('openai' | 'gemini').
-- Nullable so existing rows are unaffected.

ALTER TABLE public.henry_interactions
  ADD COLUMN IF NOT EXISTS provider TEXT;

COMMENT ON COLUMN public.henry_interactions.provider IS
  'Voice provider used for this interaction: ''openai'' or ''gemini''. NULL for pre-provider-abstraction rows.';