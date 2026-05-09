-- Record ToS + Privacy Policy acceptance per tenant_member.
-- Versions are date strings (e.g. '2026-05-09') stored alongside an accepted_at
-- timestamp so we can re-prompt on policy bumps without losing the audit trail.
alter table public.tenant_members
  add column if not exists tos_version text,
  add column if not exists tos_accepted_at timestamptz,
  add column if not exists privacy_version text,
  add column if not exists privacy_accepted_at timestamptz;
