-- 0131_decision_options.sql
-- Multi-option decision votes (paint colors, tile picks, allowance choices).
-- When options is non-empty, the homeowner picks ONE; decided_value
-- stores the picked option. When options is empty/null the existing
-- binary Approve / Decline flow is unchanged.

ALTER TABLE public.project_decisions
  ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.project_decisions.options IS
  'Optional array of choice strings ["Simply White","Chantilly Lace","Decorator''s White"]. Empty array = binary approve/decline. Non-empty = radio-button vote; decided_value stores the picked option text.';
