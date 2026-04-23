-- 0087_ops_oauth.sql
-- Minimal OAuth 2.1 provider for the ops MCP endpoint.
--
-- Lets Anthropic Routines (and other custom-connector clients) connect to
-- /api/mcp via the standard OAuth 2.1 + PKCE flow instead of a long-lived
-- ops_<id>_<secret> bearer. The HMAC api_keys system stays in place for
-- /api/ops/* REST routes.
--
-- Two tables, both service-role-only (RLS enabled, no policies).

-- ops.oauth_codes — short-lived authorization codes issued by /authorize.
CREATE TABLE IF NOT EXISTS ops.oauth_codes (
  code            TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  scopes          TEXT[] NOT NULL,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_oauth_codes_expires_idx
  ON ops.oauth_codes (expires_at);

-- ops.oauth_tokens — issued access + refresh tokens.
-- Raw tokens are NEVER stored; only sha256 hashes. Refresh chain via
-- parent_token_id so we can revoke a leaked family.
CREATE TABLE IF NOT EXISTS ops.oauth_tokens (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token_hash  TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT UNIQUE,
  client_id          TEXT NOT NULL,
  scopes             TEXT[] NOT NULL,
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  parent_token_id    UUID REFERENCES ops.oauth_tokens(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_oauth_tokens_expires_idx
  ON ops.oauth_tokens (expires_at);
CREATE INDEX IF NOT EXISTS ops_oauth_tokens_refresh_idx
  ON ops.oauth_tokens (refresh_token_hash) WHERE refresh_token_hash IS NOT NULL;

ALTER TABLE ops.oauth_codes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.oauth_tokens ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only.
