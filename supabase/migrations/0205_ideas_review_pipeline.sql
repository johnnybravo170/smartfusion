-- 0205_ideas_review_pipeline.sql
-- Schema for the ideas review pipeline (kanban card 967e7a5b).
--
-- Two consumers:
--   1. Daily new-ideas digest cron — sweeps ideas with email_sent_at IS NULL
--      created in the last 7 days and emails Jonathan a roll-up.
--   2. Snooze + Sonnet review cron — operator (or agent) sets remind_at on
--      an idea via the ideas_snooze MCP tool; cron sweeps due ideas, asks
--      Sonnet to verdict, dispatches accordingly.
--
-- Both share state on ops.ideas to avoid duplicating tracking. The
-- review_status enum gates concurrent runs (pending → reviewing →
-- actioned/re_snoozed/dismissed/errored) via optimistic locking.

ALTER TABLE ops.ideas
  -- Daily-digest dedup: NULL = not yet emailed; once set, the daily
  -- cron skips this idea forever. Each idea gets at most one digest mention.
  ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ,
  -- Snooze: when set, the review cron picks this idea up at/after this time.
  -- NULL = not snoozed; ignored by review cron.
  ADD COLUMN IF NOT EXISTS remind_at TIMESTAMPTZ,
  -- State machine for the review cron.
  --   pending      — eligible for review at remind_at (or just initial state)
  --   reviewing    — cron has picked it up; held briefly during the Sonnet call
  --   actioned     — Sonnet said actionable, email sent
  --   re_snoozed   — Sonnet said not_yet, remind_at bumped forward
  --   dismissed    — Sonnet said dismiss; idea also archived
  --   errored      — transient failure (Sonnet/email/context-assembly); cron
  --                  retries up to N times then leaves it errored for human
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'reviewing', 'actioned', 're_snoozed', 'dismissed', 'errored')),
  ADD COLUMN IF NOT EXISTS last_review_attempt_at TIMESTAMPTZ,
  -- Failure count for the errored backoff. Reset on success.
  ADD COLUMN IF NOT EXISTS review_attempt_count INTEGER NOT NULL DEFAULT 0;

-- Daily-digest sweep — ideas without email yet, created recently.
CREATE INDEX IF NOT EXISTS ideas_pending_digest_idx
  ON ops.ideas (created_at DESC)
  WHERE archived_at IS NULL AND email_sent_at IS NULL;

-- Review-cron sweep — ideas with a remind_at that's coming due.
CREATE INDEX IF NOT EXISTS ideas_due_review_idx
  ON ops.ideas (remind_at)
  WHERE archived_at IS NULL AND review_status = 'pending' AND remind_at IS NOT NULL;

-- Errored-tail surface for the agents dashboard.
CREATE INDEX IF NOT EXISTS ideas_errored_idx
  ON ops.ideas (last_review_attempt_at DESC)
  WHERE archived_at IS NULL AND review_status = 'errored';

COMMENT ON COLUMN ops.ideas.email_sent_at IS
  'Daily-digest dedup. NULL = idea has not been included in any digest email yet. Once set, the daily cron skips this idea forever.';

COMMENT ON COLUMN ops.ideas.remind_at IS
  'Set by ideas_snooze MCP tool. The review cron picks this idea up at/after this time and asks Sonnet whether it''s actionable in current context.';

COMMENT ON COLUMN ops.ideas.review_status IS
  'State machine for the snooze-review cron. pending → reviewing (atomic flip with optimistic lock) → actioned | re_snoozed | dismissed | errored.';

COMMENT ON COLUMN ops.ideas.review_attempt_count IS
  'Failure counter for the errored state. Cron retries with exponential backoff up to N times then halts on this idea, awaiting human triage.';
