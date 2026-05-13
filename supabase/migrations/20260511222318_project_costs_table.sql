-- Cost unification — `project_costs` is the canonical table for every dollar
-- going out the door on a project, regardless of entry path.
--
-- Replaces the forked `expenses` (receipt-style, implicit-paid) and
-- `project_bills` (vendor-invoice-style, with payment status) tables. The
-- rollup layer (cost-line-actuals, portal-budget) already merges both, so
-- this migration matches the schema to the existing semantic truth.
--
-- This migration creates the table only. Backfill, dual-write shim, caller
-- migrations, and dropping the old tables happen in subsequent PRs. See
-- ops knowledge "Plan: Cost Unification" for the full multi-PR rollout.
--
-- Notable column choices vs. the source tables:
--
-- * `user_id` is NULLABLE here. `expenses.user_id` is NOT NULL ("who
--   entered the receipt"), but `project_bills` has no user_id at all
--   (bills arrive via inbound email or get manually entered without a
--   recorded entrant). The unified table can't enforce NOT NULL across
--   both sources.
--
-- * `amount_cents` is GROSS (incl. GST). `pre_tax_amount_cents` is the
--   pre-GST basis used for cost-plus markup. Source-table semantics
--   differ (see backfill migration): expenses store gross in
--   amount_cents; project_bills store pre-GST. Backfill normalizes.
--
-- * `payment_status` carries 'paid' | 'unpaid' | 'partial'. Receipts
--   backfill as 'paid' (implicit). Bills map 'pending'+'approved' →
--   'unpaid', 'paid' → 'paid'. Partial-pay is reserved for a follow-up.
--
-- * `source_type` discriminates receipts vs vendor bills. UI uses this
--   for badge labels. Write-path code uses it to decide default
--   payment_status on creation.
--
-- * `amount_cents != 0` check preserves migration 0089's negative-
--   amounts allowance (credits / supplier refunds).
--
-- * Extra columns carried from `expenses` (worker_*, recurring_rule_id,
--   import_batch_id, payment_source_id, card_last4, category_id,
--   job_id, qbo_*) preserve live call-site behavior — these are all in
--   use today and the plan to drop the old tables requires the new
--   table to be a complete replacement.

CREATE TABLE IF NOT EXISTS public.project_costs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id                UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  project_id               UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  user_id                  UUID,  -- who entered/paid; nullable (bills have no entrant)

  -- Source-path discriminator. UI uses this for status badge labels;
  -- backfill / write-paths use it to pick correct default payment_status.
  source_type              TEXT NOT NULL
    CHECK (source_type IN ('receipt', 'vendor_bill')),

  -- Payment lifecycle. 'partial' is reserved — v1 only writes paid/unpaid.
  payment_status           TEXT NOT NULL
    CHECK (payment_status IN ('paid', 'unpaid', 'partial')),
  paid_at                  TIMESTAMPTZ,
  paid_amount_cents        BIGINT,

  -- Active vs voided. Soft-delete-friendly (mirrors expenses void semantics).
  status                   TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'void')),

  -- Display
  vendor                   TEXT,
  vendor_gst_number        TEXT,        -- T4A reporting
  description              TEXT,

  -- Date the cost was incurred. Unified from expenses.expense_date /
  -- project_bills.bill_date. For receipts this is "when I paid"; for
  -- bills it's "when vendor billed me".
  cost_date                DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Money. amount_cents is GROSS. pre_tax_amount_cents is the cost-plus
  -- markup basis (nullable — legacy expenses without OCR breakdown fall
  -- back to amount_cents). gst_cents tracks the tax portion.
  amount_cents             BIGINT NOT NULL CHECK (amount_cents <> 0),
  pre_tax_amount_cents     BIGINT,
  gst_cents                BIGINT NOT NULL DEFAULT 0,

  -- Cost-rollup links
  budget_category_id       UUID REFERENCES public.project_budget_categories(id) ON DELETE SET NULL,
  cost_line_id             UUID REFERENCES public.project_cost_lines(id) ON DELETE SET NULL,

  -- Categorization (overhead path, mostly)
  category_id              UUID REFERENCES public.expense_categories(id) ON DELETE SET NULL,
  job_id                   UUID REFERENCES public.jobs(id) ON DELETE SET NULL,

  -- Attachment. Prefer attachment_storage_path going forward;
  -- receipt_url kept short-term for legacy callers.
  attachment_storage_path  TEXT,
  receipt_url              TEXT,

  -- Worker invoice flow
  worker_profile_id        UUID REFERENCES public.worker_profiles(id) ON DELETE SET NULL,
  worker_invoice_id        UUID REFERENCES public.worker_invoices(id) ON DELETE SET NULL,

  -- Provenance / linking
  inbound_email_id         UUID REFERENCES public.inbound_emails(id) ON DELETE SET NULL,
  import_batch_id          UUID REFERENCES public.import_batches(id) ON DELETE SET NULL,
  recurring_rule_id        UUID REFERENCES public.expense_recurring_rules(id) ON DELETE SET NULL,
  payment_source_id        UUID REFERENCES public.payment_sources(id) ON DELETE SET NULL,
  card_last4               TEXT,

  -- External reference (inbound-email message-id, bank txn id, legacy
  -- project_bills.cost_code — rarely used, preserved for back-compat).
  external_ref             TEXT,

  -- QBO round-trip
  qbo_purchase_id          TEXT,
  qbo_sync_token           TEXT,
  qbo_sync_status          TEXT
    CHECK (qbo_sync_status IS NULL OR qbo_sync_status IN ('synced','pending','failed','disabled')),
  qbo_synced_at            TIMESTAMPTZ,

  deleted_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Vendor bills must have payment_status set explicitly; receipts are
  -- implicitly paid. Keep flexibility — both source types CAN be either
  -- status — but flag obvious mistakes.
  CONSTRAINT project_costs_paid_at_consistency CHECK (
    (payment_status = 'paid' AND paid_at IS NOT NULL)
    OR
    (payment_status <> 'paid')
  )
);

-- Tenant-scoped reads (every query filters by tenant_id via RLS).
CREATE INDEX IF NOT EXISTS idx_project_costs_tenant
  ON public.project_costs (tenant_id);

-- Project rollups (cost-line-actuals, portal-budget).
CREATE INDEX IF NOT EXISTS idx_project_costs_project
  ON public.project_costs (project_id)
  WHERE project_id IS NOT NULL;

-- Cost-line variance queries.
CREATE INDEX IF NOT EXISTS idx_project_costs_cost_line
  ON public.project_costs (cost_line_id)
  WHERE cost_line_id IS NOT NULL;

-- Budget category rollups.
CREATE INDEX IF NOT EXISTS idx_project_costs_budget_category
  ON public.project_costs (budget_category_id)
  WHERE budget_category_id IS NOT NULL;

-- AP-aging-style queries: "show me what's unpaid". Most rows will be
-- 'paid', so a partial index keeps this cheap.
CREATE INDEX IF NOT EXISTS idx_project_costs_unpaid
  ON public.project_costs (tenant_id, payment_status, cost_date)
  WHERE payment_status <> 'paid' AND status = 'active';

-- Worker invoice payout lookup.
CREATE INDEX IF NOT EXISTS idx_project_costs_worker_invoice
  ON public.project_costs (worker_invoice_id)
  WHERE worker_invoice_id IS NOT NULL;

-- Import rollback (mirrors expenses.import_batch_id index).
CREATE INDEX IF NOT EXISTS idx_project_costs_import_batch
  ON public.project_costs (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

-- T4A reporting (vendor + tenant + date range).
CREATE INDEX IF NOT EXISTS idx_project_costs_vendor_gst
  ON public.project_costs (tenant_id, vendor_gst_number, cost_date)
  WHERE vendor_gst_number IS NOT NULL;

-- QBO re-sync idempotency.
CREATE UNIQUE INDEX IF NOT EXISTS project_costs_tenant_qbo_id_uniq
  ON public.project_costs (tenant_id, qbo_purchase_id)
  WHERE qbo_purchase_id IS NOT NULL;

-- updated_at auto-bump on row update (matches expenses / project_bills).
CREATE OR REPLACE FUNCTION public.project_costs_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_project_costs_updated_at
  BEFORE UPDATE ON public.project_costs
  FOR EACH ROW EXECUTE FUNCTION public.project_costs_set_updated_at();

ALTER TABLE public.project_costs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_project_costs ON public.project_costs
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_project_costs ON public.project_costs
  FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_project_costs ON public.project_costs
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_project_costs ON public.project_costs
  FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

COMMENT ON TABLE public.project_costs IS
  'Unified cost rows — every dollar out the door per project. Replaces forked expenses + project_bills tables. Payment status is a column, not a separate table.';
COMMENT ON COLUMN public.project_costs.amount_cents IS
  'Gross amount in cents (incl. GST). pre_tax_amount_cents is the cost-plus markup basis when available.';
COMMENT ON COLUMN public.project_costs.source_type IS
  'receipt = "I paid this, here is the receipt". vendor_bill = "vendor sent me a bill, may or may not be paid yet". Discriminator for UI badges and default payment_status on write.';
COMMENT ON COLUMN public.project_costs.payment_status IS
  'paid | unpaid | partial. v1 only writes paid/unpaid; partial reserved for follow-up.';
COMMENT ON COLUMN public.project_costs.user_id IS
  'Who entered the cost (carries from expenses.user_id). NULL for inbound-email vendor bills where no entrant is recorded.';
COMMENT ON COLUMN public.project_costs.external_ref IS
  'Provenance reference — inbound-email message-id, bank txn id, legacy project_bills.cost_code, etc.';
