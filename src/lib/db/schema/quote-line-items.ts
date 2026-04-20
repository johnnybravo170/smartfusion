import { sql } from 'drizzle-orm';
import { integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { quotes } from './quotes';

export const quoteLineItems = pgTable('quote_line_items', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  qty: numeric('qty', { precision: 12, scale: 2 }).notNull().default('1'),
  unit: text('unit').notNull().default('item'),
  unitPriceCents: integer('unit_price_cents').notNull().default(0),
  lineTotalCents: integer('line_total_cents').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
});

export type QuoteLineItem = typeof quoteLineItems.$inferSelect;
export type NewQuoteLineItem = typeof quoteLineItems.$inferInsert;
