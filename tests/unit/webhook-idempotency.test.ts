/**
 * Unit tests for the webhook idempotency helper.
 *
 * Mocks createAdminClient so we don't hit Supabase. Verifies:
 *   - First claim returns alreadyProcessed=false
 *   - Duplicate (Postgres 23505) returns alreadyProcessed=true
 *   - Missing provider/event_id returns alreadyProcessed=false (don't drop)
 *   - Non-23505 errors return alreadyProcessed=false (fail open, log warn)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let insertCalls: Array<{ provider: string; event_id: string; body: unknown }> = [];
let nextError: { code?: string; message: string } | null = null;

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (_table: string) => ({
      insert: (row: { provider: string; event_id: string; body: unknown }) => {
        insertCalls.push(row);
        return Promise.resolve({ error: nextError });
      },
    }),
  }),
}));

import { claimWebhookEvent } from '@/lib/webhooks/idempotency';

describe('claimWebhookEvent', () => {
  beforeEach(() => {
    insertCalls = [];
    nextError = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns alreadyProcessed=false on first insert', async () => {
    const result = await claimWebhookEvent('stripe', 'evt_123', { hello: 'world' });
    expect(result.alreadyProcessed).toBe(false);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toEqual({
      provider: 'stripe',
      event_id: 'evt_123',
      body: { hello: 'world' },
    });
  });

  it('returns alreadyProcessed=true on Postgres 23505 duplicate-key', async () => {
    nextError = { code: '23505', message: 'duplicate key value' };
    const result = await claimWebhookEvent('stripe', 'evt_123', {});
    expect(result.alreadyProcessed).toBe(true);
  });

  it('falls open (alreadyProcessed=false) on non-duplicate errors', async () => {
    nextError = { code: '42P01', message: 'relation does not exist' };
    const result = await claimWebhookEvent('stripe', 'evt_123', {});
    // Don't drop the event — better to process twice than lose one.
    expect(result.alreadyProcessed).toBe(false);
  });

  it('skips DB write when provider or event_id is empty', async () => {
    const r1 = await claimWebhookEvent('', 'evt_x', {});
    const r2 = await claimWebhookEvent('stripe', '', {});
    expect(r1.alreadyProcessed).toBe(false);
    expect(r2.alreadyProcessed).toBe(false);
    expect(insertCalls).toHaveLength(0);
  });

  it('stores null body when caller passes null/undefined', async () => {
    await claimWebhookEvent('stripe', 'evt_null', null);
    expect(insertCalls[0].body).toBeNull();
  });
});
