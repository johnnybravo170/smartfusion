/**
 * `quote_surfaces` — line items on a quote.
 *
 * NOTE: no `tenant_id` column by design; tenant is inherited via
 * `quote_id -> quotes.tenant_id`. See header comment in
 * `supabase/migrations/0008_quote_surfaces.sql` and the DECISIONS.md entry.
 *
 * DDL source of truth: `supabase/migrations/0008_quote_surfaces.sql`.
 */

import { sql } from 'drizzle-orm';
import { integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { quotes } from './quotes';

export const quoteSurfaces = pgTable('quote_surfaces', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  quoteId: uuid('quote_id')
    .notNull()
    .references(() => quotes.id, { onDelete: 'cascade' }),
  surfaceType: text('surface_type').notNull(),
  polygonGeojson: jsonb('polygon_geojson'),
  sqft: numeric('sqft', { precision: 12, scale: 2 }),
  priceCents: integer('price_cents').default(0).notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
});

export type QuoteSurface = typeof quoteSurfaces.$inferSelect;
export type NewQuoteSurface = typeof quoteSurfaces.$inferInsert;
