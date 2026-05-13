-- Cost unification — backfill `project_costs` from the two legacy tables.
--
-- Companion to 20260511222318_project_costs_table.sql. Run order matters:
-- the table must exist before this populates it.
--
-- Mapping (full detail in ops knowledge "Plan: Cost Unification"):
--
--   expenses (gross-stored)
--     amount_cents          → amount_cents
--     pre_tax_amount_cents  → pre_tax_amount_cents
--     tax_cents             → gst_cents
--     expense_date          → cost_date
--     receipt_storage_path  → attachment_storage_path
--     receipt_url           → receipt_url
--     (implicit "paid")     → payment_status='paid', paid_at=created_at
--     source_type='receipt'
--
--   project_bills (pre-GST-stored)
--     amount_cents + gst_cents → amount_cents  (compute gross)
--     amount_cents              → pre_tax_amount_cents
--     gst_cents                 → gst_cents
--     bill_date                 → cost_date
--     attachment_storage_path   → attachment_storage_path
--     receipt_url               → receipt_url
--     status='pending'/'approved' → payment_status='unpaid'
--     status='paid'             → payment_status='paid', paid_at=updated_at
--     cost_code                 → external_ref
--     inbound_email_id          → inbound_email_id
--     source_type='vendor_bill'
--
-- IDs are preserved from both source tables so any in-flight reference
-- via the dual-write shim (next PR) can still resolve. UUID collision
-- between the two source spaces is astronomically unlikely; if it does
-- happen, this migration fails loudly rather than silently dropping data
-- — which is the right behavior.
--
-- Sanity assertions at the bottom verify row counts + sum totals match
-- across the boundary. Migration aborts if they don't.

-- --- Receipts (expenses) → project_costs ---------------------------------
INSERT INTO public.project_costs (
  id,
  tenant_id,
  project_id,
  user_id,
  source_type,
  payment_status,
  paid_at,
  status,
  vendor,
  vendor_gst_number,
  description,
  cost_date,
  amount_cents,
  pre_tax_amount_cents,
  gst_cents,
  budget_category_id,
  cost_line_id,
  category_id,
  job_id,
  attachment_storage_path,
  receipt_url,
  worker_profile_id,
  worker_invoice_id,
  import_batch_id,
  recurring_rule_id,
  payment_source_id,
  card_last4,
  qbo_purchase_id,
  qbo_sync_token,
  qbo_sync_status,
  qbo_synced_at,
  created_at,
  updated_at
)
SELECT
  e.id,
  e.tenant_id,
  e.project_id,
  e.user_id,
  'receipt'                       AS source_type,
  'paid'                          AS payment_status,
  e.created_at                    AS paid_at,            -- best legacy signal
  'active'                        AS status,
  e.vendor,
  e.vendor_gst_number,
  e.description,
  e.expense_date                  AS cost_date,
  e.amount_cents,                                        -- gross, direct carry
  e.pre_tax_amount_cents,
  e.tax_cents                     AS gst_cents,
  e.budget_category_id,
  e.cost_line_id,
  e.category_id,
  e.job_id,
  e.receipt_storage_path          AS attachment_storage_path,
  e.receipt_url,
  e.worker_profile_id,
  e.worker_invoice_id,
  e.import_batch_id,
  e.recurring_rule_id,
  e.payment_source_id,
  e.card_last4,
  e.qbo_purchase_id,
  e.qbo_sync_token,
  e.qbo_sync_status,
  e.qbo_synced_at,
  e.created_at,
  e.updated_at
FROM public.expenses e;

-- --- Vendor bills (project_bills) → project_costs ------------------------
INSERT INTO public.project_costs (
  id,
  tenant_id,
  project_id,
  source_type,
  payment_status,
  paid_at,
  status,
  vendor,
  vendor_gst_number,
  description,
  cost_date,
  amount_cents,
  pre_tax_amount_cents,
  gst_cents,
  budget_category_id,
  cost_line_id,
  attachment_storage_path,
  receipt_url,
  inbound_email_id,
  external_ref,
  created_at,
  updated_at
)
SELECT
  b.id,
  b.tenant_id,
  b.project_id,
  'vendor_bill'                   AS source_type,
  CASE b.status
    WHEN 'paid' THEN 'paid'
    ELSE 'unpaid'
  END                             AS payment_status,
  CASE
    WHEN b.status = 'paid' THEN b.updated_at
    ELSE NULL
  END                             AS paid_at,
  'active'                        AS status,
  b.vendor,
  b.vendor_gst_number,
  b.description,
  b.bill_date                     AS cost_date,
  (b.amount_cents + b.gst_cents)::BIGINT AS amount_cents,   -- pre-GST + GST → gross
  b.amount_cents                  AS pre_tax_amount_cents,  -- source IS pre-GST
  b.gst_cents,
  b.budget_category_id,
  b.cost_line_id,
  b.attachment_storage_path,
  b.receipt_url,
  b.inbound_email_id,
  b.cost_code                     AS external_ref,
  b.created_at,
  b.updated_at
FROM public.project_bills b;

-- --- Sanity assertions ----------------------------------------------------
DO $$
DECLARE
  source_receipts   BIGINT;
  source_bills      BIGINT;
  source_count      BIGINT;
  dest_count        BIGINT;
  source_amount_sum BIGINT;
  dest_amount_sum   BIGINT;
BEGIN
  SELECT COUNT(*) INTO source_receipts FROM public.expenses;
  SELECT COUNT(*) INTO source_bills    FROM public.project_bills;
  source_count := source_receipts + source_bills;
  SELECT COUNT(*) INTO dest_count FROM public.project_costs;

  IF dest_count <> source_count THEN
    RAISE EXCEPTION
      'project_costs backfill row count mismatch: expenses=% + project_bills=% (=%) but project_costs=%',
      source_receipts, source_bills, source_count, dest_count;
  END IF;

  -- Total dollars out must be conserved. Bills get grossed up
  -- (amount_cents + gst_cents) during backfill, so the source side must
  -- gross them up too for an apples-to-apples sum.
  SELECT
    (SELECT COALESCE(SUM(amount_cents), 0) FROM public.expenses)
    +
    (SELECT COALESCE(SUM(amount_cents + gst_cents), 0) FROM public.project_bills)
  INTO source_amount_sum;

  SELECT COALESCE(SUM(amount_cents), 0) INTO dest_amount_sum FROM public.project_costs;

  IF dest_amount_sum <> source_amount_sum THEN
    RAISE EXCEPTION
      'project_costs backfill amount sum mismatch: source=% dest=%',
      source_amount_sum, dest_amount_sum;
  END IF;
END $$;
