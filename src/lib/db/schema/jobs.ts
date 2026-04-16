/**
 * `jobs` — scheduled/in-progress/complete execution of (usually) a quote.
 *
 * DDL source of truth: `supabase/migrations/0009_jobs.sql`
 * (plus `0018_soft_delete.sql` for `deleted_at`).
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { quotes } from './quotes';
import { tenants } from './tenants';

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    quoteId: uuid('quote_id').references(() => quotes.id, { onDelete: 'set null' }),
    status: text('status').default('booked').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    notes: text('notes'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    check(
      'jobs_status_check',
      sql`${table.status} IN ('booked', 'in_progress', 'complete', 'cancelled')`,
    ),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
