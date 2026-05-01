/**
 * `project_sub_quotes` + `project_sub_quote_allocations` — the "committed"
 * leg of cost control. Quotes received from subs/suppliers, allocated
 * across one or more project_budget_categories.
 *
 * See SUB_QUOTES_PLAN.md for design rationale. Sum of allocations must
 * equal total_cents (enforced at the server-action layer before a quote
 * can be `accepted`).
 *
 * DDL source of truth: `supabase/migrations/0094_project_sub_quotes.sql`.
 * FKs on project_id / budget_category_id / tenant_id exist in SQL but are not
 * declared in Drizzle because those parent tables don't have Drizzle
 * schemas (matches the existing convention for renovation-vertical
 * tables).
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const projectSubQuotes = pgTable(
  'project_sub_quotes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').notNull(),
    projectId: uuid('project_id').notNull(),
    vendorName: text('vendor_name').notNull(),
    vendorEmail: text('vendor_email'),
    vendorPhone: text('vendor_phone'),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
    scopeDescription: text('scope_description'),
    notes: text('notes'),
    status: text('status').notNull().default('pending_review'),
    supersededById: uuid('superseded_by_id'),
    quoteDate: date('quote_date'),
    validUntil: date('valid_until'),
    receivedAt: timestamp('received_at', { withTimezone: true }).default(sql`now()`).notNull(),
    source: text('source').notNull().default('manual'),
    attachmentStoragePath: text('attachment_storage_path'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    index('idx_sub_quotes_project').on(table.projectId, table.status),
    index('idx_sub_quotes_tenant').on(table.tenantId),
    check('sub_quotes_total_nonneg', sql`${table.totalCents} >= 0`),
    check(
      'sub_quotes_status_check',
      sql`${table.status} IN ('pending_review', 'accepted', 'rejected', 'expired', 'superseded')`,
    ),
    check('sub_quotes_source_check', sql`${table.source} IN ('manual', 'upload', 'email')`),
  ],
);

export const projectSubQuoteAllocations = pgTable(
  'project_sub_quote_allocations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    subQuoteId: uuid('sub_quote_id').notNull(),
    budgetCategoryId: uuid('budget_category_id').notNull(),
    allocatedCents: bigint('allocated_cents', { mode: 'number' }).notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    index('idx_sub_quote_allocations_quote').on(table.subQuoteId),
    index('idx_sub_quote_allocations_bucket').on(table.budgetCategoryId),
    unique('sub_quote_allocations_quote_bucket_unique').on(
      table.subQuoteId,
      table.budgetCategoryId,
    ),
    check('sub_quote_allocations_amount_nonneg', sql`${table.allocatedCents} >= 0`),
  ],
);

export type ProjectSubQuote = typeof projectSubQuotes.$inferSelect;
export type NewProjectSubQuote = typeof projectSubQuotes.$inferInsert;
export type ProjectSubQuoteAllocation = typeof projectSubQuoteAllocations.$inferSelect;
export type NewProjectSubQuoteAllocation = typeof projectSubQuoteAllocations.$inferInsert;
