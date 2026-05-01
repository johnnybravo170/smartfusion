/**
 * `bank_transactions` — individual parsed lines from a bank statement.
 * Match state driven by BR-5 (auto-match) and BR-7 (review queue).
 *
 * Idempotent re-imports: `dedup_hash` is unique within a tenant. Hash is
 * computed importer-side as
 * sha256(tenant_id|posted_at|amount_cents|normalized_description).
 *
 * DDL source of truth: `supabase/migrations/0170_bank_recon_tables.sql`.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, date, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bankStatements } from './bank-statements';
import { tenants } from './tenants';

export const BANK_TX_MATCH_STATUSES = [
  'unmatched',
  'suggested',
  'confirmed',
  'rejected',
  'manual',
] as const;
export type BankTxMatchStatus = (typeof BANK_TX_MATCH_STATUSES)[number];

export const BANK_TX_MATCH_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type BankTxMatchConfidence = (typeof BANK_TX_MATCH_CONFIDENCES)[number];

export const bankTransactions = pgTable(
  'bank_transactions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => bankStatements.id, { onDelete: 'cascade' }),

    postedAt: date('posted_at').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    description: text('description').notNull(),
    rawRow: jsonb('raw_row').notNull(),
    dedupHash: text('dedup_hash').notNull(),

    matchStatus: text('match_status').notNull().default('unmatched'),
    matchConfidence: text('match_confidence'),

    // FKs declared in the migration; no Drizzle reference here because
    // some target tables (invoices, expenses, project_bills) lack
    // first-class Drizzle schemas in this repo.
    matchedInvoiceId: uuid('matched_invoice_id'),
    matchedExpenseId: uuid('matched_expense_id'),
    matchedBillId: uuid('matched_bill_id'),

    matchedBy: uuid('matched_by'),
    matchedAt: timestamp('matched_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    check(
      'bank_transactions_status_valid',
      sql`${table.matchStatus} IN ('unmatched', 'suggested', 'confirmed', 'rejected', 'manual')`,
    ),
    check(
      'bank_transactions_confidence_valid',
      sql`${table.matchConfidence} IS NULL OR ${table.matchConfidence} IN ('high', 'medium', 'low')`,
    ),
    check(
      'bank_transactions_one_match',
      sql`(CASE WHEN ${table.matchedInvoiceId} IS NOT NULL THEN 1 ELSE 0 END)
        + (CASE WHEN ${table.matchedExpenseId} IS NOT NULL THEN 1 ELSE 0 END)
        + (CASE WHEN ${table.matchedBillId} IS NOT NULL THEN 1 ELSE 0 END)
        <= 1`,
    ),
    check(
      'bank_transactions_match_actor',
      sql`(${table.matchedAt} IS NULL AND ${table.matchedBy} IS NULL)
        OR ${table.matchedAt} IS NOT NULL`,
    ),
  ],
);

export type BankTransaction = typeof bankTransactions.$inferSelect;
export type NewBankTransaction = typeof bankTransactions.$inferInsert;
