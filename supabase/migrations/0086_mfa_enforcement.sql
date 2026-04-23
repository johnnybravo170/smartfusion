-- MFA enforcement (Phase 3 of MFA_PLAN.md).
--
-- Two knobs:
--
--   1. tenants.require_mfa_for_all_members — owner-controlled toggle. When
--      false (default), only the tenant owner is required to enroll.
--      When true, every member of the tenant is required.
--
--   2. tenant_members.mfa_grace_started_at — when the 14-day grace period
--      began for this member. Set to now() on their first post-enforcement
--      login by the app layer. After grace, the app soft-locks sensitive
--      actions (Stripe Connect, team management, data export, etc.) until
--      the user enrolls.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS require_mfa_for_all_members boolean NOT NULL DEFAULT false;

ALTER TABLE public.tenant_members
  ADD COLUMN IF NOT EXISTS mfa_grace_started_at timestamptz;
