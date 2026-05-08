-- Track whether a tenant has been sent the post-signup "welcome from
-- Jonathan" email. Idempotency guard so the helper is safe to call from
-- multiple paths (signup, future operator-invite acceptance, etc.).
alter table public.tenants
  add column if not exists welcome_email_sent_at timestamptz;

comment on column public.tenants.welcome_email_sent_at is
  'Stamp set when the post-signup welcome email is sent. Null = not yet sent. Used as an idempotency guard.';
