-- ============================================================
-- agent_evidence: add ops.worklog_entries as an evidence source
-- ============================================================
-- Some routines (pain-points-research, competitive-research) end each
-- run with a worklog entry rather than (or in addition to) writing
-- domain-specific tables. Without this source, those routines look
-- silent in the dashboard even though they're firing daily.

CREATE OR REPLACE VIEW ops.agent_evidence AS
WITH per_source AS (
  SELECT 'business-scout'::text AS slug, MAX(created_at) AS last_evidence_at,
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int AS evidence_24h,
    'ops.ideas tag=biz-scout'::text AS evidence_source
  FROM ops.ideas WHERE 'biz-scout' = ANY(tags)
  UNION ALL
  SELECT 'ai-tools-scout', MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.ideas tag=ai-tools|ai-scout'
  FROM ops.ideas WHERE 'ai-tools' = ANY(tags) OR 'ai-scout' = ANY(tags)
  UNION ALL
  SELECT 'ai-tools-scout', MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.knowledge_docs tag=heyhenry-ai-tools'
  FROM ops.knowledge_docs WHERE 'heyhenry-ai-tools' = ANY(tags)
  UNION ALL
  SELECT 'marketing-strategist', MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.ideas tag=marketing-scout'
  FROM ops.ideas WHERE 'marketing-scout' = ANY(tags)
  UNION ALL
  SELECT 'competitive-research', MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.knowledge_docs tag=competitor|competitive|competitive-intel|competitor-deep-profile'
  FROM ops.knowledge_docs WHERE tags && ARRAY['competitor','competitive','competitive-intel','competitor-deep-profile']::text[]
  UNION ALL
  SELECT 'competitive-research', MAX(updated_at),
    COUNT(*) FILTER (WHERE updated_at > now() - INTERVAL '24 hours')::int,
    'ops.competitors.updated_at'
  FROM ops.competitors
  UNION ALL
  SELECT 'competitive-research', MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.worklog_entries tag=competitive-research'
  FROM ops.worklog_entries
  WHERE 'competitive-research' = ANY(tags) AND archived_at IS NULL
  UNION ALL
  -- pain-points-research — historical tag is 'pain-point-research' (singular)
  -- in worklog_entries; ops.ideas uses 'pain-points'. Match both.
  SELECT 'pain-points-research', MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.ideas tag=pain-points'
  FROM ops.ideas WHERE 'pain-points' = ANY(tags)
  UNION ALL
  SELECT 'pain-points-research', MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.worklog_entries tag=pain-point-research|pain-points-research'
  FROM ops.worklog_entries
  WHERE (tags && ARRAY['pain-point-research','pain-points-research']::text[])
    AND archived_at IS NULL
  UNION ALL
  SELECT 'helpdesk-triage', MAX(updated_at),
    COUNT(*) FILTER (WHERE updated_at > now() - INTERVAL '24 hours')::int,
    'ops.incidents assigned_agent=helpdesk-triage'
  FROM ops.incidents WHERE assigned_agent = 'helpdesk-triage'
  UNION ALL
  SELECT 'doc-writer', MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.knowledge_docs tag=auto:doc-writer'
  FROM ops.knowledge_docs WHERE 'auto:doc-writer' = ANY(tags)
  UNION ALL
  SELECT 'doc-writer', MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '24 hours')::int,
    'ops.docs'
  FROM ops.docs
  UNION ALL
  SELECT 'ideas-digest', MAX(email_sent_at),
    COUNT(*) FILTER (WHERE email_sent_at > now() - INTERVAL '24 hours')::int,
    'ops.ideas.email_sent_at'
  FROM ops.ideas WHERE email_sent_at IS NOT NULL
  UNION ALL
  SELECT 'ideas-review', MAX(last_review_attempt_at),
    COUNT(*) FILTER (WHERE last_review_attempt_at > now() - INTERVAL '24 hours')::int,
    'ops.ideas.last_review_attempt_at'
  FROM ops.ideas WHERE last_review_attempt_at IS NOT NULL
  UNION ALL
  SELECT 'git-stats', MAX(last_refreshed),
    COUNT(*) FILTER (WHERE last_refreshed > now() - INTERVAL '24 hours')::int,
    'ops.git_daily_stats.last_refreshed'
  FROM ops.git_daily_stats
  UNION ALL
  SELECT 'maintenance-weekly', MAX(started_at),
    COUNT(*) FILTER (WHERE started_at > now() - INTERVAL '7 days')::int,
    'ops.maintenance_runs kind=weekly'
  FROM ops.maintenance_runs WHERE kind = 'weekly'
),
ranked AS (
  SELECT slug, MAX(last_evidence_at) AS latest_evidence_at,
    SUM(evidence_24h)::int AS evidence_24h,
    (ARRAY_AGG(evidence_source ORDER BY last_evidence_at DESC NULLS LAST))[1] AS evidence_source
  FROM per_source WHERE last_evidence_at IS NOT NULL
  GROUP BY slug
)
SELECT slug, latest_evidence_at, evidence_24h, evidence_source FROM ranked;

GRANT SELECT ON ops.agent_evidence TO service_role;

-- ============================================================
-- Drop the security-probe agent registry row
-- ============================================================
-- Routine was firing daily but always reported "egress blocked" — Claude
-- Code Routines' sandbox doesn't allow arbitrary HTTP egress, only
-- registered MCP connectors. Probe-style health monitoring is better
-- served by Vercel monitors + Sentry; this slug never produced a finding
-- in 20+ runs. Delete corresponding Claude Code Routine separately.

DELETE FROM ops.agent_runs
  WHERE agent_id IN (SELECT id FROM ops.agents WHERE slug = 'security-probe');

DELETE FROM ops.agents WHERE slug = 'security-probe';
