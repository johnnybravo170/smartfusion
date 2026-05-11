-- Unified pricebook — catalog_items table.
--
-- Replaces the sqft-only `service_catalog` (pressure-washing carryover)
-- with a model that fits every vertical we're targeting:
--   - pressure washing  → pricing_model='per_unit', unit_label='sqft'
--   - HVAC/plumbing/electrical → pricing_model='fixed' (flat-rate pricebook)
--   - GC / renovation   → pricing_model='time_and_materials'
--   - roofing           → pricing_model='per_unit', unit_label='sq'
--   - landscaping       → pricing_model='per_unit' (visit) or 'fixed'
--   - hourly trades     → pricing_model='hourly', unit_label='hr'
--
-- This migration creates the new table only. The `service_catalog`
-- data migration + quote/invoice flow refactor + UI changes happen in
-- a separate PR (audit consumers first per Unified Pricebook card open
-- question). service_catalog stays intact and writeable for now —
-- coexistence buys time to switch consumers one at a time.
--
-- qbo_item_id round-trip: when QBO Import lands items, they target this
-- table directly. Matching from QBO → HH on re-import keys on
-- (tenant_id, qbo_item_id) — same uniqueness pattern as customers and
-- invoices.

CREATE TABLE IF NOT EXISTS public.catalog_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,

  -- Display
  name              TEXT NOT NULL,
  description       TEXT,
  sku               TEXT,           -- optional, for tenants who run a real catalog

  -- Pricing model — discriminates how the price is applied at quote/invoice time
  pricing_model     TEXT NOT NULL
    CHECK (pricing_model IN ('fixed', 'per_unit', 'hourly', 'time_and_materials')),

  -- For per_unit / hourly: what unit ('sqft','sq','room','hr','visit','each',...)
  -- NULL for 'fixed' and 'time_and_materials'.
  unit_label        TEXT,

  -- Price per unit (or flat price for 'fixed'). NULL for 'time_and_materials'.
  unit_price_cents  BIGINT
    CHECK (unit_price_cents IS NULL OR unit_price_cents >= 0),

  -- Floor charge (e.g. min $250 even on small sqft jobs). Optional.
  min_charge_cents  BIGINT
    CHECK (min_charge_cents IS NULL OR min_charge_cents >= 0),

  -- Tax + accounting classification
  is_taxable        BOOLEAN NOT NULL DEFAULT TRUE,
  category          TEXT
    CHECK (category IS NULL OR category IN ('labor','materials','service','inventory','other')),

  -- Pressure-washing compat: filters items in the legacy sqft quote
  -- builder. Future quote builder will treat this as just another tag.
  surface_type      TEXT,

  is_active         BOOLEAN NOT NULL DEFAULT TRUE,

  -- QBO round-trip
  qbo_item_id       TEXT,
  qbo_sync_token    TEXT,
  qbo_sync_status   TEXT
    CHECK (qbo_sync_status IS NULL OR qbo_sync_status IN ('synced','pending','failed','disabled')),
  qbo_synced_at     TIMESTAMPTZ,

  -- Import audit (so items imported from QBO can be rolled back)
  import_batch_id   UUID REFERENCES public.import_batches (id) ON DELETE SET NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Belt-and-braces: 'time_and_materials' rows MUST have NULL price
  -- (no fixed amount), and every other pricing_model MUST have a price.
  CONSTRAINT catalog_items_price_consistency CHECK (
    (pricing_model = 'time_and_materials' AND unit_price_cents IS NULL)
    OR
    (pricing_model <> 'time_and_materials' AND unit_price_cents IS NOT NULL)
  )
);

-- Tenant-scoped catalog browsing
CREATE INDEX IF NOT EXISTS idx_catalog_items_tenant_active
  ON public.catalog_items (tenant_id, is_active, name);
-- Surface-filtered browsing (pressure-washing legacy quote builder)
CREATE INDEX IF NOT EXISTS idx_catalog_items_surface
  ON public.catalog_items (tenant_id, surface_type)
  WHERE surface_type IS NOT NULL AND is_active = TRUE;
-- QBO re-import idempotency
CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_tenant_qbo_id_uniq
  ON public.catalog_items (tenant_id, qbo_item_id)
  WHERE qbo_item_id IS NOT NULL;
-- Rollback path
CREATE INDEX IF NOT EXISTS idx_catalog_items_import_batch
  ON public.catalog_items (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

ALTER TABLE public.catalog_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_select_catalog_items ON public.catalog_items
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_insert_catalog_items ON public.catalog_items
  FOR INSERT TO authenticated WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_update_catalog_items ON public.catalog_items
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY tenant_delete_catalog_items ON public.catalog_items
  FOR DELETE TO authenticated USING (tenant_id = public.current_tenant_id());

COMMENT ON TABLE public.catalog_items IS
  'Unified pricebook. Replaces sqft-only service_catalog with a multi-vertical model (fixed/per_unit/hourly/time_and_materials). QBO items land here on import.';
COMMENT ON COLUMN public.catalog_items.pricing_model IS
  'How the price is applied: fixed (flat per line), per_unit (× unit_label), hourly (× hours), time_and_materials (price set per quote/invoice).';
COMMENT ON COLUMN public.catalog_items.surface_type IS
  'Pressure-washing legacy filter. Future quote builder treats this as a tag, not a discriminator. Safe to leave NULL for non-pressure-washing items.';
