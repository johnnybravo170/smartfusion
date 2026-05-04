/**
 * `ai_calls` — AI gateway per-attempt telemetry.
 *
 * Platform infrastructure, NOT tenant data. RLS denies all authenticated
 * access; reads + writes go through the admin client. tenant_id is
 * nullable for system / cron jobs.
 *
 * DDL source of truth: `supabase/migrations/0172_ai_calls.sql`.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const aiCalls = pgTable(
  'ai_calls',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),

    task: text('task').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    apiKeyLabel: text('api_key_label'),

    status: text('status').notNull(),
    attemptIndex: integer('attempt_index').notNull().default(0),

    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costMicros: bigint('cost_micros', { mode: 'number' }),
    latencyMs: integer('latency_ms').notNull(),

    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    check(
      'ai_calls_status_valid',
      sql`${table.status} IN ('success', 'quota', 'overload', 'rate_limit', 'invalid_input', 'auth', 'timeout', 'unknown')`,
    ),
    check(
      'ai_calls_provider_valid',
      sql`${table.provider} IN ('openai', 'gemini', 'anthropic', 'noop')`,
    ),
  ],
);

export type AiCallRow = typeof aiCalls.$inferSelect;
export type NewAiCall = typeof aiCalls.$inferInsert;
