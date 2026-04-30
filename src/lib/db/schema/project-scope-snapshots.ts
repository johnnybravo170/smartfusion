/**
 * `project_scope_snapshots` — immutable per-version snapshots of a
 * project's scope, captured at each customer-signed event.
 *
 * Baseline for the unsent-changes diff per decision 6790ef2b.
 *
 * DDL source of truth: `supabase/migrations/0164_project_scope_snapshots.sql`.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const projectScopeSnapshots = pgTable(
  'project_scope_snapshots',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // FK to public.projects — no Drizzle schema for projects yet, declared
    // bare. DB-level FK enforced by the migration.
    projectId: uuid('project_id').notNull(),

    versionNumber: integer('version_number').notNull(),
    label: text('label'),
    changeOrderId: uuid('change_order_id'),

    costLines: jsonb('cost_lines').default(sql`'[]'::jsonb`).notNull(),
    budgetCategories: jsonb('budget_categories').default(sql`'[]'::jsonb`).notNull(),
    totalCents: bigint('total_cents', { mode: 'number' }).default(0).notNull(),

    signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
    signedByName: text('signed_by_name'),

    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [unique('pss_unique_version').on(table.projectId, table.versionNumber)],
);

export type ProjectScopeSnapshot = typeof projectScopeSnapshots.$inferSelect;
export type NewProjectScopeSnapshot = typeof projectScopeSnapshots.$inferInsert;
