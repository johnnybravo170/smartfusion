/**
 * `worklog_entries` — timestamped activity feed.
 *
 * DDL source of truth: `supabase/migrations/0013_worklog_entries.sql`.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const worklogEntries = pgTable(
  'worklog_entries',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id'),
    entryType: text('entry_type').default('note').notNull(),
    title: text('title'),
    body: text('body'),
    relatedType: text('related_type'),
    relatedId: uuid('related_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    check(
      'worklog_entries_entry_type_check',
      sql`${table.entryType} IN ('note', 'system', 'milestone')`,
    ),
    check(
      'worklog_entries_related_type_check',
      sql`${table.relatedType} IS NULL OR ${table.relatedType} IN ('customer', 'quote', 'job', 'invoice')`,
    ),
  ],
);

export type WorklogEntry = typeof worklogEntries.$inferSelect;
export type NewWorklogEntry = typeof worklogEntries.$inferInsert;
