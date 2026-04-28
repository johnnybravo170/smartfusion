-- 0148_change_order_cost_breakdown
--
-- Per-budget-category attribution on change orders. Today the form
-- captures a single $ amount + a list of "affected buckets" — no way
-- to know after-the-fact how the total split across categories. This
-- adds a `cost_breakdown` JSONB column storing
--   [{ "budget_category_id": "...", "amount_cents": N }, ...]
-- Sum across rows = cost_impact_cents (form enforces this).
--
-- Interim — the proper change-order-as-diff refactor lives on a separate
-- kanban card. This unblocks JVD on attribution today without rebuilding
-- the entire flow.

BEGIN;

ALTER TABLE public.change_orders
  ADD COLUMN cost_breakdown JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.change_orders.cost_breakdown IS
  'Per-budget-category amount allocation. Array of { budget_category_id (uuid), amount_cents (bigint) }. Sum equals cost_impact_cents. Older rows have [] until backfilled or replaced.';

COMMIT;
