import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  process.env.QBO_CLIENT_ID = 'test_client_id';
  process.env.QBO_CLIENT_SECRET = 'test_client_secret';
  process.env.QBO_REDIRECT_URI = 'http://localhost:3000/api/qbo/callback';
  process.env.QBO_STATE_SECRET = `unit-test-${'x'.repeat(40)}`;
});

vi.mock('@/lib/qbo/tokens', () => ({
  loadValidTokens: vi.fn().mockResolvedValue({
    accessToken: 'fake_access_token',
    realmId: '9341454020483723',
    environment: 'sandbox' as const,
  }),
  loadConnection: vi.fn(),
  saveConnection: vi.fn(),
  clearConnection: vi.fn(),
}));

import { buildQboUrl, qboQueryAll } from '@/lib/qbo/client';
import { getQboApiBase } from '@/lib/qbo/env';

describe('buildQboUrl', () => {
  const SANDBOX = getQboApiBase('sandbox');
  const PROD = getQboApiBase('production');
  const REALM = '9341454020483723';

  it('builds a query URL with proper escaping', () => {
    const url = buildQboUrl(SANDBOX, REALM, {
      query: 'SELECT * FROM Customer STARTPOSITION 1 MAXRESULTS 1000',
    });
    expect(url).toContain(`${SANDBOX}/v3/company/${REALM}/query?`);
    // Spaces become +, MAXRESULTS preserved. * is unreserved in URLSearchParams.
    expect(url).toContain('query=SELECT+*+FROM+Customer+STARTPOSITION+1+MAXRESULTS+1000');
  });

  it('escapes single quotes in WHERE clauses', () => {
    const url = buildQboUrl(SANDBOX, REALM, {
      query: "SELECT * FROM Customer WHERE DisplayName = 'O''Brien Inc'",
    });
    // application/x-www-form-urlencoded: '+' for spaces, single quotes
    // are unreserved and survive raw — QBO accepts them as-is.
    const encoded = url.split('query=')[1];
    const decoded = decodeURIComponent(encoded.replace(/\+/g, ' '));
    expect(decoded).toBe("SELECT * FROM Customer WHERE DisplayName = 'O''Brien Inc'");
  });

  it('builds a path URL, stripping a leading slash', () => {
    expect(buildQboUrl(SANDBOX, REALM, { path: 'companyinfo/1' })).toBe(
      `${SANDBOX}/v3/company/${REALM}/companyinfo/1`,
    );
    expect(buildQboUrl(SANDBOX, REALM, { path: '/companyinfo/1' })).toBe(
      `${SANDBOX}/v3/company/${REALM}/companyinfo/1`,
    );
  });

  it('routes prod and sandbox to different bases', () => {
    expect(buildQboUrl(PROD, REALM, { path: 'companyinfo/1' })).toContain(
      'quickbooks.api.intuit.com',
    );
    expect(buildQboUrl(SANDBOX, REALM, { path: 'companyinfo/1' })).toContain(
      'sandbox-quickbooks.api.intuit.com',
    );
  });

  it('throws when neither query nor path is provided', () => {
    expect(() => buildQboUrl(SANDBOX, REALM, {})).toThrow(/query.*path/);
  });

  it('preserves CDC query string when used via path', () => {
    const since = new Date('2026-05-11T10:00:00.000Z');
    const url = buildQboUrl(SANDBOX, REALM, {
      path: `cdc?entities=Customer,Invoice,Payment&changedSince=${since.toISOString()}`,
    });
    expect(url).toBe(
      `${SANDBOX}/v3/company/${REALM}/cdc?entities=Customer,Invoice,Payment&changedSince=2026-05-11T10:00:00.000Z`,
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('qboQueryAll pagination', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('paginates until a partial page is returned', async () => {
    // Two full pages of 2, then a half page of 1, then iterator should stop.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ QueryResponse: { Customer: [{ Id: '1' }, { Id: '2' }] } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ QueryResponse: { Customer: [{ Id: '3' }, { Id: '4' }] } }),
      )
      .mockResolvedValueOnce(jsonResponse({ QueryResponse: { Customer: [{ Id: '5' }] } }));

    const collected: Array<{ Id: string }> = [];
    for await (const page of qboQueryAll<{ Id: string }>('tenant_id', 'Customer', {
      pageSize: 2,
    })) {
      collected.push(...page);
    }

    expect(collected.map((c) => c.Id)).toEqual(['1', '2', '3', '4', '5']);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Verify STARTPOSITION advanced correctly across pages.
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toMatch(/STARTPOSITION\+1\+MAXRESULTS\+2/);
    expect(urls[1]).toMatch(/STARTPOSITION\+3\+MAXRESULTS\+2/);
    expect(urls[2]).toMatch(/STARTPOSITION\+5\+MAXRESULTS\+2/);
  });

  it('stops immediately on an empty first page', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ QueryResponse: {} }));

    const collected: unknown[] = [];
    for await (const page of qboQueryAll('tenant_id', 'Customer', { pageSize: 1000 })) {
      collected.push(...page);
    }
    expect(collected).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('respects maxPages cap', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ QueryResponse: { Customer: [{ Id: '1' }, { Id: '2' }] } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ QueryResponse: { Customer: [{ Id: '3' }, { Id: '4' }] } }),
      );

    const collected: Array<{ Id: string }> = [];
    for await (const page of qboQueryAll<{ Id: string }>('tenant_id', 'Customer', {
      pageSize: 2,
      maxPages: 1,
    })) {
      collected.push(...page);
    }
    expect(collected.map((c) => c.Id)).toEqual(['1', '2']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honors WHERE clause', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ QueryResponse: { Customer: [] } }));

    const iter = qboQueryAll('tenant_id', 'Customer', {
      pageSize: 100,
      where: "Active = true AND MetaData.LastUpdatedTime > '2026-01-01'",
    });
    await iter.next();

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toMatch(/WHERE\+Active\+%3D\+true/);
  });

  it('invokes onApiCall once per fetch', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ QueryResponse: { Customer: [{ Id: '1' }] } }))
      .mockResolvedValueOnce(jsonResponse({ QueryResponse: { Customer: [] } }));

    let calls = 0;
    const iter = qboQueryAll('tenant_id', 'Customer', {
      pageSize: 1,
      onApiCall: () => {
        calls += 1;
      },
    });
    for await (const _page of iter) {
      // drain
    }
    expect(calls).toBe(2);
  });
});
