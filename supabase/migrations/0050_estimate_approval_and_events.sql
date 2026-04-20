-- Estimate approval flow + public page view tracking + project event timeline.

-- 1. Estimate approval state on projects.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS estimate_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (estimate_status IN ('draft', 'pending_approval', 'approved', 'declined')),
  ADD COLUMN IF NOT EXISTS estimate_approval_code TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS estimate_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS estimate_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS estimate_approved_by_name TEXT,
  ADD COLUMN IF NOT EXISTS estimate_declined_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS estimate_declined_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_projects_estimate_approval_code
  ON public.projects (estimate_approval_code)
  WHERE estimate_approval_code IS NOT NULL;

-- 2. Generic view tracking for customer-facing pages (estimates, portals, invoices, change orders, quotes).
CREATE TABLE IF NOT EXISTS public.public_page_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL
    CHECK (resource_type IN ('estimate', 'portal', 'invoice', 'change_order', 'quote')),
  resource_id UUID NOT NULL,
  session_id TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_public_page_views_resource
  ON public.public_page_views (resource_type, resource_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_page_views_tenant
  ON public.public_page_views (tenant_id, viewed_at DESC);

-- 3. Project event timeline (estimate sent, viewed, approved, invoiced, etc.).
CREATE TABLE IF NOT EXISTS public.project_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_events_project
  ON public.project_events (project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_events_tenant
  ON public.project_events (tenant_id, occurred_at DESC);
