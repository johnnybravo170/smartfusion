-- ============================================================
-- ops.agent_evidence — derive last-activity per agent slug from real writes
-- ============================================================
-- Background: routines authenticate via a single shared OAuth client
-- (https://claude.ai/oauth/mcp-oauth-client-metadata), so actor_name is
-- the same across every routine. Routines also rarely self-instrument
-- via agent_run_start/agent_run_finish — most rows in ops.agent_runs
-- were backfilled manually. That made ops.agent_health show false
-- "stale"/"never_run" states for routines that *are* working.
--
-- Fix: derive freshness per slug from the tagged writes each agent
-- produces. Cron-type agents that already self-instrument via
-- withAgentRun keep working through ops.agent_runs — this view is
-- additive. Where both signals exist, the agent_health view below
-- takes GREATEST(latest_started_at, latest_evidence_at).
--
-- Truly silent agents (no tagged writes, no instrumented runs) still
-- show "never_run" — which is what we want.

CREATE OR REPLACE VIEW ops.agent_evidence AS
WITH per_source AS (
  -- business-scout — ideas tagged biz-scout
  SELECT
    'business-scout'::text AS slug,
    MAX(created_at)        AS last_evidence_at,
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int AS evidence_24h,
    'ops.ideas tag=biz-scout'::text AS evidence_source
  FROM ops.ideas
  WHERE 'biz-scout' = ANY(tags)

  UNION ALL

  -- ai-tools-scout — ideas tagged ai-tools OR ai-scout
  SELECT
    'ai-tools-scout',
    MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.ideas tag=ai-tools|ai-scout'
  FROM ops.ideas
  WHERE 'ai-tools' = ANY(tags) OR 'ai-scout' = ANY(tags)

  UNION ALL

  -- ai-tools-scout — knowledge_docs tagged heyhenry-ai-tools
  SELECT
    'ai-tools-scout',
    MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.knowledge_docs tag=heyhenry-ai-tools'
  FROM ops.knowledge_docs
  WHERE 'heyhenry-ai-tools' = ANY(tags)

  UNION ALL

  -- marketing-strategist — ideas tagged marketing-scout
  SELECT
    'marketing-strategist',
    MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.ideas tag=marketing-scout'
  FROM ops.ideas
  WHERE 'marketing-scout' = ANY(tags)

  UNION ALL

  -- competitive-research — knowledge_docs tagged competitor/competitive/etc.
  SELECT
    'competitive-research',
    MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.knowledge_docs tag=competitor|competitive|competitive-intel|competitor-deep-profile'
  FROM ops.knowledge_docs
  WHERE tags && ARRAY['competitor','competitive','competitive-intel','competitor-deep-profile']::text[]

  UNION ALL

  -- competitive-research — competitors table updates
  SELECT
    'competitive-research',
    MAX(updated_at),
    COUNT(*) FILTER (WHERE updated_at > now() - INTERVAL '24 hours')::int,
    'ops.competitors.updated_at'
  FROM ops.competitors

  UNION ALL

  -- pain-points-research — ideas tagged pain-points
  SELECT
    'pain-points-research',
    MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.ideas tag=pain-points'
  FROM ops.ideas
  WHERE 'pain-points' = ANY(tags)

  UNION ALL

  -- security-probe — incidents this agent opens (assigned_agent or actor)
  SELECT
    'security-probe',
    MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.incidents assigned_agent=security-probe'
  FROM ops.incidents
  WHERE assigned_agent = 'security-probe'

  UNION ALL

  -- helpdesk-triage — incidents it handles
  SELECT
    'helpdesk-triage',
    MAX(updated_at),
    COUNT(*) FILTER (WHERE updated_at > now() - INTERVAL '24 hours')::int,
    'ops.incidents assigned_agent=helpdesk-triage'
  FROM ops.incidents
  WHERE assigned_agent = 'helpdesk-triage'

  UNION ALL

  -- doc-writer — knowledge_docs tagged auto:doc-writer
  SELECT
    'doc-writer',
    MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.knowledge_docs tag=auto:doc-writer'
  FROM ops.knowledge_docs
  WHERE 'auto:doc-writer' = ANY(tags)

  UNION ALL

  -- doc-writer — engineer-audience docs
  SELECT
    'doc-writer',
    MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.docs'
  FROM ops.docs

  UNION ALL

  -- ideas-digest — sets email_sent_at on ideas
  SELECT
    'ideas-digest',
    MAX(email_sent_at),
    COUNT(*) FILTER (WHERE email_sent_at > now() - INTERVAL '24 hours')::int,
    'ops.ideas.email_sent_at'
  FROM ops.ideas
  WHERE email_sent_at IS NOT NULL

  UNION ALL

  -- ideas-review — sets review_status / last_review_attempt_at
  SELECT
    'ideas-review',
    MAX(last_review_attempt_at),
    COUNT(*) FILTER (WHERE last_review_attempt_at > now() - INTERVAL '24 hours')::int,
    'ops.ideas.last_review_attempt_at'
  FROM ops.ideas
  WHERE last_review_attempt_at IS NOT NULL

  UNION ALL

  -- git-stats — last refresh
  SELECT
    'git-stats',
    MAX(last_refreshed),
    COUNT(*) FILTER (WHERE last_refreshed > now() - INTERVAL '24 hours')::int,
    'ops.git_daily_stats.last_refreshed'
  FROM ops.git_daily_stats

  UNION ALL

  -- maintenance-weekly — last maintenance run
  SELECT
    'maintenance-weekly',
    MAX(started_at),
    COUNT(*) FILTER (WHERE started_at > now() - INTERVAL '7 days')::int,
    'ops.maintenance_runs kind=weekly'
  FROM ops.maintenance_runs
  WHERE kind = 'weekly'
),
ranked AS (
  -- Pick the most-recent evidence source per slug, but sum the 24h counts
  -- across all sources so we don't undercount cross-table activity.
  SELECT
    slug,
    MAX(last_evidence_at) AS latest_evidence_at,
    SUM(evidence_24h)::int AS evidence_24h,
    -- Pick the source string corresponding to the row with the max timestamp.
    (ARRAY_AGG(evidence_source ORDER BY last_evidence_at DESC NULLS LAST))[1] AS evidence_source
  FROM per_source
  WHERE last_evidence_at IS NOT NULL
  GROUP BY slug
)
SELECT slug, latest_evidence_at, evidence_24h, evidence_source FROM ranked;

GRANT SELECT ON ops.agent_evidence TO service_role;

COMMENT ON VIEW ops.agent_evidence IS
  'Per-slug last-activity derived from tagged writes across ops tables. Additive to ops.agent_runs — agent_health takes GREATEST of both signals.';

-- ============================================================
-- ops.agent_health — recreated to merge runs + evidence
-- ============================================================
-- DROP + CREATE rather than CREATE OR REPLACE because we're inserting
-- new columns (latest_evidence_at, evidence_24h, evidence_source,
-- latest_activity_at) between existing ones — Postgres rejects column
-- renames via REPLACE.

DROP VIEW IF EXISTS ops.agent_health;

CREATE VIEW ops.agent_health AS
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
  e.latest_evidence_at,
  e.evidence_24h,
  e.evidence_source,
  -- Combined "last activity" — prefer evidence if it's newer, since
  -- routines self-instrument rarely.
  GREATEST(l.latest_started_at, e.latest_evidence_at) AS latest_activity_at,
  CASE
    WHEN a.status <> 'active' THEN 'inactive'
    WHEN l.latest_started_at IS NULL AND e.latest_evidence_at IS NULL THEN 'never_run'
    -- A failed run is still "broken" — but only if there's no newer evidence
    -- that the agent is actually doing work despite the recorded failure.
    WHEN l.latest_outcome = 'failure'
         AND (e.latest_evidence_at IS NULL OR e.latest_evidence_at <= l.latest_started_at)
         THEN 'broken'
    WHEN l.latest_outcome = 'running'
         AND l.latest_started_at < now() - INTERVAL '30 minutes'
         AND (e.latest_evidence_at IS NULL OR e.latest_evidence_at <= l.latest_started_at)
         THEN 'broken'
    WHEN a.expected_max_gap_minutes IS NOT NULL
         AND GREATEST(l.latest_started_at, e.latest_evidence_at)
             < now() - (a.expected_max_gap_minutes || ' minutes')::INTERVAL
         THEN 'stale'
    ELSE 'ok'
  END AS computed_status
FROM ops.agents a
LEFT JOIN latest l ON l.agent_id = a.id
LEFT JOIN ops.agent_evidence e ON e.slug = a.slug;

GRANT SELECT ON ops.agent_health TO service_role;

COMMENT ON VIEW ops.agent_health IS
  'Per-agent computed health. Merges instrumented runs (ops.agent_runs) with derived evidence (ops.agent_evidence) — whichever signal is newer wins.';
