-- Pricebook data backfill — copy existing `service_catalog` rows into
-- `catalog_items` so pressure-washing tenants see their pricebook in the
-- new model as soon as the UI lands. Quote/invoice consumers still read
-- from `service_catalog` until PR #3 of the Pricebook epic ships the
-- cutover; this migration just brings the data over.
--
-- Idempotent: re-running is a no-op because we key on a synthetic
-- composite (tenant_id, normalized name, pricing_model='per_unit',
-- unit_label='sqft', surface_type) and skip rows already present. If a
-- tenant manually creates a catalog_items row with the same name and
-- surface_type before this runs, we treat that as the canonical row and
-- leave it alone.
--
-- Mapping:
--   service_catalog.label              → catalog_items.name
--   service_catalog.surface_type       → catalog_items.surface_type
--   service_catalog.price_per_sqft_cents → catalog_items.unit_price_cents
--   service_catalog.min_charge_cents   → catalog_items.min_charge_cents
--   (constants)                        → pricing_model='per_unit',
--                                        unit_label='sqft',
--                                        category='service',
--                                        is_taxable=true
--   service_catalog.is_active          → catalog_items.is_active

INSERT INTO public.catalog_items (
  tenant_id,
  name,
  pricing_model,
  unit_label,
  unit_price_cents,
  min_charge_cents,
  is_taxable,
  category,
  surface_type,
  is_active,
  created_at,
  updated_at
)
SELECT
  sc.tenant_id,
  sc.label,
  'per_unit',
  'sqft',
  COALESCE(sc.price_per_sqft_cents, 0),
  COALESCE(sc.min_charge_cents, 0),
  TRUE,
  'service',
  sc.surface_type,
  sc.is_active,
  sc.created_at,
  sc.updated_at
FROM public.service_catalog sc
WHERE NOT EXISTS (
  SELECT 1
  FROM public.catalog_items ci
  WHERE ci.tenant_id = sc.tenant_id
    AND lower(ci.name) = lower(sc.label)
    AND ci.pricing_model = 'per_unit'
    AND ci.unit_label = 'sqft'
    AND COALESCE(ci.surface_type, '') = COALESCE(sc.surface_type, '')
);

-- Diagnostic: how many rows did we just insert? Visible in the migration
-- runner output. (NOTICE level so it doesn't fail the run.)
DO $$
DECLARE
  copied_count INT;
  source_count INT;
BEGIN
  SELECT count(*) INTO source_count FROM public.service_catalog;
  SELECT count(*) INTO copied_count
    FROM public.catalog_items
    WHERE pricing_model = 'per_unit' AND unit_label = 'sqft';
  RAISE NOTICE 'Pricebook backfill: % service_catalog rows, % catalog_items per_unit/sqft rows after merge.',
    source_count, copied_count;
END $$;
