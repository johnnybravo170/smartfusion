-- ============================================================
-- Inbound email ingestion for sub quotes and vendor bills.
--
-- Provider: Postmark. Each tenant gets {slug}@quotes.heyhenry.io
-- and forwards quotes/invoices there. Postmark hits our webhook,
-- we persist raw, classify with Gemini, and auto-action at high
-- confidence (create project_cost_lines for sub quotes,
-- project_bills for vendor bills).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.inbound_emails (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  postmark_message_id TEXT UNIQUE,

  -- Raw envelope
  to_address          TEXT NOT NULL,
  from_address        TEXT NOT NULL,
  from_name           TEXT,
  subject             TEXT,
  body_text           TEXT,
  body_html           TEXT,
  attachments         JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_payload         JSONB,

  -- Classification (Gemini)
  classification      TEXT CHECK (classification IN ('sub_quote', 'vendor_bill', 'other', 'unclassified')) DEFAULT 'unclassified',
  confidence          NUMERIC(4,3),
  extracted           JSONB,
  classifier_notes    TEXT,

  -- Project assignment
  project_id          UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  project_match_confidence NUMERIC(4,3),

  -- Action tracking
  status              TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'auto_applied', 'needs_review', 'applied', 'rejected', 'error')) DEFAULT 'pending',
  applied_bill_id     UUID REFERENCES public.project_bills(id) ON DELETE SET NULL,
  applied_cost_line_ids UUID[] DEFAULT '{}',
  error_message       TEXT,

  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inbound_emails_tenant_status ON public.inbound_emails(tenant_id, status);
CREATE INDEX idx_inbound_emails_project ON public.inbound_emails(project_id);
CREATE INDEX idx_inbound_emails_received ON public.inbound_emails(received_at DESC);

-- RLS
ALTER TABLE public.inbound_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_inbound_emails ON public.inbound_emails
  FOR SELECT USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_inbound_emails ON public.inbound_emails
  FOR INSERT WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_inbound_emails ON public.inbound_emails
  FOR UPDATE USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_inbound_emails ON public.inbound_emails
  FOR DELETE USING (tenant_id = public.current_tenant_id());

-- Link back from bills to their source inbound email (audit trail)
ALTER TABLE public.project_bills
  ADD COLUMN IF NOT EXISTS inbound_email_id UUID REFERENCES public.inbound_emails(id) ON DELETE SET NULL;
