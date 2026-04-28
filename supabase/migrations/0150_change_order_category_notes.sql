-- 0150_change_order_category_notes
--
-- Per-category narrative notes on change orders. Cost numbers say WHAT
-- changed; notes say WHY. The Bathroom category went up by $2k? The
-- note explains "rotted subfloor discovered during demo." Customer
-- approval reads way better with both.
--
-- Format: [{ budget_category_id (uuid), note (text) }, ...]. Empty
-- array for COs without notes (default). Surfaces alongside the diff
-- in both the operator detail view and the customer approval page.

BEGIN;

ALTER TABLE public.change_orders
  ADD COLUMN category_notes JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.change_orders.category_notes IS
  'Per-budget-category narrative notes. Array of { budget_category_id, note }. Independent of cost_breakdown / change_order_lines — explains WHY the category was affected.';

COMMIT;
