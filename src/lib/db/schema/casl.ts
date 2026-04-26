/**
 * CASL compliance plumbing.
 *
 * `email_send_log`  — every email sent via the `sendEmail` wrapper.
 * `consent_events`  — proof-of-opt-in for express_consent sends.
 *
 * AR sends use `ar_send_log` (see ./ar/send-log.ts); SMS sends use
 * `twilio_messages` (managed by the Twilio client). Both have casl_category
 * + casl_evidence columns added in migration 0138.
 *
 * DDL source of truth: `supabase/migrations/0138_casl_compliance.sql`.
 * Rules: see `CASL.md` at the repo root.
 */

import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

/**
 * Every value sendEmail/sendSms accepts. Keep in sync with the CHECK
 * constraints in 0138_casl_compliance.sql.
 *
 * `unclassified` is a temporary value used while phase B classifies every
 * existing callsite. New code MUST pick a real category.
 */
export const CASL_CATEGORIES = [
  'transactional',
  'response_to_request',
  'implied_consent_inquiry',
  'implied_consent_ebr',
  'express_consent',
  'unclassified',
] as const;

export type CaslCategory = (typeof CASL_CATEGORIES)[number];

/**
 * Categories that are CEMs under CASL — they require sender ID, physical
 * address, and a working unsubscribe link in the rendered message.
 */
export const CEM_CATEGORIES: ReadonlySet<CaslCategory> = new Set([
  'implied_consent_inquiry',
  'implied_consent_ebr',
  'express_consent',
]);

export function isCemCategory(c: CaslCategory): boolean {
  return CEM_CATEGORIES.has(c);
}

export const emailSendLog = pgTable('email_send_log', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  direction: text('direction').notNull().default('outbound'),
  toAddress: text('to_address').notNull(),
  fromAddress: text('from_address'),
  replyTo: text('reply_to'),
  subject: text('subject'),
  providerId: text('provider_id'),
  status: text('status').notNull().default('queued'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  caslCategory: text('casl_category').notNull().$type<CaslCategory>(),
  caslEvidence: jsonb('casl_evidence'),
  relatedType: text('related_type'),
  relatedId: text('related_id'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export type EmailSendLog = typeof emailSendLog.$inferSelect;
export type NewEmailSendLog = typeof emailSendLog.$inferInsert;

export const consentEvents = pgTable('consent_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id'),
  contactKind: text('contact_kind'),
  email: text('email'),
  phone: text('phone'),
  consentType: text('consent_type').notNull(),
  source: text('source').notNull(),
  wordingShown: text('wording_shown'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  evidence: jsonb('evidence'),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export type ConsentEvent = typeof consentEvents.$inferSelect;
export type NewConsentEvent = typeof consentEvents.$inferInsert;
