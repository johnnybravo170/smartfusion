-- Add tenants.country + tighten currency/region constraints.
--
-- Part of US-expansion architectural prep (see US_EXPANSION_PLAN.md +
-- kanban card d336dfd3). Doesn't build anything US-specific — just
-- establishes the seams so later US work is a pure data + provider
-- swap, not a schema migration under customer pressure.
--
-- Pre-existing:
--   tenants.region    TEXT NOT NULL DEFAULT 'ca-central-1'  (CHECK = 'ca-central-1')
--   tenants.currency  TEXT NOT NULL DEFAULT 'CAD'           (no CHECK)
--   tenants.province  TEXT                                  (no CHECK — Canadian province letter code or full name today)
--
-- This migration:
--   1. Adds tenants.country (default 'CA', CHECK 'CA'|'US')
--   2. Adds a CHECK on tenants.currency restricting to 'CAD'|'USD'
--   3. Leaves tenants.region CHECK alone — expanding that is Phase 3
--      (actual us-east-1 spin-up), not architectural prep.

BEGIN;

-- =============================================================
-- 1. tenants.country
-- =============================================================
ALTER TABLE public.tenants
  ADD COLUMN country TEXT NOT NULL DEFAULT 'CA'
    CHECK (country IN ('CA', 'US'));

-- Every existing row is Canadian (all four tenants — see pre-migration
-- snapshot). Default already handled it but be explicit for future
-- readers of this migration.
UPDATE public.tenants SET country = 'CA' WHERE country IS NULL;

-- =============================================================
-- 2. Restrict currency to the two we support
-- =============================================================
-- Guard against an operator accidentally setting currency='EUR' via
-- the Supabase table editor and breaking invoice rendering later.
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_currency_check
    CHECK (currency IN ('CAD', 'USD'));

COMMIT;
