-- 0163_project_variance_rpc.sql
-- Single-shot variance aggregator for the project Overview tab.
--
-- The TS `getVarianceReport` query previously fired 8 parallel SELECTs for
-- the project-level totals (bills, expenses, cost lines, projects, time
-- entries, change orders, sub-quote allocations, PO items). Even with
-- Promise.all that's 8 round-trips to Supabase from Vercel. This RPC folds
-- all of them into a single trip and returns a JSONB blob with the data
-- shape the TS code needs.
--
-- Per-category breakdown stays in `getBudgetVsActual` for now — that path
-- is shared with the Budget tab, AI tools, and the memos tab, and changing
-- it would touch too many surfaces for a perf-focused commit.
--
-- Security: SECURITY INVOKER (default for SQL functions) — runs as the
-- caller, so tenant-isolation RLS on every underlying table still applies.
-- A user who can't SELECT the project's rows directly will get zeros from
-- every aggregate, which is the same as if the project didn't exist.

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
    'bills_total_cents', COALESCE((
      SELECT SUM(amount_cents)::bigint
      FROM public.project_bills
      WHERE project_id = p_project_id
    ), 0),
    'expenses_total_cents', COALESCE((
      SELECT SUM(amount_cents)::bigint
      FROM public.expenses
      WHERE project_id = p_project_id
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

GRANT EXECUTE ON FUNCTION public.get_project_variance_aggregates(UUID) TO authenticated;

COMMENT ON FUNCTION public.get_project_variance_aggregates(UUID) IS
  'Project Overview variance aggregator. Returns one JSONB blob with every project-level total the variance card needs (bills, expenses, lines, labour, committed, COs). Replaces 8 parallel SELECTs with one round-trip. Per-category breakdown still computed by getBudgetVsActual.';
