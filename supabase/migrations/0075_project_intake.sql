-- ============================================================
-- 0075_project_intake.sql
--
-- Inbound lead ingestion: when a project is created from a parsed
-- text thread (screenshots + reference photos + AI extraction),
-- record where it came from and any signals the AI surfaced
-- (competitive pressure, design intent, upsell opt-outs).
-- ============================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS intake_source TEXT,
  ADD COLUMN IF NOT EXISTS intake_signals JSONB;

-- Constrain known sources; nullable for everything created the old way.
ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_intake_source_check;
ALTER TABLE public.projects
  ADD  CONSTRAINT projects_intake_source_check
  CHECK (intake_source IS NULL OR intake_source IN ('manual', 'text-thread', 'sms', 'share-sheet'));

-- Index so we can find leads marked high-urgency for the dashboard
-- without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_projects_high_urgency
  ON public.projects ((intake_signals->>'urgency'))
  WHERE intake_signals->>'urgency' = 'high';
