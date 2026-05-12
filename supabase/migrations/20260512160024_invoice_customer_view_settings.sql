-- Per-invoice override of the customer-facing view settings.
--
-- Background: projects.customer_view_mode (lump_sum | sections | categories |
-- detailed) was added in 20260512014231 to drive the customer portal budget
-- rollup. The customer portal honors it (PR #205). Invoices still bake every
-- cost line into a separate line_item regardless of mode.
--
-- This migration adds two override columns on `invoices` so the operator can
-- pick the detail level for a *specific* invoice from a live-preview surface
-- on the draft invoice page. Both are nullable; null means "inherit from
-- projects.customer_view_mode at preview time, falling back to 'detailed'."
--
-- The project-level setting is unchanged — it still controls the portal and
-- now also pre-selects the toggles when an invoice draft is opened.
--
-- Behavior columns:
--   customer_view_mode             — which mode the persisted line_items were
--                                     materialized under. Drives the preview's
--                                     initial radio selection on re-open.
--   customer_view_mgmt_fee_inline  — whether the management fee was baked
--                                     into the headline total (true) or kept
--                                     as a separate line_item (false/null).
--                                     Most useful in lump_sum mode (Mike's
--                                     "take it or leave it" framing) but the
--                                     toggle is exposed for every mode.
--
-- No backfill: existing invoices keep null values, the preview computes its
-- initial state from the project default. Line_items already on those rows
-- are not rewritten by this migration.

alter table public.invoices
  add column if not exists customer_view_mode text null
    check (customer_view_mode is null or customer_view_mode in ('lump_sum', 'sections', 'categories', 'detailed')),
  add column if not exists customer_view_mgmt_fee_inline boolean null;
