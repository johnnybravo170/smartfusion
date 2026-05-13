/**
 * Unit tests for tenant deletion confirmation behavior.
 *
 * Mocks Supabase + auth helpers so we can drive the action through its
 * branches: non-owner blocked, name mismatch blocked, valid path inserts
 * the row + soft-deletes the tenant, abort restores deleted_at.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Mock state ----------------------------------------------------------

type FakeRow = Record<string, unknown>;
type Result = { data?: FakeRow | FakeRow[] | null; error: { message: string } | null };

let tenantsTable: FakeRow[] = [];
let deletionRequests: FakeRow[] = [];
let auditInserts: FakeRow[] = [];

let currentTenant: {
  id: string;
  name: string;
  member: { role: string };
} | null = null;
let currentUser: { id: string } | null = null;
let mfaBlock: { error: string } | null = null;

vi.mock('@/lib/auth/helpers', () => ({
  getCurrentTenant: () => Promise.resolve(currentTenant),
  getCurrentUser: () => Promise.resolve(currentUser),
}));

vi.mock('@/lib/auth/mfa-enforcement', () => ({
  guardMfaForSensitiveAction: () => Promise.resolve(mfaBlock),
}));

vi.mock('next/cache', () => ({
  revalidatePath: () => {},
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      update: (patch: FakeRow) => {
        const builder = {
          eq: (_col: string, val: string) => {
            if (table === 'tenants') {
              const t = tenantsTable.find((r) => r.id === val);
              if (t) Object.assign(t, patch);
              return Promise.resolve({ error: null } as Result);
            }
            // tenant_deletion_requests update path: continue to .is().select().maybeSingle()
            return {
              is: (_isCol: string, _isVal: null) => ({
                select: (_cols: string) => ({
                  maybeSingle: () => {
                    const active = deletionRequests.find(
                      (r) => r.tenant_id === val && r.aborted_at == null,
                    );
                    if (active) Object.assign(active, patch);
                    return Promise.resolve({
                      data: active ?? null,
                      error: null,
                    } as Result);
                  },
                }),
              }),
            };
          },
        };
        return builder;
      },
      insert: (row: FakeRow) => {
        if (table === 'tenant_deletion_requests') deletionRequests.push(row);
        else if (table === 'audit_log') auditInserts.push(row);
        // Supabase query builders are thenables; the audit-log call uses
        // `.then()` instead of `await`. Mock it the same way.
        return {
          // biome-ignore lint/suspicious/noThenProperty: thenable to mimic Supabase builder
          then: (cb: (r: Result) => void) => Promise.resolve().then(() => cb({ error: null })),
        };
      },
    }),
  }),
}));

// Now import the action under test.
import {
  abortTenantDeletionAction,
  requestTenantDeletionAction,
} from '@/server/actions/tenant-deletion';

// ---- Tests ---------------------------------------------------------------

describe('requestTenantDeletionAction', () => {
  beforeEach(() => {
    tenantsTable = [{ id: 'tenant-1', name: 'Acme Painting', deleted_at: null }];
    deletionRequests = [];
    auditInserts = [];
    currentTenant = { id: 'tenant-1', name: 'Acme Painting', member: { role: 'owner' } };
    currentUser = { id: 'user-1' };
    mfaBlock = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('schedules deletion when business name matches and user is owner', async () => {
    const result = await requestTenantDeletionAction({
      confirmBusinessName: 'Acme Painting',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new Date(result.effectiveAt).getTime()).toBeGreaterThan(Date.now());
    }
    expect(tenantsTable[0].deleted_at).not.toBeNull();
    expect(deletionRequests).toHaveLength(1);
  });

  it('matches confirmation case-insensitively + tolerates whitespace', async () => {
    const result = await requestTenantDeletionAction({
      confirmBusinessName: '  acme PAINTING  ',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when business name does not match', async () => {
    const result = await requestTenantDeletionAction({
      confirmBusinessName: 'wrong company',
    });
    expect(result.ok).toBe(false);
    expect(tenantsTable[0].deleted_at).toBeNull();
    expect(deletionRequests).toHaveLength(0);
  });

  it('rejects when caller is not the owner', async () => {
    if (currentTenant) currentTenant.member.role = 'admin';
    const result = await requestTenantDeletionAction({
      confirmBusinessName: 'Acme Painting',
    });
    expect(result.ok).toBe(false);
    expect(deletionRequests).toHaveLength(0);
  });

  it('blocks if MFA step-up is required', async () => {
    mfaBlock = { error: 'Re-enter your authenticator code.' };
    const result = await requestTenantDeletionAction({
      confirmBusinessName: 'Acme Painting',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Re-enter your authenticator code.');
    expect(deletionRequests).toHaveLength(0);
  });
});

describe('abortTenantDeletionAction', () => {
  beforeEach(() => {
    tenantsTable = [{ id: 'tenant-1', name: 'Acme', deleted_at: '2026-05-13T00:00:00Z' }];
    deletionRequests = [
      {
        id: 'req-1',
        tenant_id: 'tenant-1',
        requested_by_user_id: 'user-1',
        effective_at: '2026-06-12T00:00:00Z',
        aborted_at: null,
      },
    ];
    auditInserts = [];
    currentTenant = { id: 'tenant-1', name: 'Acme', member: { role: 'owner' } };
    currentUser = { id: 'user-1' };
    mfaBlock = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears tenants.deleted_at and marks the request aborted', async () => {
    const result = await abortTenantDeletionAction();
    expect(result.ok).toBe(true);
    expect(tenantsTable[0].deleted_at).toBeNull();
    expect(deletionRequests[0].aborted_at).not.toBeNull();
    expect(deletionRequests[0].aborted_by_user_id).toBe('user-1');
  });

  it('rejects non-owners', async () => {
    if (currentTenant) currentTenant.member.role = 'worker';
    const result = await abortTenantDeletionAction();
    expect(result.ok).toBe(false);
    expect(tenantsTable[0].deleted_at).not.toBeNull();
  });
});
