-- 0197_referrals_phone.sql
-- Add a phone column to public.referrals so SMS-initiated invites can
-- record who they went to (mirrors referred_email). Nullable — a referral
-- may have one or the other depending on which channel the operator used.

ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS referred_phone TEXT;

COMMENT ON COLUMN public.referrals.referred_phone IS
  'E.164 phone number of the invited contact when the invite was sent via SMS. Mutually exclusive with referred_email in practice; either may be NULL.';
