-- Add recognized_customer_id to intake_drafts.
--
-- When the operator's customer name (or the one extracted from the
-- audio / pasted text) matches an existing customer in the tenant,
-- Henry pulls that customer's last few projects' patterns into the
-- parse prompt so suggestions, categories, and the reply draft skew
-- toward what we already know about how this customer works.
--
-- The column lets the UI render a "Henry recognized {customer_name}"
-- pill on the review screen — the operator can SEE that history was
-- folded in, instead of being left wondering whether the result is
-- generic or context-aware. It also lets future evals correlate
-- intake quality before/after context fold-in.

ALTER TABLE public.intake_drafts
  ADD COLUMN IF NOT EXISTS recognized_customer_id UUID
    REFERENCES public.customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_intake_drafts_recognized_customer
  ON public.intake_drafts (recognized_customer_id)
  WHERE recognized_customer_id IS NOT NULL;
