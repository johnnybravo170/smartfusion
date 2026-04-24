/**
 * `notifications` — stand-in for push infrastructure. One row per thing
 * we'd eventually deliver to a user over SMS / push / email. See
 * `supabase/migrations/0119_task_notifications.sql` for the canonical DDL.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { jobs } from './jobs';
import { tasks } from './tasks';
import { tenants } from './tenants';

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    recipientUserId: uuid('recipient_user_id'),
    kind: text('kind').notNull(),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    check(
      'notifications_kind_check',
      sql`${table.kind} IN ('task_assigned','task_done','task_blocked','task_help','task_verified','task_rejected')`,
    ),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
