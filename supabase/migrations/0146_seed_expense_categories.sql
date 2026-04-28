-- 0146_seed_expense_categories
--
-- 0101 promised an "application-level helper" to seed expense_categories
-- for new tenants but it was never wired. Since then the `personal`
-- vertical was added (0145) which the 0101 backfill never touched. End
-- result: tenants created post-0101 (and any `personal` tenant) land on
-- the expense form with an empty category dropdown and can't submit.
--
-- This migration:
--   1. Defines a SECURITY DEFINER RPC that the signup action calls
--      to seed defaults for a freshly-created tenant.
--   2. Backfills every existing tenant currently sitting on zero
--      active categories.
--
-- Idempotent: relies on the (tenant_id, parent_id, name) UNIQUE NULLS
-- NOT DISTINCT constraint to dedupe inserts.

BEGIN;

CREATE OR REPLACE FUNCTION public.seed_default_expense_categories(
  p_tenant_id UUID,
  p_vertical  TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Vertical-specific lists mirror 0101_expense_categories.sql. Verticals
  -- not enumerated below fall through to the lighter universal set.
  IF p_vertical IN ('renovation', 'tile') THEN
    INSERT INTO public.expense_categories (tenant_id, name, display_order)
    VALUES
      (p_tenant_id, 'Fuel',              10),
      (p_tenant_id, 'Tools',             20),
      (p_tenant_id, 'Materials',         30),
      (p_tenant_id, 'Subcontractors',    40),
      (p_tenant_id, 'Office',            50),
      (p_tenant_id, 'Insurance',         60),
      (p_tenant_id, 'Software',          70),
      (p_tenant_id, 'Phone',             80),
      (p_tenant_id, 'Advertising',       90),
      (p_tenant_id, 'Professional Fees', 100),
      (p_tenant_id, 'Shop Supplies',     110),
      (p_tenant_id, 'Vehicles',          120),
      (p_tenant_id, 'Meals',             130),
      (p_tenant_id, 'Other',             999)
    ON CONFLICT (tenant_id, parent_id, name) DO NOTHING;
  ELSIF p_vertical = 'pressure_washing' THEN
    INSERT INTO public.expense_categories (tenant_id, name, display_order)
    VALUES
      (p_tenant_id, 'Fuel',              10),
      (p_tenant_id, 'Equipment',         20),
      (p_tenant_id, 'Chemicals',         30),
      (p_tenant_id, 'Office',            40),
      (p_tenant_id, 'Insurance',         50),
      (p_tenant_id, 'Software',          60),
      (p_tenant_id, 'Phone',             70),
      (p_tenant_id, 'Advertising',       80),
      (p_tenant_id, 'Professional Fees', 90),
      (p_tenant_id, 'Vehicles',          100),
      (p_tenant_id, 'Other',             999)
    ON CONFLICT (tenant_id, parent_id, name) DO NOTHING;
  ELSE
    -- Universal fallback (covers `personal` and any future vertical
    -- that lands before its explicit seed list).
    INSERT INTO public.expense_categories (tenant_id, name, display_order)
    VALUES
      (p_tenant_id, 'Fuel',         10),
      (p_tenant_id, 'Tools',        20),
      (p_tenant_id, 'Office',       30),
      (p_tenant_id, 'Insurance',    40),
      (p_tenant_id, 'Software',     50),
      (p_tenant_id, 'Phone',        60),
      (p_tenant_id, 'Advertising',  70),
      (p_tenant_id, 'Vehicles',     80),
      (p_tenant_id, 'Other',        999)
    ON CONFLICT (tenant_id, parent_id, name) DO NOTHING;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_default_expense_categories(UUID, TEXT)
  TO authenticated, service_role;

-- Backfill anyone currently sitting on zero active categories. This is
-- the recovery path for tenants created between 0101 and now (including
-- every `personal` workspace).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT t.id, t.vertical
    FROM public.tenants t
    WHERE NOT EXISTS (
      SELECT 1 FROM public.expense_categories ec
      WHERE ec.tenant_id = t.id AND ec.archived_at IS NULL
    )
  LOOP
    PERFORM public.seed_default_expense_categories(r.id, COALESCE(r.vertical, 'renovation'));
  END LOOP;
END;
$$;

COMMIT;
