-- QuickBooks Online integration — schema scaffold.
--
-- Phase 1 of the QBO Import V1 epic. Lays down everything the OAuth flow,
-- import worker, and (later) export worker need to run against; ships
-- before any QBO code so the columns exist when route handlers land.
--
-- Scope of this migration:
--   1. tenants  — connection state (OAuth tokens, realm id, per-tenant
--                 maps for QBO TaxCodes and PaymentMethods)
--   2. customers / invoices / quotes / expenses — per-row qbo_*_id refs
--      so we can round-trip without lookup-by-name
--   3. import_batches.kind enum — extend for the new entity types this
--      epic introduces (payments, bills, quotes, items, vendors)
--   4. payments — new table. HH historically denormalized paid-invoice
--      info onto the invoice row; QBO supports multiple payments per
--      invoice (partial payments, split tender). Modeling as a child
--      table now avoids a second migration when QBO import lands.
--   5. bills + bill_line_items — new tables. Vendor invoices (AP).
--      Read-only in V1: imported from QBO, surfaced for analysis, but
--      no native bill-entry UI in HH yet. Going-forward bills get
--      entered in QBO and round-trip back via bidirectional sync (V2).
--   6. qbo_import_jobs — long-running backfill state. UI polls this row
--      for progress; one job covers all selected entities and writes
--      multiple import_batches rows (one per entity kind) so rollback
--      stays granular.
--   7. qbo_sync_log — per-attempt audit trail for every push/pull. Drives
--      the failed-sync UI and the actor-based failure-email routing
--      described in QBO_PLAN.md §4.3.
--
-- This is additive only. No columns dropped, no constraints tightened.
-- service_catalog → catalog_items migration ships in a separate file.

-- =====================================================================
-- 1. tenants — QBO connection state
-- =====================================================================

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS qbo_realm_id           TEXT,
  ADD COLUMN IF NOT EXISTS qbo_access_token       TEXT,
  ADD COLUMN IF NOT EXISTS qbo_refresh_token      TEXT,
  ADD COLUMN IF NOT EXISTS qbo_token_expires_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qbo_connected_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qbo_disconnected_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qbo_company_name       TEXT,
  ADD COLUMN IF NOT EXISTS qbo_environment        TEXT
    CHECK (qbo_environment IS NULL OR qbo_environment IN ('sandbox', 'production')),
  ADD COLUMN IF NOT EXISTS qbo_default_item_id    TEXT,
  ADD COLUMN IF NOT EXISTS qbo_payment_method_map JSONB,
  ADD COLUMN IF NOT EXISTS qbo_tax_code_map       JSONB,
  ADD COLUMN IF NOT EXISTS qbo_last_full_sync_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qbo_cdc_cursors        JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.tenants.qbo_realm_id IS
  'QBO company id, populated on OAuth connect. NULL when disconnected.';
COMMENT ON COLUMN public.tenants.qbo_environment IS
  'sandbox | production. Determines which QBO API base URL the client targets.';
COMMENT ON COLUMN public.tenants.qbo_default_item_id IS
  'QBO Item id used for invoice lines that have no catalog_items match. Created on first connect.';
COMMENT ON COLUMN public.tenants.qbo_payment_method_map IS
  'QBO payment-method ids keyed by HH method, e.g. {"cash":"1","cheque":"2","e-transfer":"7"}.';
COMMENT ON COLUMN public.tenants.qbo_tax_code_map IS
  'Per-province QBO TaxCode ids, e.g. {"BC":"4","ON":"8","_tax_exempt":"3"}. See QBO_PLAN.md §12.1.';
COMMENT ON COLUMN public.tenants.qbo_cdc_cursors IS
  'Per-entity ISO timestamps for QBO Change Data Capture polling. Shape: {"Customer":"2026-05-11T...","Invoice":"..."}. Keeps API call count down on re-sync.';

-- Service-role-only read of tokens. The columns themselves live on
-- `tenants` which has RLS already; we add a defensive policy noting that
-- token columns must never round-trip to the client. Application code
-- relies on hand-rolled scoped queries (don't SELECT * tenants from the
-- browser). Marking here as a contract for code review.
COMMENT ON COLUMN public.tenants.qbo_access_token IS
  'OAuth access token. Service-role only — never SELECT this column from a user-facing query.';
COMMENT ON COLUMN public.tenants.qbo_refresh_token IS
  'OAuth refresh token. Service-role only. Move to Supabase Vault before customer #20 (separate fast-follow card).';

-- =====================================================================
-- 2. Per-row qbo_*_id columns
-- =====================================================================

-- customers (covers vendors too — kind='vendor' rows live in the same table)
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS qbo_customer_id  TEXT,
  ADD COLUMN IF NOT EXISTS qbo_sync_token   TEXT,
  ADD COLUMN IF NOT EXISTS qbo_sync_status  TEXT
    CHECK (qbo_sync_status IS NULL OR qbo_sync_status IN ('synced','pending','failed','disabled')),
  ADD COLUMN IF NOT EXISTS qbo_synced_at    TIMESTAMPTZ;

-- Unique per tenant: re-importing the same QBO Customer must hit the
-- same HH row. Partial index because the bulk of customers won't be
-- QBO-linked.
CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_qbo_id_uniq
  ON public.customers (tenant_id, qbo_customer_id)
  WHERE qbo_customer_id IS NOT NULL;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS qbo_invoice_id   TEXT,
  ADD COLUMN IF NOT EXISTS qbo_sync_token   TEXT,
  ADD COLUMN IF NOT EXISTS qbo_sync_status  TEXT
    CHECK (qbo_sync_status IS NULL OR qbo_sync_status IN ('synced','pending','failed','disabled')),
  ADD COLUMN IF NOT EXISTS qbo_synced_at    TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_tenant_qbo_id_uniq
  ON public.invoices (tenant_id, qbo_invoice_id)
  WHERE qbo_invoice_id IS NOT NULL;

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS qbo_estimate_id  TEXT,
  ADD COLUMN IF NOT EXISTS qbo_sync_token   TEXT,
  ADD COLUMN IF NOT EXISTS qbo_sync_status  TEXT
    CHECK (qbo_sync_status IS NULL OR qbo_sync_status IN ('synced','pending','failed','disabled')),
  ADD COLUMN IF NOT EXISTS qbo_synced_at    TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS quotes_tenant_qbo_id_uniq
  ON public.quotes (tenant_id, qbo_estimate_id)
  WHERE qbo_estimate_id IS NOT NULL;

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS qbo_purchase_id  TEXT,
  ADD COLUMN IF NOT EXISTS qbo_sync_token   TEXT,
  ADD COLUMN IF NOT EXISTS qbo_sync_status  TEXT
    CHECK (qbo_sync_status IS NULL OR qbo_sync_status IN ('synced','pending','failed','disabled')),
  ADD COLUMN IF NOT EXISTS qbo_synced_at    TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS expenses_tenant_qbo_id_uniq
  ON public.expenses (tenant_id, qbo_purchase_id)
  WHERE qbo_purchase_id IS NOT NULL;

-- =====================================================================
-- 3. Extend import_batches.kind enum
-- =====================================================================
-- Existing values (from 0209): customers, projects, invoices, expenses, photos, time_entries
-- Add: payments, bills, quotes, items, vendors (vendors live in customers
-- table but get their own batch kind so rollback is granular).
ALTER TABLE public.import_batches
  DROP CONSTRAINT IF EXISTS import_batches_kind_check;

ALTER TABLE public.import_batches
  ADD CONSTRAINT import_batches_kind_check
    CHECK (kind IN (
      'customers', 'projects', 'invoices', 'expenses',
      'photos', 'time_entries',
      'payments', 'bills', 'quotes', 'items', 'vendors'
    ));

-- =====================================================================
-- 4. payments — transaction records linked to invoices
-- =====================================================================
-- One invoice → 0..N payments. Supports QBO's split-tender / partial-
-- payment model. Existing invoice.payment_method / payment_reference
-- columns stay (they record the LAST payment for backward compat) and
-- are denormalized from this table on insert. Future cleanup card will
-- collapse those into a generated view.

CREATE TABLE IF NOT EXISTS public.payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  invoice_id        UUID NOT NULL REFERENCES public.invoices (id) ON DELETE CASCADE,
  customer_id       UUID REFERENCES public.customers (id) ON DELETE SET NULL,

  -- Money math: amount_cents is what was actually paid in this txn.
  -- May be less than invoice total (partial payment). Never recompute
  -- against today's tax rate — payments are historical facts.
  amount_cents      BIGINT NOT NULL CHECK (amount_cents > 0),

  -- Payment method: matches the existing enum on invoices for parity.
  -- Source of truth for QBO PaymentMethodRef mapping (per-tenant map
  -- lives on tenants.qbo_payment_method_map).
  method            TEXT NOT NULL CHECK (method IN (
    'cash','cheque','e-transfer','stripe','credit_card','other'
  )),
  payment_reference TEXT,   -- cheque #, e-transfer code, Stripe charge id, etc.
  payment_notes     TEXT,

  paid_at           TIMESTAMPTZ NOT NULL,
  created_by        UUID REFERENCES auth.users (id) ON DELETE SET NULL,

  -- QBO round-trip
  qbo_payment_id    TEXT,
  qbo_sync_token    TEXT,
  qbo_sync_status   TEXT
    CHECK (qbo_sync_status IS NULL OR qbo_sync_status IN ('synced','pending','failed','disabled')),
  qbo_synced_at     TIMESTAMPTZ,

  -- Import audit
  import_batch_id   UUID REFERENCES public.import_batches (id) ON DELETE SET NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_tenant_recent
  ON public.payments (tenant_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_invoice
  ON public.payments (invoice_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_import_batch
  ON public.payments (import_batch_id)
  WHERE import_batch_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payments_tenant_qbo_id_uniq
  ON public.payments (tenant_id, qbo_payment_id)
  WHERE qbo_payment_id IS NOT NULL;

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_payments ON public.payments
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_payments ON public.payments
  FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_payments ON public.payments
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_payments ON public.payments
  FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

COMMENT ON TABLE public.payments IS
  'Payment transactions against invoices. One invoice → 0..N payments. Historical money math is FROZEN — never recompute against today''s tax rate.';

-- =====================================================================
-- 5. bills + bill_line_items — vendor AP (read-only V1)
-- =====================================================================
-- Bills are vendor invoices we receive (AP). V1: import-only from QBO,
-- surfaced for analysis. No native entry UI yet. Vendor lives in the
-- customers table with kind='vendor'.

CREATE TABLE IF NOT EXISTS public.bills (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  vendor_id         UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  project_id        UUID REFERENCES public.projects (id) ON DELETE SET NULL,

  -- Doc + dates
  doc_number        TEXT,        -- vendor's own invoice number
  txn_date          DATE NOT NULL,
  due_date          DATE,

  -- Money math (frozen at historical values like invoices.import_batch_id)
  subtotal_cents    BIGINT NOT NULL CHECK (subtotal_cents >= 0),
  tax_cents         BIGINT NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents       BIGINT NOT NULL CHECK (total_cents >= 0),
  balance_cents     BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  currency          TEXT NOT NULL DEFAULT 'CAD',

  status            TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','partial','paid','void')),

  memo              TEXT,
  private_note      TEXT,

  -- QBO round-trip
  qbo_bill_id       TEXT,
  qbo_sync_token    TEXT,
  qbo_sync_status   TEXT
    CHECK (qbo_sync_status IS NULL OR qbo_sync_status IN ('synced','pending','failed','disabled')),
  qbo_synced_at     TIMESTAMPTZ,

  -- Import audit
  import_batch_id   UUID REFERENCES public.import_batches (id) ON DELETE SET NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bills_tenant_recent
  ON public.bills (tenant_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_bills_vendor
  ON public.bills (vendor_id, txn_date DESC)
  WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bills_project
  ON public.bills (project_id, txn_date DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bills_import_batch
  ON public.bills (import_batch_id)
  WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bills_open
  ON public.bills (tenant_id, due_date)
  WHERE status IN ('open', 'partial');
CREATE UNIQUE INDEX IF NOT EXISTS bills_tenant_qbo_id_uniq
  ON public.bills (tenant_id, qbo_bill_id)
  WHERE qbo_bill_id IS NOT NULL;

ALTER TABLE public.bills ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_bills ON public.bills
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_bills ON public.bills
  FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_bills ON public.bills
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_bills ON public.bills
  FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

COMMENT ON TABLE public.bills IS
  'Vendor invoices (AP). Read-only in V1 — imported from QBO. New bills are entered in QBO and round-trip back via bidirectional sync (V2 fast-follow). Money math frozen at historical values.';

-- Line items on each bill. Mirrors the QBO BillLine shape closely so
-- we don't lose detail on import.
CREATE TABLE IF NOT EXISTS public.bill_line_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id           UUID NOT NULL REFERENCES public.bills (id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,

  -- Ordering for stable rendering
  position          INT NOT NULL DEFAULT 0,

  description       TEXT,
  amount_cents      BIGINT NOT NULL CHECK (amount_cents >= 0),

  -- Detail type from QBO: AccountBasedExpenseLineDetail | ItemBasedExpenseLineDetail
  detail_type       TEXT
    CHECK (detail_type IS NULL OR detail_type IN ('account','item')),

  -- For account-based lines: which expense account
  qbo_account_id    TEXT,
  qbo_account_name  TEXT,
  -- For item-based lines: which item (matches catalog_items.qbo_item_id)
  qbo_item_id       TEXT,

  -- Tax (per-line in QBO)
  qbo_tax_code_id   TEXT,
  tax_cents         BIGINT NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),

  -- QBO's line id (NOT the bill id)
  qbo_line_id       TEXT,

  -- For job-costing — QBO Class / Customer ref on the line
  qbo_class_id      TEXT,
  qbo_customer_ref  TEXT,
  project_id        UUID REFERENCES public.projects (id) ON DELETE SET NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bill_line_items_bill
  ON public.bill_line_items (bill_id, position);

ALTER TABLE public.bill_line_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_bill_line_items ON public.bill_line_items
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_bill_line_items ON public.bill_line_items
  FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_bill_line_items ON public.bill_line_items
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_bill_line_items ON public.bill_line_items
  FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

-- =====================================================================
-- 6. qbo_import_jobs — long-running backfill job state
-- =====================================================================
-- One row per QBO import the user kicks off. UI polls this for progress.
-- A job spawns multiple import_batches rows (one per entity kind) so
-- rollback can target a subset (e.g. "redo just the customers"). The
-- batch_ids JSONB maps entity kind → batch id.

CREATE TABLE IF NOT EXISTS public.qbo_import_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,

  status              TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','failed','cancelled')),

  -- Configuration captured at start
  requested_entities  TEXT[] NOT NULL DEFAULT '{}',
  date_range_from     DATE,
  date_range_to       DATE,

  -- Progress, per entity. Shape:
  --   { "Customer":   {"fetched":120,"imported":118,"skipped":2,"failed":0},
  --     "Invoice":    {"fetched":540,"imported":540,"skipped":0,"failed":0},
  --     "Payment":    {...}, ... }
  entity_counters     JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- QBO API call budgeting. Visible in the UI so user can watch the
  -- meter and Mike can decide whether to limit date range to stay under
  -- the 500k/mo billing threshold.
  api_calls_used      INT NOT NULL DEFAULT 0,

  -- import_batches rows spawned by this job, keyed by entity kind.
  -- Shape: { "customers": "<uuid>", "invoices": "<uuid>", ... }
  batch_ids           JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Customer dedup review queue items. Each entry is an ambiguous match
  -- waiting for user resolution. Shape:
  --   [{ "qbo_id":"123", "qbo_name":"...", "candidates":[{"hh_id":"...","name":"...","score":0.82},...] }, ...]
  -- Resolved entries get moved to entity_counters.Customer counters.
  review_queue        JSONB NOT NULL DEFAULT '[]'::jsonb,

  error_message       TEXT,
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  created_by          UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qbo_import_jobs_tenant_recent
  ON public.qbo_import_jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qbo_import_jobs_running
  ON public.qbo_import_jobs (tenant_id, status)
  WHERE status IN ('queued','running');

ALTER TABLE public.qbo_import_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_qbo_import_jobs ON public.qbo_import_jobs
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_qbo_import_jobs ON public.qbo_import_jobs
  FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_qbo_import_jobs ON public.qbo_import_jobs
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
-- No delete policy: jobs are audit history, kept indefinitely.

COMMENT ON TABLE public.qbo_import_jobs IS
  'Long-running QBO backfill jobs. UI polls for progress. One job spawns multiple import_batches rows (keyed in batch_ids JSONB) so rollback stays granular per entity kind.';

-- =====================================================================
-- 7. qbo_sync_log — per-attempt audit trail
-- =====================================================================
-- Shape from QBO_PLAN.md §5. Every push (export) and every pull (import)
-- writes one row. Failures here drive the failed-sync UI; actor_email
-- routes the failure email per QBO_PLAN.md §4.3.

CREATE TABLE IF NOT EXISTS public.qbo_sync_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,

  -- 'pull' (QBO → HH, import) or 'push' (HH → QBO, export, V2+)
  direction       TEXT NOT NULL CHECK (direction IN ('pull','push')),

  entity_type     TEXT NOT NULL CHECK (entity_type IN (
    'customer','vendor','invoice','quote','estimate',
    'payment','bill','item','expense','void'
  )),
  entity_id       UUID,           -- HH row id (NULL during import before insert)
  qbo_id          TEXT,           -- QBO Id

  status          TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),

  -- Who triggered this sync. Drives failure-email routing.
  actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('gc','bookkeeper','system')),
  actor_user_id   UUID,
  actor_email     TEXT,

  -- Link to the parent import job (if any)
  import_job_id   UUID REFERENCES public.qbo_import_jobs (id) ON DELETE SET NULL,

  request_body    JSONB,
  response_body   JSONB,
  error_message   TEXT,
  attempt         INT NOT NULL DEFAULT 1,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS qbo_sync_log_tenant_idx
  ON public.qbo_sync_log (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS qbo_sync_log_entity_idx
  ON public.qbo_sync_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS qbo_sync_log_failed_idx
  ON public.qbo_sync_log (tenant_id, status)
  WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS qbo_sync_log_import_job_idx
  ON public.qbo_sync_log (import_job_id)
  WHERE import_job_id IS NOT NULL;

ALTER TABLE public.qbo_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_qbo_sync_log ON public.qbo_sync_log
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
-- Writes only via service role (sync worker). No client INSERT/UPDATE/DELETE.

COMMENT ON TABLE public.qbo_sync_log IS
  'Per-attempt audit trail for every QBO sync (pull/import + push/export). Failure rows drive UI; actor_email routes failure notifications per QBO_PLAN.md §4.3. Service-role writes only.';
