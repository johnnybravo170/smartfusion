-- 0170_bank_recon_tables.sql
-- Bank reconciliation foundation: one row per uploaded statement, one row
-- per transaction within it. Powers the BR (bank-recon) epic — multi-layer
-- CSV parser (BR-2), upload UI (BR-4), auto-match engine (BR-5), review
-- queue (BR-7).
--
-- Idempotent re-imports: per-transaction `dedup_hash` is unique within a
-- tenant, so re-uploading the same file silently skips already-imported
-- rows. Hash is computed by the importer as
-- sha256(tenant_id|posted_at|amount_cents|normalized_description).
--
-- See PATTERNS.md §11 — both tables registered in
-- tests/integration/cross-tenant-rls.test.ts.

-- ============================================================
-- 1. bank_statements — one row per uploaded statement
-- ============================================================
CREATE TABLE IF NOT EXISTS public.bank_statements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,

  source_label  TEXT NOT NULL,                    -- 'RBC Chequing' / 'Amex' / user-named
  bank_preset   TEXT,                             -- 'rbc'|'td'|'bmo'|'scotia'|'cibc'|'amex'|'generic'
  filename      TEXT,
  row_count     INT NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  matched_count INT NOT NULL DEFAULT 0 CHECK (matched_count >= 0),

  uploaded_by   UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT bank_statements_preset_valid CHECK (
    bank_preset IS NULL
    OR bank_preset IN ('rbc', 'td', 'bmo', 'scotia', 'cibc', 'amex', 'generic')
  )
);

CREATE INDEX IF NOT EXISTS idx_bank_statements_tenant_uploaded
  ON public.bank_statements (tenant_id, uploaded_at DESC);

ALTER TABLE public.bank_statements ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_bank_statements ON public.bank_statements
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_bank_statements ON public.bank_statements
  FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_bank_statements ON public.bank_statements
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_bank_statements ON public.bank_statements
  FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

COMMENT ON TABLE public.bank_statements IS
  'One row per uploaded bank/credit-card statement CSV. Parent of bank_transactions.';

-- ============================================================
-- 2. bank_transactions — one row per parsed line
-- ============================================================
CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  statement_id  UUID NOT NULL REFERENCES public.bank_statements (id) ON DELETE CASCADE,

  posted_at     DATE NOT NULL,
  -- Signed: negative = debit / money out, positive = credit / money in.
  -- Stored as BIGINT (cents) for headroom — single-tx amounts can exceed
  -- the INTEGER ceiling for some construction bills.
  amount_cents  BIGINT NOT NULL,
  description   TEXT NOT NULL,
  raw_row       JSONB NOT NULL,                   -- preserved for debugging/replay

  -- sha256 hex digest, computed importer-side, scoped to tenant via the
  -- unique index below. Re-uploads of the same file silently skip dupes.
  dedup_hash    TEXT NOT NULL,

  -- Match state — driven by BR-5 auto-match + BR-7 review queue.
  match_status  TEXT NOT NULL DEFAULT 'unmatched',
  match_confidence TEXT,                          -- 'high' | 'medium' | 'low'

  matched_invoice_id UUID REFERENCES public.invoices (id) ON DELETE SET NULL,
  matched_expense_id UUID REFERENCES public.expenses (id) ON DELETE SET NULL,
  matched_bill_id    UUID REFERENCES public.project_bills (id) ON DELETE SET NULL,

  matched_by    UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  matched_at    TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT bank_transactions_status_valid CHECK (
    match_status IN ('unmatched', 'suggested', 'confirmed', 'rejected', 'manual')
  ),
  CONSTRAINT bank_transactions_confidence_valid CHECK (
    match_confidence IS NULL
    OR match_confidence IN ('high', 'medium', 'low')
  ),
  -- A transaction can match at most ONE of invoice / expense / bill.
  CONSTRAINT bank_transactions_one_match CHECK (
    (CASE WHEN matched_invoice_id IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN matched_expense_id IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN matched_bill_id    IS NOT NULL THEN 1 ELSE 0 END)
    <= 1
  ),
  -- If we set matched_at we must have an actor (audit trail).
  CONSTRAINT bank_transactions_match_actor CHECK (
    (matched_at IS NULL AND matched_by IS NULL)
    OR matched_at IS NOT NULL
  )
);

-- Idempotency: re-uploading the same statement won't insert duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bank_transactions_tenant_dedup
  ON public.bank_transactions (tenant_id, dedup_hash);

-- Review queue queries — "give me everything still needing review for this tenant."
CREATE INDEX IF NOT EXISTS idx_bank_transactions_tenant_status_posted
  ON public.bank_transactions (tenant_id, match_status, posted_at DESC);

-- Per-statement child fetch.
CREATE INDEX IF NOT EXISTS idx_bank_transactions_statement_posted
  ON public.bank_transactions (statement_id, posted_at DESC);

-- Match-target lookups (when an invoice/expense/bill is opened, show the
-- bank transaction reconciling it). Partial keeps these tight.
CREATE INDEX IF NOT EXISTS idx_bank_transactions_invoice
  ON public.bank_transactions (matched_invoice_id)
  WHERE matched_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_transactions_expense
  ON public.bank_transactions (matched_expense_id)
  WHERE matched_expense_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_transactions_bill
  ON public.bank_transactions (matched_bill_id)
  WHERE matched_bill_id IS NOT NULL;

ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_bank_transactions ON public.bank_transactions
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_bank_transactions ON public.bank_transactions
  FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_bank_transactions ON public.bank_transactions
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_bank_transactions ON public.bank_transactions
  FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

COMMENT ON TABLE public.bank_transactions IS
  'Individual parsed lines from a bank statement upload. Match state driven by BR-5/BR-7. Unique (tenant_id, dedup_hash) makes re-uploads idempotent.';
