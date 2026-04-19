/**
 * `photos` — job/customer-attached photos with AI layer.
 *
 * DDL source of truth: `supabase/migrations/0010_photos.sql` (initial)
 * + `supabase/migrations/0041_photos_v2.sql` (v2 AI + metadata columns).
 */

import { sql } from 'drizzle-orm';
import { integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { jobs } from './jobs';
import { tenants } from './tenants';

export const photos = pgTable('photos', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),

  storagePath: text('storage_path').notNull(),

  // tag vocab: before | after | progress | damage | materials | equipment | serial | other
  tag: text('tag').default('other').notNull(),
  caption: text('caption'),

  // Capture metadata
  takenAt: timestamp('taken_at', { withTimezone: true }),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).default(sql`now()`).notNull(),
  uploaderUserId: uuid('uploader_user_id'),
  source: text('source').default('web').notNull(), // web | mobile_pwa | native | client | import
  device: jsonb('device').default(sql`'{}'::jsonb`).notNull(),

  // GPS
  gpsLat: numeric('gps_lat', { precision: 10, scale: 7 }),
  gpsLng: numeric('gps_lng', { precision: 10, scale: 7 }),
  gpsAccuracyM: numeric('gps_accuracy_m', { precision: 8, scale: 2 }),

  // Image info
  width: integer('width'),
  height: integer('height'),
  bytes: integer('bytes'),
  mime: text('mime'),
  dominantColor: text('dominant_color'),

  // AI layer
  aiTag: text('ai_tag'),
  aiTagConfidence: numeric('ai_tag_confidence', { precision: 4, scale: 3 }),
  aiCaption: text('ai_caption'),
  aiCaptionConfidence: numeric('ai_caption_confidence', { precision: 4, scale: 3 }),
  captionSource: text('caption_source').default('user').notNull(), // user | ai | hybrid
  qualityFlags: jsonb('quality_flags').default(sql`'{}'::jsonb`).notNull(),

  // Internal EXIF — never serve in client-facing URLs
  originalExif: jsonb('original_exif').default(sql`'{}'::jsonb`).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type Photo = typeof photos.$inferSelect;
export type NewPhoto = typeof photos.$inferInsert;
