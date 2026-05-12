-- Fix: get_project_variance_aggregates still referenced the legacy
-- `expenses` + `project_bills` tables that PR #200 dropped. Calling
-- the RPC after that drop failed silently, returning null data — and
-- because every downstream consumer used `?? 0` fallbacks, the
-- operator Overview tab quietly stopped showing the management fee
-- (mgmt_fee_rate fell back to 0 → mgmt_fee_cents 0 → row hidden by
-- the `mgmt_fee_cents > 0` conditional in budget-summary.tsx).
--
-- Caught by the audit-lens E2E test that expects "management fee" to
-- appear on the Revenue composition card after applying a CO.
--
-- Fix: rewrite the bills + expenses aggregates against project_costs,
-- preserving the byte-identical mixed semantics from PR #6:
--   - Receipts (source_type='receipt') → gross amount_cents
--   - Vendor bills (source_type='vendor_bill') → pre_tax_amount_cents
--     (falling back to amount_cents when pre_tax is null).
-- Active rows only (status='active').

CREATE OR REPLACE FUNCTION public.get_project_variance_aggregates(p_project_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'management_fee_rate', (
      SELECT management_fee_rate FROM public.projects WHERE id = p_project_id
    ),
    'lines_subtotal_cents', COALESCE((
      SELECT SUM(line_price_cents)::bigint
      FROM public.project_cost_lines
      WHERE project_id = p_project_id
    ), 0),
    -- Per-category line-price totals for the scope_subtotal calculation.
    -- Keys are budget_category_id::text (or '__uncategorized__' for NULL).
    'lines_by_category', COALESCE((
      SELECT jsonb_object_agg(
        COALESCE(budget_category_id::text, '__uncategorized__'),
        total_cents
      )
      FROM (
        SELECT budget_category_id, SUM(line_price_cents)::bigint AS total_cents
        FROM public.project_cost_lines
        WHERE project_id = p_project_id
        GROUP BY budget_category_id
      ) t
    ), '{}'::jsonb),
    -- Vendor bills (pre-tax) — matches the legacy project_bills
    -- semantics PR #6 locked in for byte-identical variance numbers.
    'bills_total_cents', COALESCE((
      SELECT SUM(COALESCE(pre_tax_amount_cents, amount_cents))::bigint
      FROM public.project_costs
      WHERE project_id = p_project_id
        AND source_type = 'vendor_bill'
        AND status = 'active'
    ), 0),
    -- Receipts (gross) — matches the legacy expenses table.
    'expenses_total_cents', COALESCE((
      SELECT SUM(amount_cents)::bigint
      FROM public.project_costs
      WHERE project_id = p_project_id
        AND source_type = 'receipt'
        AND status = 'active'
    ), 0),
    'labour_total_cents', COALESCE((
      SELECT SUM(ROUND(hours * COALESCE(hourly_rate_cents, 0)))::bigint
      FROM public.time_entries
      WHERE project_id = p_project_id
    ), 0),
    'committed_vendor_quotes_cents', COALESCE((
      SELECT SUM(a.allocated_cents)::bigint
      FROM public.project_sub_quote_allocations a
      JOIN public.project_sub_quotes q ON q.id = a.sub_quote_id
      WHERE q.project_id = p_project_id
        AND q.status = 'accepted'
    ), 0),
    'committed_pos_cents', COALESCE((
      SELECT SUM(i.line_total_cents)::bigint
      FROM public.purchase_order_items i
      JOIN public.purchase_orders o ON o.id = i.po_id
      WHERE o.project_id = p_project_id
        AND o.status IN ('sent', 'acknowledged', 'received')
    ), 0),
    'change_orders', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'status', status,
        'applied_at', applied_at,
        'cost_impact_cents', cost_impact_cents,
        'flow_version', flow_version,
        'management_fee_override_rate', management_fee_override_rate
      ) ORDER BY created_at)
      FROM public.change_orders
      WHERE project_id = p_project_id
    ), '[]'::jsonb)
  );
$$;

COMMENT ON FUNCTION public.get_project_variance_aggregates(UUID) IS
  'Project Overview variance aggregator. Returns one JSONB blob with every project-level total the variance card needs (bills, expenses, lines, labour, committed, COs). Reads cost data from the unified `project_costs` table (PR #200 dropped the legacy `expenses` + `project_bills` tables).';

-- Same root cause for get_business_health_metrics. The `ap` and
-- `expenses_out` CTEs read from the dropped legacy tables; the
-- /business-health screen has been showing $0 AP and $0 outflows
-- since PR #200 merged. Rewrite both CTEs against project_costs.
--
-- Mapping:
--   legacy project_bills.status IN ('pending','approved')
--     → project_costs.payment_status = 'unpaid' (PR #5 collapsed the
--       three-state legacy enum into 'paid' / 'unpaid' / 'partial').
--     → vendor_bill rows only.
--     → amount_cents preserved verbatim from legacy (PR #6 backfill).
--   legacy expenses.expense_date → project_costs.cost_date
--   legacy expenses.amount_cents (gross) → project_costs.amount_cents
--     for source_type='receipt' (same gross semantic).

CREATE OR REPLACE FUNCTION public.get_business_health_metrics(p_year INT DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH
    fy AS (
      SELECT
        COALESCE(p_year, EXTRACT(YEAR FROM CURRENT_DATE)::INT) AS year
    ),
    fy_range AS (
      SELECT
        MAKE_DATE((SELECT year FROM fy), 1, 1)  AS start_date,
        MAKE_DATE((SELECT year FROM fy), 12, 31) AS end_date
    ),
    revenue AS (
      SELECT COALESCE(SUM(amount_cents + tax_cents), 0)::BIGINT AS total_cents
      FROM public.invoices
      WHERE status = 'paid'
        AND deleted_at IS NULL
        AND paid_at >= (SELECT start_date FROM fy_range)
        AND paid_at <  (SELECT end_date FROM fy_range) + INTERVAL '1 day'
    ),
    ar AS (
      SELECT
        COALESCE(SUM(amount_cents + tax_cents), 0)::BIGINT AS total_cents,
        COUNT(*)::INT                                       AS count,
        MIN(COALESCE(sent_at, created_at))                  AS oldest_at
      FROM public.invoices
      WHERE status = 'sent'
        AND paid_at IS NULL
        AND deleted_at IS NULL
    ),
    ap AS (
      SELECT
        COALESCE(SUM(amount_cents), 0)::BIGINT AS total_cents,
        COUNT(*)::INT                          AS count
      FROM public.project_costs
      WHERE source_type = 'vendor_bill'
        AND payment_status = 'unpaid'
        AND status = 'active'
    ),
    owner_pay AS (
      SELECT
        COALESCE(SUM(by_type_total), 0)::BIGINT AS total_cents,
        COALESCE(
          jsonb_object_agg(draw_type, by_type_total) FILTER (WHERE draw_type IS NOT NULL),
          '{}'::jsonb
        ) AS by_type
      FROM (
        SELECT
          draw_type,
          SUM(amount_cents)::BIGINT AS by_type_total
        FROM public.owner_draws
        WHERE paid_at >= (SELECT start_date FROM fy_range)
          AND paid_at <= (SELECT end_date FROM fy_range)
        GROUP BY draw_type
      ) t
    ),
    expenses_out AS (
      SELECT COALESCE(SUM(amount_cents), 0)::BIGINT AS total_cents
      FROM public.project_costs
      WHERE source_type = 'receipt'
        AND status = 'active'
        AND cost_date >= (SELECT start_date FROM fy_range)
        AND cost_date <= (SELECT end_date FROM fy_range)
    )
  SELECT jsonb_build_object(
    'year',               (SELECT year FROM fy),
    'fy_start',           (SELECT start_date FROM fy_range),
    'fy_end',             (SELECT end_date FROM fy_range),
    'revenue_ytd_cents',  (SELECT total_cents FROM revenue),
    'ar_outstanding', jsonb_build_object(
      'total_cents', (SELECT total_cents FROM ar),
      'count',       (SELECT count       FROM ar),
      'oldest_at',   (SELECT oldest_at   FROM ar)
    ),
    'ap_outstanding', jsonb_build_object(
      'total_cents', (SELECT total_cents FROM ap),
      'count',       (SELECT count       FROM ap)
    ),
    'owner_pay_ytd', jsonb_build_object(
      'total_cents', (SELECT total_cents FROM owner_pay),
      'by_type',     (SELECT by_type     FROM owner_pay)
    ),
    'outflows_ytd_cents',
      (SELECT total_cents FROM expenses_out)
      + (SELECT total_cents FROM owner_pay),
    'net_cash_flow_ytd_cents',
      (SELECT total_cents FROM revenue)
      - ((SELECT total_cents FROM expenses_out) + (SELECT total_cents FROM owner_pay))
  );
$$;

COMMENT ON FUNCTION public.get_business_health_metrics(INT) IS
  'Aggregates the 5 cards on /business-health (revenue, AR, AP, owner pay, net cash flow) in a single round-trip. Reads from unified `project_costs` (legacy tables dropped in PR #200). project_bills paid status excluded from cash-flow until BR-7 lands.';
