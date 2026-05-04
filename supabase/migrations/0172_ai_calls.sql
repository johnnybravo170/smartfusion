-- 0172_ai_calls.sql
-- AG-5 — telemetry table for the AI gateway. Every router attempt
-- (success or failure) writes one row. Powers AG-8 (admin dashboard)
-- and AG-6 (spend tracker / tier-climb policy).
--
-- Privacy posture: AI cost data is platform infrastructure, NOT
-- tenant data. Tenant members should NOT see how much their tenant
-- costs us in AI spend (it's competitive + a renegotiation lever).
-- Therefore:
--   - Reads are admin-only (platform admin role only).
--   - Writes go through the service-role admin client (bypasses RLS).
--   - tenant_id is nullable: system / cron jobs without a tenant
--     context still log so we can audit cron AI spend.
--
-- Retention: keep 90 days, then either drop or roll up to daily
-- aggregates. Defer that — we'll handle it when volume hits 1M+ rows.
-- (At ~10k AI calls/day per active tenant, 90 days × 10 tenants = ~9M
-- rows. Index sizes stay sub-GB; manageable.)

CREATE TABLE IF NOT EXISTS public.ai_calls (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable on purpose. SET NULL on delete so the audit trail
  -- survives tenant churn — admin dashboard can still see "this
  -- much spend went to a now-deleted tenant."
  tenant_id     UUID REFERENCES public.tenants (id) ON DELETE SET NULL,

  task          TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  api_key_label TEXT,

  status        TEXT NOT NULL,
  attempt_index INT NOT NULL DEFAULT 0,

  tokens_in     INT,
  tokens_out    INT,
  cost_micros   BIGINT,
  latency_ms    INT NOT NULL,

  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ai_calls_status_valid CHECK (
    status IN ('success', 'quota', 'overload', 'rate_limit', 'invalid_input', 'auth', 'timeout', 'unknown')
  ),
  CONSTRAINT ai_calls_provider_valid CHECK (
    provider IN ('openai', 'gemini', 'anthropic', 'noop')
  )
);

-- Recent activity (admin dashboard 'last 50 failures' table).
CREATE INDEX IF NOT EXISTS idx_ai_calls_created
  ON public.ai_calls (created_at DESC);

-- Per-provider spend / failure rate rollup.
CREATE INDEX IF NOT EXISTS idx_ai_calls_provider_created
  ON public.ai_calls (provider, created_at DESC);

-- Per-task rollup (which task is racking up the bill).
CREATE INDEX IF NOT EXISTS idx_ai_calls_task_created
  ON public.ai_calls (task, created_at DESC);

-- Per-tenant rollup, partial — most rows have tenant_id; null rows are
-- the cron / system minority and don't need this lookup path.
CREATE INDEX IF NOT EXISTS idx_ai_calls_tenant_created
  ON public.ai_calls (tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;

-- ============================================================
-- RLS — locked down. Admin-only read; writes via service role.
-- ============================================================
ALTER TABLE public.ai_calls ENABLE ROW LEVEL SECURITY;

-- Tenant members get NOTHING. No tenant-scoped read policy.
-- Platform admins read via the admin client (bypasses RLS).
-- Writes likewise go through the admin client.

-- A no-op policy so the table doesn't end up wide-open if RLS gets
-- toggled off elsewhere. Anon/authenticated see zero rows by default
-- under RLS-enabled-with-no-permissive-policy semantics; this is
-- belt-and-suspenders.
CREATE POLICY ai_calls_no_authenticated_access ON public.ai_calls
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

COMMENT ON TABLE public.ai_calls IS
  'AI gateway per-attempt telemetry. Platform infra, not tenant data — RLS denies all authenticated access; reads + writes go through the admin client.';
