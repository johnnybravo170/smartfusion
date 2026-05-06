-- 0195_project_messages.sql
-- Phase 1 of PROJECT_MESSAGING_PLAN.md.
--
-- Single project-scoped conversation thread that all communication
-- channels feed into. Phase 1 covers the 'portal' channel only (operator
-- and customer typing into the portal UI). Phase 2 layers in 'email'
-- inbound/outbound; Phase 3 adds 'sms'.
--
-- Operator → customer notifications use the deferred-notify pattern from
-- project_phases (PORTAL_PHASES_PLAN.md): on a new outbound message,
-- cancel any prior pending outbound notify for this project, schedule a
-- new one ~30s out. Cron drainer (/api/cron/project-message-notify)
-- sends and stamps notify_sent_at. Customer → operator notifications
-- fire immediately (no defer column populated for inbound rows).

CREATE TABLE IF NOT EXISTS public.project_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  project_id      UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,

  -- Authorship
  sender_kind     TEXT NOT NULL CHECK (sender_kind IN ('operator', 'customer', 'system', 'henry')),
  sender_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  sender_label    TEXT,

  -- Channel + direction (inbound/outbound is from the operator's POV)
  channel         TEXT NOT NULL CHECK (channel IN ('portal', 'email', 'sms')),
  direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),

  -- Body
  subject         TEXT,
  body            TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  attachments     JSONB,

  -- Threading + provenance (Phase 2 will populate external_id and
  -- inbound_email_id; declared now to avoid a follow-up migration)
  in_reply_to     UUID REFERENCES public.project_messages(id) ON DELETE SET NULL,
  external_id     TEXT,

  -- Read tracking (per side)
  read_by_operator_at TIMESTAMPTZ,
  read_by_customer_at TIMESTAMPTZ,

  -- Deferred-notify state — populated only on outbound messages where
  -- a customer notification is pending. Same shape as project_phases.
  notify_scheduled_at TIMESTAMPTZ,
  notify_sent_at      TIMESTAMPTZ,
  notify_cancelled_at TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot query: thread render for a project (newest last when reversed in app)
CREATE INDEX IF NOT EXISTS idx_pm_project_created
  ON public.project_messages (project_id, created_at);

-- Operator-side unread count (banner + tab badge)
CREATE INDEX IF NOT EXISTS idx_pm_tenant_unread_inbound
  ON public.project_messages (tenant_id, project_id)
  WHERE read_by_operator_at IS NULL AND direction = 'inbound';

-- Cron drainer's hot query: due, not sent, not cancelled
CREATE INDEX IF NOT EXISTS idx_pm_notify_pending
  ON public.project_messages (notify_scheduled_at)
  WHERE notify_sent_at IS NULL
    AND notify_cancelled_at IS NULL
    AND notify_scheduled_at IS NOT NULL;

-- External id lookups (Phase 2 inbound dedupe)
CREATE INDEX IF NOT EXISTS idx_pm_external_id
  ON public.project_messages (external_id)
  WHERE external_id IS NOT NULL;

ALTER TABLE public.project_messages ENABLE ROW LEVEL SECURITY;

-- Tenant select / update / delete via the standard current_tenant_id() guard.
-- Inserts go through server actions using the admin client (customer
-- side via portal_slug auth; operator side via authenticated session
-- which still passes RLS, so allow tenant-scoped inserts too).
CREATE POLICY pm_tenant_select ON public.project_messages
  FOR SELECT USING (tenant_id = public.current_tenant_id());

CREATE POLICY pm_tenant_insert ON public.project_messages
  FOR INSERT WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY pm_tenant_update ON public.project_messages
  FOR UPDATE USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY pm_tenant_delete ON public.project_messages
  FOR DELETE USING (tenant_id = public.current_tenant_id());

-- Forward-compat for Phase 2: per-project routing slug for inbound
-- email/SMS (proj-{slug}@inbox.heyhenry.io). Generated lazily on first
-- outbound that wants replies. Unused in Phase 1; declared now to avoid
-- a follow-up migration.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS messaging_slug TEXT UNIQUE;

COMMENT ON TABLE public.project_messages IS
  'Unified project-scoped conversation log. Phase 1: portal channel only. Phase 2 adds email; Phase 3 adds SMS.';
COMMENT ON COLUMN public.project_messages.notify_scheduled_at IS
  'For outbound messages: when the cron drainer should send the customer notification. Replaced (cancelled-and-rescheduled) when operator posts again within the deferral window.';
COMMENT ON COLUMN public.projects.messaging_slug IS
  'Per-project routing slug for proj-{slug}@inbox.heyhenry.io (Phase 2). NULL until first outbound message that wants replies is sent.';
