/**
 * `data_exports` — PIPEDA data-export job records.
 *
 * DDL source of truth: `supabase/migrations/0015_data_exports.sql`.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const dataExports = pgTable(
  'data_exports',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    status: text('status').default('pending').notNull(),
    downloadUrl: text('download_url'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    check(
      'data_exports_status_check',
      sql`${table.status} IN ('pending', 'in_progress', 'ready', 'expired', 'failed')`,
    ),
  ],
);

export type DataExport = typeof dataExports.$inferSelect;
export type NewDataExport = typeof dataExports.$inferInsert;
