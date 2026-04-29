-- 0161_change_order_mgmt_fee_override
--
-- Per-CO management fee override. Default behavior (NULL) preserves the
-- project-level rate, so existing rows need no backfill. When set, the
-- override applies to this CO's cost impact only — the rest of the
-- project's revenue still uses projects.management_fee_rate.
--
-- Reason is operator-facing; surfaced on the project overview audit row
-- and the CO detail callout. The form requires it when the rate deviates
-- from the project default.

BEGIN;

ALTER TABLE public.change_orders
  ADD COLUMN management_fee_override_rate NUMERIC(5,4) NULL
    CHECK (
      management_fee_override_rate IS NULL
      OR (management_fee_override_rate >= 0 AND management_fee_override_rate <= 0.5)
    ),
  ADD COLUMN management_fee_override_reason TEXT NULL;

COMMENT ON COLUMN public.change_orders.management_fee_override_rate IS
  'Per-CO management fee rate (0..0.5). NULL = use projects.management_fee_rate. Applied against this CO''s cost_impact_cents in the variance calc.';

COMMENT ON COLUMN public.change_orders.management_fee_override_reason IS
  'Operator-recorded reason for deviating from the project''s default management fee on this CO. Required by the UI when the rate differs from the project default.';

COMMIT;
