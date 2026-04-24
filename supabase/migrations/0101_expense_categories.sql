-- Expense categories + overhead expense support.
--
-- Context: HeyHenry has always scoped expenses to a project. JVD's
-- founding-customer feedback: he also needs to log "global" expenses
-- (truck gas, tools, shop supplies, insurance, software) that don't
-- belong to any project. Research brief lived at PROJECT_LIFECYCLE_PLAN
-- -adjacent "Tier 1" overhead expenses spec.
--
-- Design summary:
--   - New `expense_categories` table, tenant-scoped, editable. Flat list
--     with 1 level of nesting via self-FK `parent_id` (e.g. "Vehicles ›
--     Truck 1"). Seeded per-vertical on tenant creation AND backfilled
--     for existing tenants in this migration.
--   - `expense_categories.account_code` is a nullable free-text column
--     that a bookkeeper (or power user) can optionally fill in with
--     their own chart-of-accounts code. Hidden by default in the UI.
--   - `expenses.category_id` FK to the new table. Nullable so legacy
--     rows don't break.
--   - `expenses.tax_cents` tracks the GST/HST portion separately for
--     ITC tracking at year-end. Mirrors project_bills.gst_cents.
--   - `tenants.show_account_codes` boolean toggles the hidden account-
--     code column in the settings UI.
--
-- What we're deliberately NOT building here: a rigid chart of accounts,
-- journal entries, balance sheet. Accountants do the real books in
-- their own software; HeyHenry's job is to make the year-end handoff
-- clean, not to BE the bookkeeping software.

BEGIN;

-- =============================================================
-- 1. Category table
-- =============================================================
CREATE TABLE public.expense_categories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  parent_id     UUID REFERENCES public.expense_categories(id) ON DELETE RESTRICT,
  name          TEXT NOT NULL CHECK (length(trim(name)) > 0),
  account_code  TEXT,
  display_order INT NOT NULL DEFAULT 0,
  archived_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Two children with the same name under the same parent are confusing.
  -- Uniqueness is scoped to (tenant, parent, name) — NULL parent is fine
  -- because Postgres treats NULL as distinct in UNIQUE.
  UNIQUE NULLS NOT DISTINCT (tenant_id, parent_id, name)
);

CREATE INDEX idx_expense_categories_tenant ON public.expense_categories(tenant_id)
  WHERE archived_at IS NULL;
CREATE INDEX idx_expense_categories_parent ON public.expense_categories(parent_id)
  WHERE parent_id IS NOT NULL;

-- Enforce 1-level nesting: a category with a parent cannot itself be a
-- parent. We do this with a trigger because Postgres CHECK constraints
-- can't reference other rows.
CREATE OR REPLACE FUNCTION public.enforce_expense_category_nesting()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.expense_categories
      WHERE id = NEW.parent_id AND parent_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'expense_categories supports only one level of nesting';
    END IF;
  END IF;
  -- Also: if THIS row has children, it can't itself be moved under another parent.
  IF NEW.parent_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.expense_categories WHERE parent_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'cannot nest a category that already has children';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_expense_categories_nesting
  BEFORE INSERT OR UPDATE ON public.expense_categories
  FOR EACH ROW EXECUTE FUNCTION public.enforce_expense_category_nesting();

ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY expense_categories_tenant_select ON public.expense_categories
  FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id());

CREATE POLICY expense_categories_tenant_insert ON public.expense_categories
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY expense_categories_tenant_update ON public.expense_categories
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

CREATE POLICY expense_categories_tenant_delete ON public.expense_categories
  FOR DELETE TO authenticated
  USING (tenant_id = public.current_tenant_id());

-- =============================================================
-- 2. Columns on expenses + tenants
-- =============================================================
ALTER TABLE public.expenses
  ADD COLUMN category_id UUID REFERENCES public.expense_categories(id) ON DELETE SET NULL,
  ADD COLUMN tax_cents   BIGINT NOT NULL DEFAULT 0;

CREATE INDEX idx_expenses_category ON public.expenses(category_id);
CREATE INDEX idx_expenses_overhead ON public.expenses(tenant_id, expense_date)
  WHERE project_id IS NULL;

ALTER TABLE public.tenants
  ADD COLUMN show_account_codes BOOLEAN NOT NULL DEFAULT FALSE;

-- =============================================================
-- 3. Seed defaults for existing tenants
-- =============================================================
-- Default categories by vertical. Renovation/tile/GC work gets a more
-- detailed list; pressure washing etc. get a lighter set. Parent-only
-- entries (like "Vehicles") can have children added by the operator
-- later. This is a migration-time backfill; new tenants get the same
-- seed via an application-level helper (not a trigger, so operators
-- can override vertical at create time without duplicating logic).
WITH defaults(vertical, name, display_order) AS (
  VALUES
    -- Renovation / tile (GC work)
    ('renovation',       'Fuel',              10),
    ('renovation',       'Tools',             20),
    ('renovation',       'Materials',         30),
    ('renovation',       'Subcontractors',    40),
    ('renovation',       'Office',            50),
    ('renovation',       'Insurance',         60),
    ('renovation',       'Software',          70),
    ('renovation',       'Phone',             80),
    ('renovation',       'Advertising',       90),
    ('renovation',       'Professional Fees', 100),
    ('renovation',       'Shop Supplies',     110),
    ('renovation',       'Vehicles',          120),
    ('renovation',       'Meals',             130),
    ('renovation',       'Other',             999),
    ('tile',             'Fuel',              10),
    ('tile',             'Tools',             20),
    ('tile',             'Materials',         30),
    ('tile',             'Subcontractors',    40),
    ('tile',             'Office',            50),
    ('tile',             'Insurance',         60),
    ('tile',             'Software',          70),
    ('tile',             'Phone',             80),
    ('tile',             'Advertising',       90),
    ('tile',             'Professional Fees', 100),
    ('tile',             'Shop Supplies',     110),
    ('tile',             'Vehicles',          120),
    ('tile',             'Meals',             130),
    ('tile',             'Other',             999),
    -- Pressure washing / lighter service verticals: trimmed list
    ('pressure_washing', 'Fuel',              10),
    ('pressure_washing', 'Equipment',         20),
    ('pressure_washing', 'Chemicals',         30),
    ('pressure_washing', 'Office',            40),
    ('pressure_washing', 'Insurance',         50),
    ('pressure_washing', 'Software',          60),
    ('pressure_washing', 'Phone',             70),
    ('pressure_washing', 'Advertising',       80),
    ('pressure_washing', 'Professional Fees', 90),
    ('pressure_washing', 'Vehicles',          100),
    ('pressure_washing', 'Other',             999)
)
INSERT INTO public.expense_categories (tenant_id, name, display_order)
SELECT t.id, d.name, d.display_order
FROM public.tenants t
JOIN defaults d ON d.vertical = t.vertical;

-- For tenants whose vertical isn't in the defaults list, seed a minimal
-- universal set so nobody lands on an empty page.
INSERT INTO public.expense_categories (tenant_id, name, display_order)
SELECT t.id, x.name, x.display_order
FROM public.tenants t
CROSS JOIN (VALUES
  ('Fuel',         10),
  ('Tools',        20),
  ('Office',       30),
  ('Insurance',    40),
  ('Software',     50),
  ('Phone',        60),
  ('Advertising',  70),
  ('Vehicles',     80),
  ('Other',        999)
) AS x(name, display_order)
WHERE t.vertical NOT IN ('renovation', 'tile', 'pressure_washing')
  AND NOT EXISTS (
    SELECT 1 FROM public.expense_categories ec WHERE ec.tenant_id = t.id
  );

-- Matches codebase convention: updated_at is set from application code on
-- every update (see e.g. renameProjectAction), not via DB trigger.

COMMIT;
