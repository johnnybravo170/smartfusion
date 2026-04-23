-- Email + SMS verification during onboarding.
--
-- Two checks gated at the dashboard layout:
--   1. auth.users.email_confirmed_at — Supabase's built-in email confirmation
--      (we now actually send the verification email instead of auto-confirming).
--   2. tenant_members.phone_verified_at — operator-confirmed phone via
--      6-digit OTP we generate and send via the existing Twilio setup.
--
-- Existing tenant_members are grandfathered (phone_verified_at backfilled
-- to created_at) so they don't get blocked on next login.

ALTER TABLE public.tenant_members
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;

UPDATE public.tenant_members
  SET phone_verified_at = COALESCE(phone_verified_at, created_at)
  WHERE phone_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS public.phone_verification_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  phone        text NOT NULL,
  code         text NOT NULL CHECK (length(code) = 6),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_phone_verif_user_unconsumed
  ON public.phone_verification_codes (user_id, created_at DESC)
  WHERE consumed_at IS NULL;

ALTER TABLE public.phone_verification_codes ENABLE ROW LEVEL SECURITY;

-- Only the owning user can read their codes (we send + verify via the admin
-- client server-side anyway; this RLS is a defense-in-depth backstop).
CREATE POLICY phone_verif_self_select ON public.phone_verification_codes
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
