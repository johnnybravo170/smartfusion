-- 0193_phase_notify_deferred.sql
-- Phase 2 of PORTAL_PHASES_PLAN.md.
--
-- Defer the homeowner notification on phase advance so a contractor
-- bulk-advancing during catch-up doesn't spam the homeowner with a
-- chain of texts. Three new columns:
--
--   notify_scheduled_at  — when the cron drainer should fire the SMS /
--                          email. Set to NOW() + delay when a phase
--                          transitions to in_progress. NULL otherwise.
--   notify_sent_at       — stamped by the cron drainer when the
--                          notification actually went out. Idempotency
--                          flag — drainer skips rows where this is set.
--   notify_cancelled_at  — stamped when the contractor hits Undo, or
--                          when a subsequent advance "replaces" the
--                          pending notification (cancel old, schedule
--                          new on the new in-progress phase).
--
-- The pending-notify state is 1:1 with the in_progress phase. Modelling
-- it on the phase row instead of a separate queue table keeps the
-- semantics ("there is at most one pending notify per project at any
-- time") naturally enforced.
--
-- The partial index covers the cron drainer's hot query: pick phases
-- whose notify is due, not yet sent, not cancelled.

ALTER TABLE public.project_phases
  ADD COLUMN IF NOT EXISTS notify_scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notify_sent_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notify_cancelled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_project_phases_notify_pending
  ON public.project_phases (notify_scheduled_at)
  WHERE notify_sent_at IS NULL
    AND notify_cancelled_at IS NULL
    AND notify_scheduled_at IS NOT NULL;

COMMENT ON COLUMN public.project_phases.notify_scheduled_at IS
  'When the cron drainer should send the homeowner notification for this phase transitioning to in_progress. NULL when no notification is pending.';
COMMENT ON COLUMN public.project_phases.notify_sent_at IS
  'When the cron drainer actually sent the notification. Idempotency flag — drainer skips rows where this is set.';
COMMENT ON COLUMN public.project_phases.notify_cancelled_at IS
  'When a pending notification was cancelled (operator Undo, or replaced by a subsequent phase advance).';
