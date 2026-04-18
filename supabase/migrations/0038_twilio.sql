-- Twilio SMS foundation: outbound + inbound message log, and per-recipient
-- opt-out tracking. Templates + scheduling (appointment reminders, review
-- requests, etc.) layered in a follow-up migration.

-- ---------------------------------------------------------------------------
-- twilio_messages — every SMS event, outbound and inbound.
-- ---------------------------------------------------------------------------

CREATE TABLE public.twilio_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

  -- Twilio's own SID for the message. Null while queued locally, filled in
  -- once the API call succeeds.
  sid TEXT UNIQUE,

  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),

  -- Sender identity. `platform` means Hey Henry → operator; `operator` means
  -- operator → their customer. Drives the signoff in templates.
  identity TEXT NOT NULL DEFAULT 'operator'
    CHECK (identity IN ('operator', 'platform')),

  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
  body TEXT NOT NULL,

  -- Links back to whatever record triggered the send, for the activity feed.
  related_type TEXT CHECK (related_type IN ('job', 'quote', 'invoice', 'customer', 'support_ticket', 'platform')),
  related_id UUID,

  -- Twilio delivery lifecycle: queued → sent → delivered | failed | undelivered.
  status TEXT NOT NULL DEFAULT 'queued',
  error_code TEXT,
  error_message TEXT,

  price_usd NUMERIC(10, 5),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);

CREATE INDEX twilio_messages_tenant_created_idx
  ON public.twilio_messages (tenant_id, created_at DESC);

CREATE INDEX twilio_messages_related_idx
  ON public.twilio_messages (related_type, related_id)
  WHERE related_id IS NOT NULL;

CREATE INDEX twilio_messages_to_idx
  ON public.twilio_messages (to_number);

ALTER TABLE public.twilio_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY twilio_messages_tenant_select
  ON public.twilio_messages
  FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id());

-- Writes go through the service role from the Twilio client wrapper; no
-- direct tenant INSERT.

-- ---------------------------------------------------------------------------
-- sms_preferences — recipient-level opt-out. Keyed by phone number because
-- we may message the same person across multiple tenants (e.g. homeowners
-- who use more than one service contractor).
-- ---------------------------------------------------------------------------

CREATE TABLE public.sms_preferences (
  phone_number TEXT PRIMARY KEY,
  opted_out BOOLEAN NOT NULL DEFAULT false,
  opted_out_at TIMESTAMPTZ,
  source TEXT CHECK (source IN ('stop_reply', 'ui', 'admin', 'import')),
  last_inbound_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No RLS — this is global. Only the Twilio client and webhook write to it
-- (via the service role). Reads also happen server-side only.
