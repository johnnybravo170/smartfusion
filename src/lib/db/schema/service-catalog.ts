/**
 * `service_catalog` — per-tenant price list.
 *
 * DDL source of truth: `supabase/migrations/0006_service_catalog.sql`.
 */

import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const serviceCatalog = pgTable(
  'service_catalog',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    surfaceType: text('surface_type').notNull(),
    label: text('label').notNull(),
    pricePerSqftCents: integer('price_per_sqft_cents'),
    minChargeCents: integer('min_charge_cents').default(0).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    unique('service_catalog_tenant_surface_unique').on(table.tenantId, table.surfaceType),
  ],
);

export type ServiceCatalogEntry = typeof serviceCatalog.$inferSelect;
export type NewServiceCatalogEntry = typeof serviceCatalog.$inferInsert;
