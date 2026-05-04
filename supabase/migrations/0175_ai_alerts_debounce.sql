-- Debounce ledger for AI provider alerts (rate limit / quota / overload).
--
-- The alert hook in the gateway emails the operator when a provider call
-- fails with one of these kinds. Without debouncing, a sustained outage
-- would flood the inbox. This table holds one row per (provider, kind)
-- and tracks `last_sent_at`; the hook claims the slot via an atomic
-- INSERT...ON CONFLICT DO UPDATE that only writes when the previous
-- alert is older than the debounce window.

CREATE TABLE IF NOT EXISTS public.ai_alerts (
  provider      TEXT NOT NULL,
  kind          TEXT NOT NULL,
  last_sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, kind)
);

-- No RLS — this is platform-internal, written by the gateway hook via
-- the admin client and never read by tenant traffic.

-- Atomic claim: returns true iff this caller is the one who locks the
-- slot for sending an alert. Either the row didn't exist (insert wins)
-- or the existing row's last_sent_at is older than the debounce window
-- (the WHERE on DO UPDATE makes the update conditional, and RETURNING
-- only emits a row when the upsert actually wrote).
CREATE OR REPLACE FUNCTION public.ai_alerts_claim_slot(
  p_provider TEXT,
  p_kind TEXT,
  p_debounce_minutes INT
) RETURNS BOOLEAN
LANGUAGE sql
AS $$
  WITH upsert AS (
    INSERT INTO public.ai_alerts (provider, kind, last_sent_at)
    VALUES (p_provider, p_kind, now())
    ON CONFLICT (provider, kind) DO UPDATE
      SET last_sent_at = now()
      WHERE public.ai_alerts.last_sent_at < now() - (p_debounce_minutes || ' minutes')::interval
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM upsert);
$$;
