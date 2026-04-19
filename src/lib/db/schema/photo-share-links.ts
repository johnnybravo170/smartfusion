/**
 * `photo_share_links` — scoped no-login public URLs for clients.
 *
 * Polymorphic: scope_type determines what scope_id references.
 *
 * DDL source of truth: `supabase/migrations/0041_photos_v2.sql`.
 */

import { sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const photoShareLinks = pgTable('photo_share_links', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  scopeType: text('scope_type').notNull(), // job_full | job_live | album | pair_set | single
  scopeId: uuid('scope_id').notNull(),
  label: text('label'),
  recipientEmail: text('recipient_email'),
  recipientPhone: text('recipient_phone'),
  recipientName: text('recipient_name'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  viewCount: integer('view_count').default(0).notNull(),
  lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
  lastViewedIp: text('last_viewed_ip'),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
});

export type PhotoShareLink = typeof photoShareLinks.$inferSelect;
export type NewPhotoShareLink = typeof photoShareLinks.$inferInsert;
