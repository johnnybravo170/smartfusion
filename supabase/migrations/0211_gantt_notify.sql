-- 0211_gantt_notify.sql
-- v1 third slice — homeowner notification on schedule changes.
--
-- Tenant-level opt-in (default OFF). When ON, drag/edit changes to
-- client_visible=true `project_schedule_tasks` schedule a deferred
-- notification to the customer. The notify is debounced at the
-- *project* level (not per task), so an operator dragging five bars in
-- thirty seconds produces one rollup email rather than a barrage.
--
-- Mirrors the existing project_phases.notify_* pattern (see
-- 0193_phase_notify_deferred.sql) — same scheduled / sent / cancelled
-- triple, same partial index for the cron drainer hot-query, same
-- "reset all three when scheduling new" semantics in the action layer.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS notify_customer_on_schedule_change BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS schedule_notify_scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS schedule_notify_sent_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS schedule_notify_cancelled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_projects_schedule_notify_pending
  ON public.projects (schedule_notify_scheduled_at)
  WHERE schedule_notify_sent_at IS NULL
    AND schedule_notify_cancelled_at IS NULL
    AND schedule_notify_scheduled_at IS NOT NULL;

COMMENT ON COLUMN public.tenants.notify_customer_on_schedule_change IS
  'When ON, edits to client_visible=true schedule tasks (drag, resize, manual) fire a deferred customer notification debounced at the project level. Default OFF — opt-in.';

COMMENT ON COLUMN public.projects.schedule_notify_scheduled_at IS
  'When the cron drainer should send the homeowner schedule-update notification. NULL when no notification is pending.';
COMMENT ON COLUMN public.projects.schedule_notify_sent_at IS
  'When the drainer actually sent the notification. Idempotency flag — drainer skips rows where this is set.';
COMMENT ON COLUMN public.projects.schedule_notify_cancelled_at IS
  'When the pending notification was cancelled (e.g. tenant flag turned off) or replaced by a subsequent edit.';
