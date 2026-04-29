-- 0154_change_order_lines_envelope_action
--
-- Allow change_order_lines.action to record category-envelope changes.
-- The v2 line-diff form is being extended so the operator can modify a
-- budget category's envelope estimate (the bucket-level $ amount on the
-- Budget tab) as a tracked diff entry. Adds a new action value:
--   'modify_envelope' — change a budget_category.estimate_cents
--
-- For these rows: budget_category_id is the target; line_price_cents is
-- the NEW envelope amount; before_snapshot holds the prior estimate_cents.
-- original_line_id stays null (envelope changes don't reference a cost
-- line). qty/unit_price/etc. stay null.

BEGIN;

ALTER TABLE public.change_order_lines
  DROP CONSTRAINT IF EXISTS change_order_lines_action_check;

ALTER TABLE public.change_order_lines
  ADD CONSTRAINT change_order_lines_action_check
  CHECK (action IN ('add', 'modify', 'remove', 'modify_envelope'));

COMMIT;
