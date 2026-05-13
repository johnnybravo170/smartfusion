/**
 * Unit tests for the audit log helper.
 *
 * Mocks createAdminClient + next/headers so we can assert what gets
 * inserted into audit_log under happy path, missing-headers path, and DB
 * error path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let insertedRows: Array<Record<string, unknown>> = [];
let nextError: { code?: string; message: string } | null = null;
let headersToReturn: Record<string, string> = {};
let headersThrows = false;

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (_table: string) => ({
      insert: (row: Record<string, unknown>) => {
        insertedRows.push(row);
        return Promise.resolve({ error: nextError });
      },
    }),
  }),
}));

vi.mock('next/headers', () => ({
  headers: () => {
    if (headersThrows) throw new Error('headers() called outside request');
    return Promise.resolve({
      get: (name: string) => headersToReturn[name.toLowerCase()] ?? null,
    });
  },
}));

import { audit } from '@/lib/audit';

describe('audit()', () => {
  beforeEach(() => {
    insertedRows = [];
    nextError = null;
    headersToReturn = {};
    headersThrows = false;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('inserts a row with the canonical shape', async () => {
    await audit({
      tenantId: 't1',
      userId: 'u1',
      action: 'invoice.voided',
      resourceType: 'invoice',
      resourceId: 'inv-123',
      metadata: { prior_status: 'sent' },
    });

    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0];
    expect(row.tenant_id).toBe('t1');
    expect(row.user_id).toBe('u1');
    expect(row.action).toBe('invoice.voided');
    expect(row.resource_type).toBe('invoice');
    expect(row.resource_id).toBe('inv-123');
    expect(row.metadata_json).toMatchObject({ prior_status: 'sent' });
  });

  it('enriches metadata with IP + user_agent when headers() is available', async () => {
    headersToReturn = {
      'x-forwarded-for': '1.2.3.4, 5.6.7.8',
      'user-agent': 'Mozilla/5.0',
    };
    await audit({
      tenantId: 't1',
      userId: 'u1',
      action: 'mfa.disabled',
      resourceType: 'user',
      resourceId: 'u1',
    });

    const meta = insertedRows[0].metadata_json as Record<string, unknown>;
    const ctx = meta._ctx as Record<string, unknown>;
    expect(ctx.ip).toBe('1.2.3.4');
    expect(ctx.user_agent).toBe('Mozilla/5.0');
  });

  it('falls back to x-real-ip when x-forwarded-for is missing', async () => {
    headersToReturn = { 'x-real-ip': '9.9.9.9' };
    await audit({
      tenantId: 't1',
      userId: null,
      action: 'estimate.approved',
      resourceType: 'project',
      resourceId: 'p1',
    });
    const meta = insertedRows[0].metadata_json as Record<string, unknown>;
    const ctx = meta._ctx as Record<string, unknown>;
    expect(ctx.ip).toBe('9.9.9.9');
  });

  it('accepts null userId for system/webhook events', async () => {
    await audit({
      tenantId: 't1',
      userId: null,
      action: 'estimate.approved',
      resourceType: 'project',
      resourceId: 'p1',
    });
    expect(insertedRows[0].user_id).toBeNull();
  });

  it('falls open silently when headers() throws (cron/queue context)', async () => {
    headersThrows = true;
    await audit({
      tenantId: 't1',
      userId: 'u1',
      action: 'invoice.marked_paid',
      resourceType: 'invoice',
      resourceId: 'inv-1',
    });
    expect(insertedRows).toHaveLength(1);
    // No _ctx since headers were unavailable
    expect(insertedRows[0].metadata_json).toBeNull();
  });

  it('logs but does not throw on DB error — business action must not break', async () => {
    nextError = { code: '42P01', message: 'relation does not exist' };
    await expect(
      audit({
        tenantId: 't1',
        userId: 'u1',
        action: 'customer.deleted',
        resourceType: 'customer',
        resourceId: 'c1',
      }),
    ).resolves.toBeUndefined();
  });
});
