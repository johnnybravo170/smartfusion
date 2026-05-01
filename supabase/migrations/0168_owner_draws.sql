-- 0168_owner_draws.sql
-- Owner draws ledger — running tally of money the owner pays themselves
-- (salary, dividend, reimbursement, other). Feeds the "Owner Pay YTD" card
-- on /business-health and lets the owner see where they actually stand
-- without bolting on payroll/tax categorization.
--
-- Not tied to projects, jobs, or invoices — owner pay isn't job-scoped.
-- Tenant-isolated by RLS. Any tenant member can read/write (small teams,
-- collaborative bookkeeping); fine-grained owner-only gating, if ever
-- needed, lives at the action layer, not in DB policy.
--
-- See PATTERNS.md §11 — this table is registered in
-- tests/integration/cross-tenant-rls.test.ts.

-- ============================================================
-- 1. Table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.owner_draws (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,

  paid_at      DATE NOT NULL,
  amount_cents BIGINT NOT NULL,
  draw_type    TEXT NOT NULL,
  note         TEXT,

  created_by   UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT owner_draws_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT owner_draws_type_valid CHECK (
    draw_type IN ('salary', 'dividend', 'reimbursement', 'other')
  )
);

-- Tenant-scoped list, newest paid first. Powers the draws panel + YTD sum.
CREATE INDEX IF NOT EXISTS idx_owner_draws_tenant_paid
  ON public.owner_draws (tenant_id, paid_at DESC);

-- Type breakdown for the "Owner Pay YTD" card (salary vs dividend split).
CREATE INDEX IF NOT EXISTS idx_owner_draws_tenant_type_paid
  ON public.owner_draws (tenant_id, draw_type, paid_at DESC);

-- ============================================================
-- 2. RLS — tenant members have full CRUD on their tenant's rows.
-- ============================================================
ALTER TABLE public.owner_draws ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_owner_draws ON public.owner_draws
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_owner_draws ON public.owner_draws
  FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_owner_draws ON public.owner_draws
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_owner_draws ON public.owner_draws
  FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

COMMENT ON TABLE public.owner_draws IS
  'Owner pay ledger — salary/dividend/reimbursement/other payments the owner takes from the business. Feeds /business-health Owner Pay YTD card. Not a payroll engine; no tax categorization.';
