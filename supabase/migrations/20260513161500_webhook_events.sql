-- Webhook idempotency table.
--
-- Stripe, Twilio, Postmark all retry webhooks under load (Stripe up to 3 days
-- of exponential backoff). Today's handlers rely on provider-side dedup or
-- accidental upsert semantics; this table gives every route an explicit
-- "claim" that succeeds only on first delivery.
--
-- Usage (server-side):
--   const claim = await claimWebhookEvent('stripe', event.id, body);
--   if (!claim.ok) return new Response('ok', { status: 200 }); // already processed
--
-- The composite primary key (provider, event_id) is the natural dedup key.
-- Each handler decides what makes a unique event_id for its provider:
--   - Stripe        → event.id (unique per delivery, stable across retries)
--   - Twilio inbound→ MessageSid
--   - Twilio status → MessageSid:MessageStatus (one row per status transition)
--   - Postmark in   → MessageID
--   - Postmark AR   → MessageID:RecordType (one row per event type per message)
--
-- Retention: 90 days. Keeps the table small while still covering Stripe's
-- 3-day retry window with plenty of buffer for forensics.

CREATE TABLE IF NOT EXISTS public.webhook_events (
  provider     text NOT NULL,
  event_id     text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  body         jsonb,
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_received
  ON public.webhook_events (received_at);

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- No tenant-scoped policies — this table is only written and read by the
-- service-role client from webhook handlers. RLS-on with no policies =
-- nothing reaches it from the anon/authenticated keys.
