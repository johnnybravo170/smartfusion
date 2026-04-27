/**
 * `customers` — universal contact directory.
 *
 * Despite the legacy table name, this table holds every kind of contact
 * the tenant tracks (customers, vendors, sub-trades, agents, inspectors,
 * referral partners, other). The `kind` column decides which detail-page
 * sections apply. `type` is a customer-only subtype (residential vs
 * commercial) and is null for non-customer kinds.
 *
 * DDL source of truth: `supabase/migrations/0005_customers.sql`,
 * `0018_soft_delete.sql`, `0111_contacts_kind_and_notes.sql`.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Contact kind — governs which detail-page sections apply. */
    kind: text('kind').notNull().default('customer'),
    /** Customer subtype (residential|commercial). Null for non-customer kinds. */
    type: text('type'),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    addressLine1: text('address_line1'),
    city: text('city'),
    province: text('province'),
    postalCode: text('postal_code'),
    lat: numeric('lat', { precision: 10, scale: 7 }),
    lng: numeric('lng', { precision: 10, scale: 7 }),
    /**
     * @deprecated Writes go to `contact_notes` (see `./contact-notes.ts`).
     * Column retained for read compatibility until a follow-up migration drops it.
     */
    notes: text('notes'),
    /**
     * CASL kill switch. When true, no automated outbound messages of any
     * kind are sent to this customer (AR sequences, broadcasts, follow-ups).
     * Manual sends from a contractor still go through. Auto-set when the
     * customer unsubscribes, replies STOP, or files a Resend complaint.
     */
    doNotAutoMessage: boolean('do_not_auto_message').notNull().default(false),
    doNotAutoMessageAt: timestamp('do_not_auto_message_at', { withTimezone: true }),
    doNotAutoMessageSource: text('do_not_auto_message_source'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    check(
      'customers_kind_check',
      sql`${table.kind} IN ('customer', 'vendor', 'sub', 'agent', 'inspector', 'referral', 'other')`,
    ),
    check(
      'customers_type_check',
      sql`${table.type} IS NULL OR ${table.type} IN ('residential', 'commercial')`,
    ),
    check(
      'customers_type_requires_customer_kind',
      sql`${table.kind} = 'customer' OR ${table.type} IS NULL`,
    ),
    check(
      'customers_do_not_auto_message_source_check',
      sql`${table.doNotAutoMessageSource} IS NULL OR ${table.doNotAutoMessageSource} IN ('unsubscribe_link', 'sms_stop', 'email_complaint', 'manual_owner', 'manual_admin')`,
    ),
  ],
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
