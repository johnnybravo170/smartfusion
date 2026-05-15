/**
 * Unit tests for `createIntakeDraftFromWidgetAction`.
 *
 * Focus: the anti-tamper path check — a forged request must not be able
 * to attach a photo path that doesn't live under the tenant's own
 * `widget/<tenant_id>/` prefix.
 *
 * Mocks `createAdminClient` so we never hit Supabase; assert what gets
 * passed to `.insert()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let lastInsertRow: Record<string, unknown> | null = null;
let nextInsertError: { message: string } | null = null;

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (_table: string) => ({
      insert: (row: Record<string, unknown>) => {
        lastInsertRow = row;
        return {
          select: (_cols: string) => ({
            single: () =>
              Promise.resolve(
                nextInsertError
                  ? { data: null, error: nextInsertError }
                  : { data: { id: 'draft-1' }, error: null },
              ),
          }),
        };
      },
    }),
  }),
}));

import { createIntakeDraftFromWidgetAction } from '@/server/actions/widget-intake';

const TENANT_A = '00000000-0000-0000-0000-00000000aaaa';
const TENANT_B = '00000000-0000-0000-0000-00000000bbbb';

beforeEach(() => {
  lastInsertRow = null;
  nextInsertError = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createIntakeDraftFromWidgetAction', () => {
  it('inserts an intake_drafts row with the expected envelope', async () => {
    const result = await createIntakeDraftFromWidgetAction({
      tenantId: TENANT_A,
      name: 'Jane',
      phone: '+15555550100',
      email: 'jane@example.com',
      description: 'Bathroom reno',
      attachments: [{ path: `widget/${TENANT_A}/abc.jpg`, mime: 'image/jpeg' }],
    });

    expect(result).toEqual({ ok: true, draftId: 'draft-1' });
    expect(lastInsertRow).toMatchObject({
      tenant_id: TENANT_A,
      status: 'pending',
      source: 'lead_form',
      disposition: 'pending_review',
      customer_name: 'Jane',
    });
    expect(lastInsertRow?.pasted_text).toContain('Name: Jane');
    expect(lastInsertRow?.pasted_text).toContain('Email: jane@example.com');

    const artifacts = lastInsertRow?.artifacts as Array<{
      path: string;
      mime: string;
      name: string;
    }>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      path: `widget/${TENANT_A}/abc.jpg`,
      mime: 'image/jpeg',
      name: 'abc.jpg',
    });
  });

  it('REJECTS a path that lives under a different tenant prefix (anti-tamper)', async () => {
    const result = await createIntakeDraftFromWidgetAction({
      tenantId: TENANT_A,
      name: 'Mallory',
      phone: '+15555550100',
      email: null,
      description: 'forged',
      attachments: [{ path: `widget/${TENANT_B}/secret.jpg`, mime: 'image/jpeg' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('path_not_in_tenant_prefix');
    }
    // Crucially: no row was inserted before we detected the forgery.
    expect(lastInsertRow).toBeNull();
  });

  it('REJECTS a path that escapes the widget/ prefix entirely', async () => {
    const result = await createIntakeDraftFromWidgetAction({
      tenantId: TENANT_A,
      name: 'Mallory',
      phone: '+15555550100',
      email: null,
      description: 'forged',
      attachments: [{ path: `tenant/${TENANT_A}/private.jpg`, mime: 'image/jpeg' }],
    });

    expect(result.ok).toBe(false);
    expect(lastInsertRow).toBeNull();
  });

  it('surfaces a DB insert failure', async () => {
    nextInsertError = { message: 'connection refused' };

    const result = await createIntakeDraftFromWidgetAction({
      tenantId: TENANT_A,
      name: 'Jane',
      phone: '+15555550100',
      email: null,
      description: 'reno',
      attachments: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('connection refused');
    }
  });

  it('handles zero attachments cleanly', async () => {
    const result = await createIntakeDraftFromWidgetAction({
      tenantId: TENANT_A,
      name: 'Jane',
      phone: '+15555550100',
      email: null,
      description: 'just describing the work',
      attachments: [],
    });

    expect(result.ok).toBe(true);
    expect(lastInsertRow?.artifacts).toEqual([]);
  });
});
