/**
 * `estimate_snippets` — reusable boilerplate paragraphs per tenant. The
 * project estimate tab renders chips for each snippet; clicking a chip
 * inserts its body into `projects.terms_text`. See migration 0114.
 */

import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const estimateSnippets = pgTable('estimate_snippets', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  body: text('body').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
});

export type EstimateSnippet = typeof estimateSnippets.$inferSelect;
export type NewEstimateSnippet = typeof estimateSnippets.$inferInsert;
