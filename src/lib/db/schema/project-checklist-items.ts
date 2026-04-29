/**
 * `project_checklist_items` — field-level team checklist per project.
 *
 * Lightweight parallel to the heavier `tasks` table. The crew uses this for
 * on-site notes ("need 2 pancake boxes for the electrical panel"); tasks
 * stays for PM-level workflow with statuses, assignees, and verification.
 *
 * Anyone in the tenant can add / check / uncheck / delete; collaborative by
 * design. Tenant isolation enforced by RLS.
 *
 * DDL source of truth: `supabase/migrations/0162_project_checklist_items.sql`.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const projectChecklistItems = pgTable(
  'project_checklist_items',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // FK to public.projects — no Drizzle schema for projects yet, so we
    // declare the column without a Drizzle reference. The DB-level FK is
    // enforced by the migration.
    projectId: uuid('project_id').notNull(),

    title: text('title').notNull(),
    category: text('category'),

    photoStoragePath: text('photo_storage_path'),
    photoMime: text('photo_mime'),

    createdBy: uuid('created_by'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by'),

    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    check(
      'pci_completed_consistency',
      sql`(${table.completedAt} IS NULL AND ${table.completedBy} IS NULL)
        OR (${table.completedAt} IS NOT NULL)`,
    ),
  ],
);

export type ProjectChecklistItem = typeof projectChecklistItems.$inferSelect;
export type NewProjectChecklistItem = typeof projectChecklistItems.$inferInsert;
