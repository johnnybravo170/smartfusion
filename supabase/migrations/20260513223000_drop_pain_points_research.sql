-- ============================================================
-- Drop pain-points-research agent + archive its unposted drafts
-- ============================================================
-- The routine produced 126 social drafts (LinkedIn/Twitter/blog) over
-- 6 weeks. Zero have been posted. No feedback loop = no signal back to
-- the agent = themes don't sharpen over time. Stop the bleed; archive
-- the backlog rather than delete so we can inspect/restore later if
-- social becomes a priority again.
--
-- The Claude Code routine has been deleted on the operator side. The
-- ops.social_drafts table and `social_drafts_create` MCP tool stay in
-- place for potential future use.

-- Mark unposted drafts as rejected (closest valid status — the check
-- constraint only allows draft/approved/posted/rejected).
UPDATE ops.social_drafts
SET status = 'rejected', updated_at = now()
WHERE status = 'draft' AND source_pain_points IS NOT NULL;

DELETE FROM ops.agent_runs
  WHERE agent_id IN (SELECT id FROM ops.agents WHERE slug = 'pain-points-research');

DELETE FROM ops.agents WHERE slug = 'pain-points-research';
