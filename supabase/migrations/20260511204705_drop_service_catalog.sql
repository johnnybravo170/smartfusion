-- Drop the legacy `service_catalog` table.
--
-- The sqft-only pricebook has been replaced by `catalog_items`. All
-- consumers (quote actions, lead-gen, public quote page, Henry/MCP
-- list_catalog tool) now read from catalog_items. Data was backfilled
-- in migration 20260511185718_pricebook_data_backfill.sql.
--
-- Safe to drop: no foreign keys point at this table (quote_surfaces
-- joined by string `surface_type`, not by FK). Confirmed no active
-- pressure-washing tenants are currently quoting through this table.
--
-- Reversal: if needed, restore from the nightly-backup artifacts.
-- Don't roll forward without restoring the consumer code first.

DROP TABLE IF EXISTS public.service_catalog CASCADE;
