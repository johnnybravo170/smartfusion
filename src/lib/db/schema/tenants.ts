/**
 * `tenants` — one row per business on the platform.
 *
 * Every other tenant-owned table references this. RLS enforces isolation via
 * the `current_tenant_id()` SECURITY DEFINER function (see
 * `supabase/migrations/0003_current_tenant_fn.sql`).
 *
 * This file is the ORM view of the table. The actual DDL lives in
 * `supabase/migrations/0001_tenants.sql` — keep the two in sync by hand.
 */

import { sql } from 'drizzle-orm';
import { jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  slug: text('slug').unique(),
  stripeAccountId: text('stripe_account_id'),
  stripeOnboardedAt: timestamp('stripe_onboarded_at', { withTimezone: true }),
  stripeTosAcceptedAt: timestamp('stripe_tos_accepted_at', { withTimezone: true }),
  stripeTosVersion: text('stripe_tos_version'),
  currency: text('currency').default('CAD').notNull(),
  timezone: text('timezone').default('America/Vancouver').notNull(),
  province: text('province'),
  gstRate: numeric('gst_rate', { precision: 5, scale: 4 }).default('0.05').notNull(),
  pstRate: numeric('pst_rate', { precision: 5, scale: 4 }).default('0').notNull(),
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  postalCode: text('postal_code'),
  phone: text('phone'),
  contactEmail: text('contact_email'),
  websiteUrl: text('website_url'),
  reviewUrl: text('review_url'),
  logoStoragePath: text('logo_storage_path'),
  socials: jsonb('socials').default(sql`'{}'::jsonb`).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
