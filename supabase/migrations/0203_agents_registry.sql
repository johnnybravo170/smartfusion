-- 0203_agents_registry.sql
-- Single registry for every agent (Claude Code Routines, Vercel crons,
-- Managed Agents) plus per-execution run history. Surfaces in the new
-- ops.heyhenry.io/agents dashboard. See kanban 7b85158f for the full plan.
--
-- Why DB-backed (vs. static config):
--   We're shipping many agents. A static registry rots — each new agent
--   becomes a registry edit + deploy. DB-backed = INSERT INTO ops.agents.
--
-- Live in `ops` schema since this is platform-internal observability,
-- not tenant-scoped.

-- ============================================================
-- ops.agents — definition rows
-- ============================================================
CREATE TABLE IF NOT EXISTS ops.agents (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                     TEXT UNIQUE NOT NULL,
  name                     TEXT NOT NULL,
  description              TEXT,
  agent_type               TEXT NOT NULL
                             CHECK (agent_type IN ('routine', 'cron', 'managed')),
  -- Cron expression for crons; human-readable for routines/managed.
  schedule                 TEXT,
  -- Where to dig deeper (claude.ai routine URL, Vercel function URL, etc.)
  external_link            TEXT,
  owner                    TEXT,
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'disabled', 'archived')),
  -- Staleness threshold: if no successful run in this many minutes, the
  -- agent is "stale". NULL = never alert (one-shots / archived).
  expected_max_gap_minutes INTEGER,
  tags                     TEXT[] NOT NULL DEFAULT '{}',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agents_status_idx
  ON ops.agents (status) WHERE status = 'active';

-- ============================================================
-- ops.agent_runs — per-execution rows
-- ============================================================
CREATE TABLE IF NOT EXISTS ops.agent_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES ops.agents(id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  -- 'running' = no finished_at yet; happy path ends as 'success' or
  -- 'skipped' (intentional no-op — solves the "agent ran but did nothing
  -- so worklog skipped" invisibility today). 'failure' is operational.
  outcome         TEXT NOT NULL DEFAULT 'running'
                    CHECK (outcome IN ('running', 'success', 'failure', 'skipped')),
  -- How the run was triggered.
  trigger         TEXT NOT NULL DEFAULT 'schedule'
                    CHECK (trigger IN ('schedule', 'manual', 'webhook', 'backfill')),
  items_scanned   INTEGER,
  items_acted     INTEGER,
  -- One-line summary shown on the list view.
  summary         TEXT,
  -- Long-form payload (verdicts, action lists, sub-results).
  payload         JSONB,
  error           TEXT,
  -- Cost tracking — unused initially; useful at agent #20.
  cost_usd_micros BIGINT
);

CREATE INDEX IF NOT EXISTS agent_runs_agent_started_idx
  ON ops.agent_runs (agent_id, started_at DESC);

-- For surfacing failures + in-flight runs efficiently.
CREATE INDEX IF NOT EXISTS agent_runs_attention_idx
  ON ops.agent_runs (started_at DESC)
  WHERE outcome IN ('failure', 'running');

-- ============================================================
-- ops.agent_health — live view, one row per agent
-- ============================================================
-- Computes derived status from latest run + expected_max_gap_minutes.
-- Live (not materialized) since the page renders sub-second; if this
-- becomes a hotspot we promote later.
CREATE OR REPLACE VIEW ops.agent_health AS
WITH latest AS (
  SELECT DISTINCT ON (agent_id)
    agent_id,
    started_at AS latest_started_at,
    finished_at AS latest_finished_at,
    outcome AS latest_outcome,
    summary AS latest_summary,
    error AS latest_error
  FROM ops.agent_runs
  ORDER BY agent_id, started_at DESC
)
SELECT
  a.id AS agent_id,
  a.slug,
  a.name,
  a.agent_type,
  a.status AS agent_status,
  a.schedule,
  a.expected_max_gap_minutes,
  l.latest_started_at,
  l.latest_finished_at,
  l.latest_outcome,
  l.latest_summary,
  l.latest_error,
  CASE
    WHEN a.status <> 'active' THEN 'inactive'
    WHEN l.latest_started_at IS NULL THEN 'never_run'
    WHEN l.latest_outcome = 'failure' THEN 'broken'
    WHEN l.latest_outcome = 'running'
         AND l.latest_started_at < now() - INTERVAL '30 minutes' THEN 'broken'
    WHEN a.expected_max_gap_minutes IS NOT NULL
         AND l.latest_started_at < now() - (a.expected_max_gap_minutes || ' minutes')::INTERVAL
         THEN 'stale'
    ELSE 'ok'
  END AS computed_status
FROM ops.agents a
LEFT JOIN latest l ON l.agent_id = a.id;

GRANT SELECT ON ops.agent_health TO service_role;

-- ============================================================
-- Permissions + RLS
-- ============================================================
-- ops.* schema convention: service-role only. The /agents page reads via
-- the service client (it's an admin-only surface gated by requirePlatformAdmin).
ALTER TABLE ops.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.agent_runs ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ops.agents, ops.agent_runs
  TO service_role;

-- ============================================================
-- Touch trigger
-- ============================================================
CREATE OR REPLACE FUNCTION ops.agents_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_touch ON ops.agents;
CREATE TRIGGER agents_touch
  BEFORE UPDATE ON ops.agents
  FOR EACH ROW EXECUTE FUNCTION ops.agents_touch_updated_at();

-- ============================================================
-- Comments
-- ============================================================
COMMENT ON TABLE ops.agents IS
  'Registry of every automated agent (Routines, crons, Managed Agents). One row per agent definition.';

COMMENT ON COLUMN ops.agents.expected_max_gap_minutes IS
  'Staleness threshold. If no successful run within this window, agent_health.computed_status = stale. NULL = never alert.';

COMMENT ON TABLE ops.agent_runs IS
  'Per-execution history. outcome=skipped solves the "ran but did nothing" invisibility (today the worklog skips empty runs).';

COMMENT ON VIEW ops.agent_health IS
  'Live view: one row per agent with latest run + computed_status (ok|stale|broken|never_run|inactive).';
