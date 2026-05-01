/**
 * `bank_statements` — one row per uploaded bank/credit-card statement CSV.
 * Parent of `bank_transactions`. Powers the BR (bank reconciliation) epic.
 *
 * DDL source of truth: `supabase/migrations/0170_bank_recon_tables.sql`.
 */

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const BANK_PRESETS = ['rbc', 'td', 'bmo', 'scotia', 'cibc', 'amex', 'generic'] as const;
export type BankPreset = (typeof BANK_PRESETS)[number];

export const bankStatements = pgTable(
  'bank_statements',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    sourceLabel: text('source_label').notNull(),
    bankPreset: text('bank_preset'),
    filename: text('filename'),
    rowCount: integer('row_count').notNull().default(0),
    matchedCount: integer('matched_count').notNull().default(0),

    uploadedBy: uuid('uploaded_by'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    check(
      'bank_statements_preset_valid',
      sql`${table.bankPreset} IS NULL OR ${table.bankPreset} IN ('rbc', 'td', 'bmo', 'scotia', 'cibc', 'amex', 'generic')`,
    ),
  ],
);

export type BankStatement = typeof bankStatements.$inferSelect;
export type NewBankStatement = typeof bankStatements.$inferInsert;
