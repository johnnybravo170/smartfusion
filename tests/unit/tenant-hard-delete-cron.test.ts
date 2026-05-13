/**
 * Unit tests for the tenant hard-delete cron route.
 *
 * Mocks the admin client + reportError so we can assert auth, eligibility
 * filtering, and the per-tenant log-then-delete sequence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const state = {
  deletionRequests: [] as Row[],
  tenants: [] as Row[],
  hardDeleteLog: [] as Row[],
  insertError: null as { code?: string; message: string } | null,
  deleteError: null as { code?: string; message: string } | null,
};

vi.mock('@/lib/error-reporting', () => ({
  reportError: () => {},
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => buildBuilder(table),
  }),
}));

function buildBuilder(table: string) {
  type Filters = {
    is?: { col: string; val: unknown };
    lt?: { col: string; val: string };
    in?: { col: string; vals: string[] };
    eq?: { col: string; val: string };
  };
  const filters: Filters = {};

  const select = (_cols: string) => {
    const finalize = () => {
      let rows = source(table) as Row[];
      if (filters.is) {
        const { col, val } = filters.is;
        rows = rows.filter((r) => (r[col] ?? null) === val);
      }
      if (filters.lt) {
        const { col, val } = filters.lt;
        rows = rows.filter((r) => String(r[col]) < val);
      }
      if (filters.in) {
        const { col, vals } = filters.in;
        rows = rows.filter((r) => vals.includes(r[col] as string));
      }
      return Promise.resolve({ data: rows, error: null });
    };
    const builder = {
      is(col: string, val: unknown) {
        filters.is = { col, val };
        // After .is, more filters can chain — return self that's also thenable.
        return Object.assign(builder, {
          // biome-ignore lint/suspicious/noThenProperty: thenable to mimic Supabase builder
          then: (cb: (r: { data: Row[]; error: null }) => void) => finalize().then(cb),
        });
      },
      lt(col: string, val: string) {
        filters.lt = { col, val };
        return Object.assign(builder, {
          // biome-ignore lint/suspicious/noThenProperty: thenable to mimic Supabase builder
          then: (cb: (r: { data: Row[]; error: null }) => void) => finalize().then(cb),
        });
      },
      in(col: string, vals: string[]) {
        filters.in = { col, vals };
        return Object.assign(builder, {
          // biome-ignore lint/suspicious/noThenProperty: thenable to mimic Supabase builder
          then: (cb: (r: { data: Row[]; error: null }) => void) => finalize().then(cb),
        });
      },
    };
    return builder;
  };

  return {
    select,
    insert: (row: Row) => {
      if (state.insertError) return Promise.resolve({ error: state.insertError });
      if (table === 'tenant_hard_delete_log') state.hardDeleteLog.push(row);
      return Promise.resolve({ error: null });
    },
    delete: () => ({
      eq: (_col: string, val: string) => {
        if (state.deleteError) return Promise.resolve({ error: state.deleteError });
        if (table === 'tenants') {
          state.tenants = state.tenants.filter((t) => t.id !== val);
        }
        return Promise.resolve({ error: null });
      },
    }),
  };
}

function source(table: string): Row[] {
  if (table === 'tenant_deletion_requests') return state.deletionRequests;
  if (table === 'tenants') return state.tenants;
  if (table === 'tenant_hard_delete_log') return state.hardDeleteLog;
  return [];
}

import { GET } from '@/app/api/cron/tenant-hard-delete/route';

describe('tenant-hard-delete cron', () => {
  beforeEach(() => {
    state.deletionRequests = [];
    state.tenants = [];
    state.hardDeleteLog = [];
    state.insertError = null;
    state.deleteError = null;
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeRequest(authHeader?: string): Request {
    return new Request('http://localhost/api/cron/tenant-hard-delete', {
      headers: authHeader ? { authorization: authHeader } : {},
    });
  }

  it('rejects unauthorized requests', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong bearer token', async () => {
    const res = await GET(makeRequest('Bearer wrong'));
    expect(res.status).toBe(401);
  });

  it('returns ok with zero counts when nothing is eligible', async () => {
    const res = await GET(makeRequest('Bearer test-secret'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; eligible: number; purged: number };
    expect(json.ok).toBe(true);
    expect(json.purged).toBe(0);
  });

  it('purges eligible tenants and writes the log', async () => {
    const past = '2026-01-01T00:00:00Z';
    state.deletionRequests = [
      {
        id: 'req-1',
        tenant_id: 'tenant-1',
        requested_by_user_id: 'user-1',
        requested_at: '2025-12-01T00:00:00Z',
        effective_at: past,
        aborted_at: null,
      },
    ];
    state.tenants = [{ id: 'tenant-1', name: 'Old Co', deleted_at: '2025-12-01T00:00:00Z' }];

    const res = await GET(makeRequest('Bearer test-secret'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { purged: number; skipped: number };
    expect(json.purged).toBe(1);
    expect(json.skipped).toBe(0);
    expect(state.hardDeleteLog).toHaveLength(1);
    expect(state.hardDeleteLog[0]).toMatchObject({
      tenant_id: 'tenant-1',
      tenant_name: 'Old Co',
      deletion_request_id: 'req-1',
    });
    expect(state.tenants).toHaveLength(0); // tenant purged
  });

  it('skips tenants whose deleted_at was cleared outside the abort flow (defense in depth)', async () => {
    const past = '2026-01-01T00:00:00Z';
    state.deletionRequests = [
      {
        id: 'req-1',
        tenant_id: 'tenant-1',
        requested_by_user_id: 'user-1',
        requested_at: '2025-12-01T00:00:00Z',
        effective_at: past,
        aborted_at: null,
      },
    ];
    // Tenant exists but deleted_at is null — someone manually restored it
    // outside the abort flow. We must NOT purge.
    state.tenants = [{ id: 'tenant-1', name: 'Restored Co', deleted_at: null }];

    const res = await GET(makeRequest('Bearer test-secret'));
    const json = (await res.json()) as { purged: number; skipped: number };
    expect(json.purged).toBe(0);
    expect(json.skipped).toBe(1);
    expect(state.tenants).toHaveLength(1); // still there
  });

  it('does not purge requests still inside the 30-day window', async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    state.deletionRequests = [
      {
        id: 'req-1',
        tenant_id: 'tenant-1',
        requested_by_user_id: 'user-1',
        requested_at: '2026-05-01T00:00:00Z',
        effective_at: future,
        aborted_at: null,
      },
    ];
    state.tenants = [{ id: 'tenant-1', name: 'Pending', deleted_at: '2026-05-01T00:00:00Z' }];

    const res = await GET(makeRequest('Bearer test-secret'));
    const json = (await res.json()) as { eligible: number; purged: number };
    expect(json.eligible).toBe(0);
    expect(json.purged).toBe(0);
    expect(state.tenants).toHaveLength(1);
  });
});
