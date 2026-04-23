/**
 * `tenant_members` — links Supabase auth users to tenants with a role.
 *
 * `user_id` is a `uuid` that points at `auth.users.id`. We do NOT declare a
 * cross-schema foreign key: Supabase's `auth` schema is managed by them, and
 * FK-ing into it introduces surprise coupling on migration drills. The invariant
 * is enforced at the app layer and via RLS.
 *
 * This table is the source of truth for the `current_tenant_id()` function
 * (§13.1 of the plan). Removing a row here revokes access on the next query,
 * not on JWT refresh.
 *
 * DDL source of truth: `supabase/migrations/0002_tenant_members.sql`.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const tenantMembers = pgTable(
  'tenant_members',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    title: text('title'),
    mfaGraceStartedAt: timestamp('mfa_grace_started_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    unique('tenant_members_tenant_user_unique').on(table.tenantId, table.userId),
    check('tenant_members_role_check', sql`${table.role} IN ('owner', 'admin', 'member')`),
  ],
);

export type TenantMember = typeof tenantMembers.$inferSelect;
export type NewTenantMember = typeof tenantMembers.$inferInsert;
