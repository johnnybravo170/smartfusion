-- Add name, email, and pre-set worker prefs to worker invites.
-- invited_name  : display name the owner typed when generating the invite
-- invited_email : email address the invite was sent to (for the table)
-- invite_prefs  : JSONB blob of worker settings to auto-apply on signup
alter table worker_invites
  add column if not exists invited_name  text,
  add column if not exists invited_email text,
  add column if not exists invite_prefs  jsonb;
