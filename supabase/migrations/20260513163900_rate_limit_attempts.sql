-- Rate limit ledger.
--
-- One row per attempt. The limiter counts rows for a given bucket within a
-- rolling window; if the count is at/above the limit, the attempt is denied
-- and no row is inserted.
--
-- Buckets in use as of the enterprise-readiness audit (2026-04-22):
--   signup:ip:<ip>          — 5 per 10 min
--   signup:email:<email>    — 5 per hour
--   magic:ip:<ip>           — 10 per 10 min
--   magic:email:<email>     — 5 per hour
--   phone:resend:<e164>     — 3 per hour   (SMS-bombing protection)
--
-- Retention: a cron job (TODO) trims rows older than the longest window we
-- use (1 hour). The (bucket, attempted_at DESC) index keeps the count
-- query fast even before retention runs.

CREATE TABLE IF NOT EXISTS public.rate_limit_attempts (
  bucket        text NOT NULL,
  attempted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_attempts_bucket_time
  ON public.rate_limit_attempts (bucket, attempted_at DESC);

ALTER TABLE public.rate_limit_attempts ENABLE ROW LEVEL SECURITY;

-- No policies — only the service-role client writes and reads this table.
