-- GST/HST remittance log.
--
-- When a contractor (or bookkeeper) files + pays a quarterly return,
-- they record it here. The GST report then shows "Filed YYYY-MM-DD"
-- instead of "Net owed to CRA" for that period.
--
-- Period is identified by (from, to) date range. We enforce a uniqueness
-- constraint so you can't accidentally double-file the same quarter.
-- To refile (rare — usually means the original was wrong), delete the
-- existing row and record a new one.
--
-- Kept simple for MVP: no per-jurisdiction split (single net owed to
-- CRA, no QST separate yet), no filing attachment upload (accountant
-- keeps those). Amount stored as cents to match the rest of the app.

BEGIN;

CREATE TABLE public.gst_remittances (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  period_from   DATE NOT NULL,
  period_to     DATE NOT NULL,
  amount_cents  BIGINT NOT NULL,
  paid_at       DATE NOT NULL,
  reference     TEXT,
  notes         TEXT,
  created_by    UUID REFERENCES public.tenant_members(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from),
  UNIQUE (tenant_id, period_from, period_to)
);

CREATE INDEX idx_gst_remittances_tenant
  ON public.gst_remittances(tenant_id, period_from DESC);

ALTER TABLE public.gst_remittances ENABLE ROW LEVEL SECURITY;

-- Owners/admins/bookkeepers can read + write. Workers get no visibility.
-- Relying on current_tenant_id() matches the rest of the app; the UI
-- enforces role restriction (GST pages live on owner + /bk surfaces).
CREATE POLICY gst_remittances_tenant_select ON public.gst_remittances
  FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id());

CREATE POLICY gst_remittances_tenant_insert ON public.gst_remittances
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY gst_remittances_tenant_update ON public.gst_remittances
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY gst_remittances_tenant_delete ON public.gst_remittances
  FOR DELETE TO authenticated
  USING (tenant_id = public.current_tenant_id());

COMMIT;
