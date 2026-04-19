/**
 * `photo_albums` + `photo_album_members` — custom user-created albums.
 *
 * System albums (Before/After/Progress/Damage/Materials/Customer-Sent/
 * Closeout) are virtual filter views, not stored rows.
 *
 * DDL source of truth: `supabase/migrations/0041_photos_v2.sql`.
 */

import { sql } from 'drizzle-orm';
import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { jobs } from './jobs';
import { photos } from './photos';
import { tenants } from './tenants';

export const photoAlbums = pgTable('photo_albums', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
});

export const photoAlbumMembers = pgTable(
  'photo_album_members',
  {
    albumId: uuid('album_id')
      .notNull()
      .references(() => photoAlbums.id, { onDelete: 'cascade' }),
    photoId: uuid('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [primaryKey({ columns: [table.albumId, table.photoId] })],
);

export type PhotoAlbum = typeof photoAlbums.$inferSelect;
export type NewPhotoAlbum = typeof photoAlbums.$inferInsert;
export type PhotoAlbumMember = typeof photoAlbumMembers.$inferSelect;
