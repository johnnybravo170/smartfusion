/**
 * `tasks` — unified task store for personal / project / lead scopes.
 *
 * DDL source of truth: `supabase/migrations/0118_tasks.sql`.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, date, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { jobs } from './jobs';
import { tenants } from './tenants';

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    scope: text('scope').notNull(),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id'),
    phase: text('phase'),
    status: text('status').default('ready').notNull(),
    blockerReason: text('blocker_reason'),
    assigneeId: uuid('assignee_id'),
    createdBy: text('created_by').notNull(),
    visibility: text('visibility').default('internal').notNull(),
    clientSummary: text('client_summary'),
    requiredPhotos: boolean('required_photos').default(false).notNull(),
    dueDate: date('due_date'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    // FK to change_orders is enforced at the DB level (see migration 0118);
    // change_orders has no Drizzle schema yet so we declare it as a plain UUID here.
    linkedChangeOrderId: uuid('linked_change_order_id'),
    linkedEstimateLineId: uuid('linked_estimate_line_id'),
    linkedMaterialOrderId: uuid('linked_material_order_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    check('tasks_scope_check', sql`${table.scope} IN ('personal', 'project', 'lead')`),
    check(
      'tasks_status_check',
      sql`${table.status} IN ('ready','in_progress','waiting_client','waiting_material','waiting_sub','blocked','done','verified')`,
    ),
    check('tasks_visibility_check', sql`${table.visibility} IN ('internal','crew','client')`),
    check(
      'tasks_scope_fk_check',
      sql`(${table.scope} = 'personal' AND ${table.jobId} IS NULL AND ${table.leadId} IS NULL)
        OR (${table.scope} = 'project' AND ${table.jobId} IS NOT NULL)
        OR (${table.scope} = 'lead' AND ${table.leadId} IS NOT NULL)`,
    ),
  ],
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
