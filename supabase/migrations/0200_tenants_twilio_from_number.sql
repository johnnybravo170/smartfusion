-- 0200_tenants_twilio_from_number.sql
--
-- Per-tenant Twilio outbound number. Today every tenant sends from a
-- shared platform number selected by destination country (TWILIO_FROM_US
-- / TWILIO_FROM_CA env vars in pickFromNumber). Once 10DLC approves and
-- each tenant gets their own number, sendSms prefers the tenant column;
-- pickFromNumber stays as the fallback.
--
-- Inbound webhook also uses this column to route incoming SMS to the
-- right tenant by matching the To address against tenants.twilio_from_number.
-- Today's shared-number fallback (PLATFORM_TENANT_ID env) keeps working
-- for tenants that don't have a number assigned yet.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS twilio_from_number TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_tenants_twilio_from_number
  ON public.tenants (twilio_from_number)
  WHERE twilio_from_number IS NOT NULL;

COMMENT ON COLUMN public.tenants.twilio_from_number IS
  'E.164 Twilio number assigned to this tenant for outbound + inbound SMS. NULL = shared platform number (env-var fallback). UNIQUE so the inbound webhook can route To-number → tenant unambiguously.';
