/**
 * `tenant_prefs` — namespaced per-tenant preferences for correction learning.
 *
 * General-purpose: photos is the first consumer (tag vocab, confidence
 * thresholds, preferred pair layout), email_voice / social / invoicing
 * will plug in later.
 *
 * Pattern: `(tenant_id, namespace)` composite PK, `data` JSONB for the
 * namespace's content. Read on every AI inference, updated when the user
 * corrects Henry.
 *
 * DDL source of truth: `supabase/migrations/0041_photos_v2.sql`.
 */

import { sql } from 'drizzle-orm';
import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const tenantPrefs = pgTable(
  'tenant_prefs',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    namespace: text('namespace').notNull(),
    data: jsonb('data').default(sql`'{}'::jsonb`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.namespace] })],
);

export type TenantPrefs = typeof tenantPrefs.$inferSelect;
export type NewTenantPrefs = typeof tenantPrefs.$inferInsert;
