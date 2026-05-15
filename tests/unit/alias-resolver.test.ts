/**
 * Unit tests for tenant-alias resolution. Pure-function coverage for
 * the candidate-extraction logic; mocked-DB coverage for the lookup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let lastQueryAddresses: string[] | null = null;
let nextRow: { id: string; tenant_id: string; address: string } | null = null;

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (_table: string) => ({
      select: (_cols: string) => ({
        in: (_col: string, vals: string[]) => {
          lastQueryAddresses = vals;
          return {
            eq: (_c: string, _v: string) => ({
              limit: (_n: number) => ({
                maybeSingle: () => Promise.resolve({ data: nextRow, error: null }),
              }),
            }),
          };
        },
      }),
    }),
  }),
}));

import {
  extractRecipientCandidates,
  resolveRecipientToTenantAlias,
} from '@/lib/inbound-email/alias-resolver';

beforeEach(() => {
  lastQueryAddresses = null;
  nextRow = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractRecipientCandidates', () => {
  it('extracts the bare address from a name-and-angle-brackets form', () => {
    expect(
      extractRecipientCandidates(null, 'Connect Contracting <hello@connectcontracting.ca>'),
    ).toEqual(['hello@connectcontracting.ca']);
  });

  it('lowercases every candidate', () => {
    expect(extractRecipientCandidates('HELLO@Connectcontracting.CA', null)).toEqual([
      'hello@connectcontracting.ca',
    ]);
  });

  it('prefers OriginalRecipient and adds it first', () => {
    const got = extractRecipientCandidates(
      'hello@connectcontracting.ca',
      'Jon <jon@example.com>, info@other.com',
    );
    expect(got).toContain('hello@connectcontracting.ca');
    expect(got).toContain('jon@example.com');
    expect(got).toContain('info@other.com');
  });

  it('dedupes when OriginalRecipient overlaps with To', () => {
    const got = extractRecipientCandidates(
      'hello@connectcontracting.ca',
      'hello@connectcontracting.ca',
    );
    expect(got).toEqual(['hello@connectcontracting.ca']);
  });

  it('returns an empty array for missing inputs', () => {
    expect(extractRecipientCandidates(null, null)).toEqual([]);
    expect(extractRecipientCandidates(undefined, undefined)).toEqual([]);
    expect(extractRecipientCandidates('', '')).toEqual([]);
  });

  it('drops fragments that lack an @ sign', () => {
    expect(extractRecipientCandidates(null, 'not-an-address, also <also@here.com>')).toEqual([
      'also@here.com',
    ]);
  });

  it('parses multiple comma-separated recipients in To', () => {
    const got = extractRecipientCandidates(null, 'a@x.com, "B Last" <b@y.com>, c@z.com');
    expect(got).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
  });
});

describe('resolveRecipientToTenantAlias', () => {
  it('returns null for an empty candidate list (no DB call)', async () => {
    const result = await resolveRecipientToTenantAlias([]);
    expect(result).toBeNull();
    expect(lastQueryAddresses).toBeNull();
  });

  it('queries with every candidate and returns the row when matched', async () => {
    nextRow = {
      id: 'alias-1',
      tenant_id: 'tenant-a',
      address: 'hello@connectcontracting.ca',
    };

    const result = await resolveRecipientToTenantAlias([
      'hello@connectcontracting.ca',
      'jon@other.com',
    ]);

    expect(lastQueryAddresses).toEqual(['hello@connectcontracting.ca', 'jon@other.com']);
    expect(result).toEqual({
      id: 'alias-1',
      tenantId: 'tenant-a',
      address: 'hello@connectcontracting.ca',
    });
  });

  it('returns null when no row matches', async () => {
    nextRow = null;
    const result = await resolveRecipientToTenantAlias(['random@nope.com']);
    expect(result).toBeNull();
  });
});
