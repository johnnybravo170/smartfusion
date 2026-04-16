/**
 * `photos` — job-attached photos.
 *
 * DDL source of truth: `supabase/migrations/0010_photos.sql`.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { jobs } from './jobs';
import { tenants } from './tenants';

export const photos = pgTable(
  'photos',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'cascade' }),
    storagePath: text('storage_path').notNull(),
    tag: text('tag').default('other').notNull(),
    caption: text('caption'),
    takenAt: timestamp('taken_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    check('photos_tag_check', sql`${table.tag} IN ('before', 'after', 'progress', 'other')`),
  ],
);

export type Photo = typeof photos.$inferSelect;
export type NewPhoto = typeof photos.$inferInsert;
