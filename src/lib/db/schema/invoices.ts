/**
 * `invoices` — Stripe Connect Standard invoicing.
 *
 * DDL source of truth: `supabase/migrations/0011_invoices.sql`
 * (plus `0018_soft_delete.sql` for `deleted_at`).
 */

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { jobs } from './jobs';
import { tenants } from './tenants';

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    status: text('status').default('draft').notNull(),
    amountCents: integer('amount_cents').default(0).notNull(),
    taxCents: integer('tax_cents').default(0).notNull(),
    stripeInvoiceId: text('stripe_invoice_id'),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    pdfUrl: text('pdf_url'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    check('invoices_status_check', sql`${table.status} IN ('draft', 'sent', 'paid', 'void')`),
  ],
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
