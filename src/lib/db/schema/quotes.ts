/**
 * `quotes` — a priced bundle of surfaces for a customer.
 *
 * DDL source of truth: `supabase/migrations/0007_quotes.sql`
 * (plus `0018_soft_delete.sql` for `deleted_at`).
 */

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { tenants } from './tenants';

export const quotes = pgTable(
  'quotes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    status: text('status').default('draft').notNull(),
    subtotalCents: integer('subtotal_cents').default(0).notNull(),
    taxCents: integer('tax_cents').default(0).notNull(),
    totalCents: integer('total_cents').default(0).notNull(),
    notes: text('notes'),
    pdfUrl: text('pdf_url'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    check(
      'quotes_status_check',
      sql`${table.status} IN ('draft', 'sent', 'accepted', 'rejected', 'expired')`,
    ),
  ],
);

export type Quote = typeof quotes.$inferSelect;
export type NewQuote = typeof quotes.$inferInsert;
