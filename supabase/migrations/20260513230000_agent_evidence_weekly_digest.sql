-- Extend ops.agent_evidence with weekly-dispatcher source.
-- The routine writes a 'Weekly digest — YYYY-MM-DD' worklog entry every
-- Monday tagged ['weekly_digest', 'pinned']. Previously untracked, so
-- the dashboard showed weekly-dispatcher as stale despite four Monday
-- runs in a row.

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
  SELECT 'weekly-dispatcher', MAX(created_at),
    COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '8 days')::int,
    'ops.worklog_entries tag=weekly_digest'
  FROM ops.worklog_entries
  WHERE 'weekly_digest' = ANY(tags) AND archived_at IS NULL
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
