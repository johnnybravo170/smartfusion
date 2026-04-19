/**
 * `photo_pairs` — first-class before/after pairings.
 *
 * Either AI-created on job Complete (via matching heuristic) or user-created
 * via manual "Create Pair." Rendered branded output is generated lazily and
 * cached at `rendered_storage_path`.
 *
 * DDL source of truth: `supabase/migrations/0041_photos_v2.sql`.
 */

import { sql } from 'drizzle-orm';
import { numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { jobs } from './jobs';
import { photos } from './photos';
import { tenants } from './tenants';

export const photoPairs = pgTable('photo_pairs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'cascade' }),
  beforePhotoId: uuid('before_photo_id')
    .notNull()
    .references(() => photos.id, { onDelete: 'cascade' }),
  afterPhotoId: uuid('after_photo_id')
    .notNull()
    .references(() => photos.id, { onDelete: 'cascade' }),
  createdBy: text('created_by').notNull(), // 'user' | 'ai'
  aiConfidence: numeric('ai_confidence', { precision: 4, scale: 3 }),
  layout: text('layout').default('side_by_side').notNull(),
  renderedStoragePath: text('rendered_storage_path'),
  renderedAt: timestamp('rendered_at', { withTimezone: true }),
  caption: text('caption'),
  captionSource: text('caption_source').default('ai').notNull(),
  approvedByUserId: uuid('approved_by_user_id'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type PhotoPair = typeof photoPairs.$inferSelect;
export type NewPhotoPair = typeof photoPairs.$inferInsert;
