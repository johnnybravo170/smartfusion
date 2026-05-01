-- 0171_rename_change_orders_affected_buckets
--
-- Final piece of the bucket → budget category rename
-- (migration 0147 handled the main tables; this catches the
-- `change_orders.affected_buckets` JSONB column that was missed).
--
-- Pure rename — no data transformation. The column holds a JSONB array
-- of budget category IDs, and the code already treats them as such
-- (variables named `affectedCategories`); only the column name lagged.

BEGIN;

ALTER TABLE public.change_orders
  RENAME COLUMN affected_buckets TO affected_budget_categories;

COMMIT;
