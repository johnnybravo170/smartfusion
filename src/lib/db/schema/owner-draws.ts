/**
 * `owner_draws` — owner pay ledger.
 *
 * Running tally of salary/dividend/reimbursement/other payments the owner
 * takes from the business. Feeds the "Owner Pay YTD" card on
 * /business-health. Not a payroll engine; no tax categorization.
 *
 * DDL source of truth: `supabase/migrations/0168_owner_draws.sql`.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, date, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const ownerDraws = pgTable(
  'owner_draws',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    paidAt: date('paid_at').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    drawType: text('draw_type').notNull(),
    note: text('note'),

    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    check('owner_draws_amount_positive', sql`${table.amountCents} > 0`),
    check(
      'owner_draws_type_valid',
      sql`${table.drawType} IN ('salary', 'dividend', 'reimbursement', 'other')`,
    ),
  ],
);

export type OwnerDraw = typeof ownerDraws.$inferSelect;
export type NewOwnerDraw = typeof ownerDraws.$inferInsert;

export const OWNER_DRAW_TYPES = ['salary', 'dividend', 'reimbursement', 'other'] as const;
export type OwnerDrawType = (typeof OWNER_DRAW_TYPES)[number];
