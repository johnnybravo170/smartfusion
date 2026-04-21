-- ============================================================
-- 0073_estimate_feedback.sql
--
-- Customer can send feedback on a pending estimate without rejecting it:
-- general comments or per-line. Operator sees unseen feedback on the
-- dashboard; when (seen_at IS NULL) it contributes to the estimate tab
-- badge. Tenant members pick per-event notification channels
-- (email/sms).
-- ============================================================

-- 1. Comments table
CREATE TABLE IF NOT EXISTS public.project_estimate_comments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  cost_line_id  UUID REFERENCES public.project_cost_lines(id) ON DELETE SET NULL,
  body          TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  seen_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pec_project ON public.project_estimate_comments(project_id);
CREATE INDEX idx_pec_tenant  ON public.project_estimate_comments(tenant_id);
CREATE INDEX idx_pec_unseen  ON public.project_estimate_comments(tenant_id) WHERE seen_at IS NULL;

ALTER TABLE public.project_estimate_comments ENABLE ROW LEVEL SECURITY;

-- Tenant can see + manage their own comments. Inserts for customers go
-- through a server action that uses the service-role client.
CREATE POLICY pec_tenant_select ON public.project_estimate_comments
  FOR SELECT USING (tenant_id = public.current_tenant_id());

CREATE POLICY pec_tenant_update ON public.project_estimate_comments
  FOR UPDATE USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY pec_tenant_delete ON public.project_estimate_comments
  FOR DELETE USING (tenant_id = public.current_tenant_id());

-- 2. Per-member notification prefs
ALTER TABLE public.tenant_members
  ADD COLUMN IF NOT EXISTS notification_phone TEXT,
  ADD COLUMN IF NOT EXISTS notify_prefs JSONB NOT NULL DEFAULT '{"customer_feedback":{"email":true,"sms":false}}'::jsonb;
