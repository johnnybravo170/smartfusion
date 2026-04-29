-- 0155_change_order_applied_at
--
-- When a v2 line-diff change order is approved, the staged diff in
-- change_order_lines should be APPLIED to the underlying baseline:
--   add → INSERT into project_cost_lines
--   modify → UPDATE the matching project_cost_lines row
--   remove → DELETE the matching project_cost_lines row
--   modify_envelope → UPDATE project_budget_categories.estimate_cents
--
-- Today the v1 path even-distributes cost_impact across affected_buckets
-- on approval — fine for the legacy `cost_breakdown` model. The v2 path
-- needs a real per-line apply so the estimate becomes the new baseline
-- for the next CO. Without this, every approved v2 CO is "documentation
-- only" and successive COs build off stale state. This is the keystone
-- of "data flows upward."
--
-- `applied_at` is set after a successful apply (separate from
-- `approved_at` so we can detect approval-without-apply if a partial
-- failure occurred). Idempotency: we skip the apply when applied_at is
-- already set.
--
-- `apply_warnings` is a JSON array of human-readable warnings recorded
-- during the apply (e.g. "original line was deleted between CO creation
-- and approval — modify skipped"). Surfaced in the operator detail view
-- so they can manually reconcile.

BEGIN;

ALTER TABLE public.change_orders
  ADD COLUMN applied_at TIMESTAMPTZ,
  ADD COLUMN apply_warnings JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.change_orders.applied_at IS
  'Timestamp when the change_order_lines diff was applied to project_cost_lines + project_budget_categories. NULL means either v1 (legacy even-distribute) or v2 not-yet-applied.';

COMMENT ON COLUMN public.change_orders.apply_warnings IS
  'Array of warnings recorded during diff apply. Each entry: { code, message, affected_id? }. Operator-visible.';

COMMIT;
