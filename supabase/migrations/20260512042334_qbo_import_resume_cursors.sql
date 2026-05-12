-- Cursors for resumable QBO imports.
--
-- A QBO import for a multi-year company can outrun Vercel's 300s
-- server-action budget. Phase 4d-4 introduces cron-driven resume:
-- the worker exits gracefully when it hits a soft time budget, marks
-- the job 'queued', and a per-minute cron picks it up where it left
-- off.
--
-- Per-entity STARTPOSITION cursors live on the job row so the next
-- run can skip pages we already processed. Idempotency on QBO id
-- means re-running the same page would still be safe, but cursoring
-- saves API calls (which Mike pays for past 500k/mo).

ALTER TABLE public.qbo_import_jobs
  ADD COLUMN IF NOT EXISTS current_entity TEXT,
  ADD COLUMN IF NOT EXISTS entity_cursors JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_qbo_import_jobs_queued_resumable
  ON public.qbo_import_jobs (tenant_id, created_at)
  WHERE status = 'queued' AND current_entity IS NOT NULL;
