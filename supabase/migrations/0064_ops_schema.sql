-- 0049_ops_schema.sql
-- Platform Ops — foundation tables for ops.heyhenry.io.
--
-- Strictly isolated from tenant data:
--   * Separate `ops` schema (not `public`)
--   * No tenant_id columns anywhere
--   * Access is admin-whitelist (humans) or API-key-scoped (agents) only
--   * The `authenticated` role has zero access — prevents a tenant login
--     from reaching ops data through any accidental path.
--
-- See OPS_PLAN.md for the full architecture.

CREATE SCHEMA IF NOT EXISTS ops;

-- No one gets USAGE on this schema except postgres + service_role + explicit
-- grants below. Revoking PUBLIC usage is the key line that prevents random
-- role escalation via search_path tricks.
REVOKE ALL ON SCHEMA ops FROM PUBLIC;
GRANT USAGE ON SCHEMA ops TO service_role;

-- ---------------------------------------------------------------------------
-- ops.admins — human platform-admin allowlist.
-- Only users in this table can authenticate against ops.heyhenry.io.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.admins (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by UUID REFERENCES auth.users(id)
);

-- ---------------------------------------------------------------------------
-- ops.api_keys — agent API keys.
--
-- secret_hash stores SHA-256 of the raw secret. API key secrets are
-- high-entropy random tokens (256 bits) that we generate, not user passwords,
-- so a plain cryptographic hash is appropriate — argon2 exists to slow down
-- brute force against low-entropy user input, which does not apply here.
-- See OPS_PLAN.md §Security.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.api_keys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  owner_user_id  UUID NOT NULL REFERENCES auth.users(id),
  scopes         TEXT[] NOT NULL DEFAULT '{}',
  ip_allowlist   CIDR[] NOT NULL DEFAULT '{}',
  secret_hash    TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  last_used_at   TIMESTAMPTZ,
  last_used_ip   INET,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ops_api_keys_active_idx
  ON ops.api_keys (id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- ops.audit_log — immutable audit trail for every mutation + auth failure.
-- INSERT only; no UPDATE or DELETE policies. Maintenance agent prunes rows
-- older than 1 year via a SECURITY DEFINER function (future).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id        UUID REFERENCES ops.api_keys(id) ON DELETE SET NULL,
  admin_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  status        INT NOT NULL,
  ip            INET,
  user_agent    TEXT,
  body_sha256   TEXT,
  reason        TEXT,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_audit_log_time_idx
  ON ops.audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS ops_audit_log_key_time_idx
  ON ops.audit_log (key_id, occurred_at DESC) WHERE key_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ops.rate_limit_events — sliding-window rate-limit counter store.
-- Phase-0 backend (Supabase). Swap to Vercel KV / Upstash when traffic grows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.rate_limit_events (
  key_id      UUID NOT NULL REFERENCES ops.api_keys(id) ON DELETE CASCADE,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_rate_limit_key_time_idx
  ON ops.rate_limit_events (key_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- ops.worklog_entries — Phase 0 feature. Agent + human work log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops.worklog_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('human', 'agent')),
  actor_name    TEXT NOT NULL,
  key_id        UUID REFERENCES ops.api_keys(id) ON DELETE SET NULL,
  admin_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  category      TEXT,
  site          TEXT,
  title         TEXT,
  body          TEXT,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  archived_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_worklog_recent_idx
  ON ops.worklog_entries (created_at DESC) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- RLS — ALL ops tables are RLS-enabled. Only service_role (used by the ops
-- API server handlers) can touch them. The `authenticated` role has zero
-- policies, so a tenant-facing login CANNOT reach ops data even with a
-- leaked JWT. All ops access flows through server code that:
--   1. Verifies the admin whitelist OR the API-key HMAC
--   2. Uses the service_role client scoped to this request
-- ---------------------------------------------------------------------------
ALTER TABLE ops.admins              ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.api_keys            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.audit_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.rate_limit_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.worklog_entries     ENABLE ROW LEVEL SECURITY;

-- No policies = nothing accessible except via service_role (which bypasses RLS).

-- Table-level grants: only service_role.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ops TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA ops
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA ops
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;

-- Seed Jonathan's admin row if his user exists. (Idempotent — if the email
-- isn't in auth.users yet, this is a no-op.)
INSERT INTO ops.admins (user_id, granted_at)
SELECT id, now() FROM auth.users WHERE email = 'riffninjavideos@gmail.com'
ON CONFLICT (user_id) DO NOTHING;
