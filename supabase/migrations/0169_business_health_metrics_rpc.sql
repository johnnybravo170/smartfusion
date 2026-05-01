-- 0169_business_health_metrics_rpc.sql
-- Single-shot aggregator for the /business-health overview screen.
-- Folds five metrics into one round-trip: revenue YTD, AR outstanding,
-- AP outstanding, owner pay YTD (with per-type breakdown), and net cash
-- flow YTD.
--
-- Security: SECURITY INVOKER (default) — runs as the caller, so RLS on
-- every underlying table still applies. A caller from a different tenant
-- gets zeros. Year defaults to the current calendar year if not provided.
--
-- Net cash flow simplification (v1):
--   outflows_ytd = expenses (expense_date YTD) + owner_draws (paid_at YTD)
-- project_bills are intentionally NOT counted toward cash flow yet — once
-- BR-7 marks bills paid via bank reconciliation we'll fold them in (they'd
-- otherwise risk double-counting against expenses already logged).

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
      FROM public.project_bills
      WHERE status IN ('pending', 'approved')
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
      FROM public.expenses
      WHERE expense_date >= (SELECT start_date FROM fy_range)
        AND expense_date <= (SELECT end_date FROM fy_range)
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

REVOKE ALL ON FUNCTION public.get_business_health_metrics(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_business_health_metrics(INT) TO authenticated;

COMMENT ON FUNCTION public.get_business_health_metrics(INT) IS
  'Aggregates the 5 cards on /business-health (revenue, AR, AP, owner pay, net cash flow) in a single round-trip. SECURITY INVOKER — RLS on each underlying table determines visibility. project_bills paid status excluded from cash-flow until BR-7 lands.';
