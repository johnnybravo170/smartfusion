/**
 * `todos` — per-user tasks.
 *
 * DDL source of truth: `supabase/migrations/0012_todos.sql`.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, date, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const todos = pgTable(
  'todos',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    title: text('title').notNull(),
    done: boolean('done').default(false).notNull(),
    dueDate: date('due_date'),
    relatedType: text('related_type'),
    relatedId: uuid('related_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    check(
      'todos_related_type_check',
      sql`${table.relatedType} IS NULL OR ${table.relatedType} IN ('customer', 'quote', 'job', 'invoice')`,
    ),
  ],
);

export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;
