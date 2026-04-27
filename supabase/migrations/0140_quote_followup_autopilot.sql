-- 0140_quote_followup_autopilot.sql
--
-- Quote follow-up autopilot. When a quote (or project-based estimate) is
-- sent, the customer is enrolled in a system AR sequence that follows up
-- 24h later via SMS and 48h later via email if no response.
--
-- Three-layer override:
--   tenant level   → tenant_prefs(namespace='automation').data.quote_followup_enabled
--                    default true for new tenants; existing tenants get a
--                    one-row seed of false (don't auto-spam the backlog)
--   per-send level → projects.auto_followup_enabled / quotes.auto_followup_enabled
--                    nullable boolean — null = follow tenant default
--   customer level → customers.do_not_auto_message (migration 0139, hard stop)
--
-- The system sequence itself is created in code (src/lib/ar/system-sequences.ts)
-- on first quote-send for each tenant — no DDL needed for the sequence rows.

ALTER TABLE projects
  ADD COLUMN auto_followup_enabled boolean;

COMMENT ON COLUMN projects.auto_followup_enabled IS
  'null = follow tenant_prefs.automation.quote_followup_enabled. Set explicitly per-quote at send time.';

ALTER TABLE quotes
  ADD COLUMN auto_followup_enabled boolean;

COMMENT ON COLUMN quotes.auto_followup_enabled IS
  'null = follow tenant_prefs.automation.quote_followup_enabled. Set explicitly per-quote at send time.';

-- Seed tenant_prefs for every existing tenant with quote_followup_enabled=false
-- so we don't auto-enroll their backlog. New tenants default to true (resolved
-- in the app — when no row exists, the helper returns true).
INSERT INTO tenant_prefs (tenant_id, namespace, data)
SELECT id, 'automation', jsonb_build_object('quote_followup_enabled', false)
FROM tenants
ON CONFLICT (tenant_id, namespace) DO UPDATE
  SET data = tenant_prefs.data || jsonb_build_object('quote_followup_enabled', false);
