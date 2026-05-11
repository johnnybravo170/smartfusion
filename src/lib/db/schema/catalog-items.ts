/**
 * `catalog_items` — per-tenant unified pricebook.
 *
 * Replaces the sqft-only `service_catalog` with a model that fits every
 * vertical (HVAC flat-rate, GC time-and-materials, pressure-washing per-sqft,
 * etc.). See migration `20260511152126_catalog_items.sql`.
 *
 * PR #1 of the Pricebook epic introduces the schema + queries only; consumers
 * keep reading `service_catalog`. The cutover happens in PR #3.
 */

import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const CATALOG_PRICING_MODELS = [
  'fixed',
  'per_unit',
  'hourly',
  'time_and_materials',
] as const;
export type CatalogPricingModel = (typeof CATALOG_PRICING_MODELS)[number];

export const CATALOG_CATEGORIES = ['labor', 'materials', 'service', 'inventory', 'other'] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

export const catalogItems = pgTable(
  'catalog_items',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    sku: text('sku'),
    pricingModel: text('pricing_model').notNull().$type<CatalogPricingModel>(),
    unitLabel: text('unit_label'),
    unitPriceCents: integer('unit_price_cents'),
    minChargeCents: integer('min_charge_cents'),
    isTaxable: boolean('is_taxable').default(true).notNull(),
    category: text('category').$type<CatalogCategory | null>(),
    surfaceType: text('surface_type'),
    isActive: boolean('is_active').default(true).notNull(),
    qboItemId: text('qbo_item_id'),
    qboSyncToken: text('qbo_sync_token'),
    qboSyncStatus: text('qbo_sync_status'),
    qboSyncedAt: timestamp('qbo_synced_at', { withTimezone: true }),
    // FK to public.import_batches (declared at DB level; no Drizzle mirror for that table).
    importBatchId: uuid('import_batch_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    uniqueIndex('catalog_items_tenant_qbo_id_uniq')
      .on(table.tenantId, table.qboItemId)
      .where(sql`${table.qboItemId} IS NOT NULL`),
  ],
);

export type CatalogItem = typeof catalogItems.$inferSelect;
export type NewCatalogItem = typeof catalogItems.$inferInsert;
