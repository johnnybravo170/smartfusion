/**
 * Minimal authenticated fetcher for the QBO accounting API.
 *
 * Phase 2 only needs CompanyInfo (to populate `qbo_company_name` right
 * after connect). The Phase 3 card extends this with pagination, CDC,
 * and per-entity helpers.
 */

import { getQboApiBase } from './env';
import { loadValidTokens } from './tokens';

export type QboFetchOpts = {
  /** QBO query string (without the SELECT). e.g. `'SELECT * FROM Customer MAXRESULTS 1000'` */
  query?: string;
  /** Path under `/v3/company/{realmId}/`. Mutually exclusive with `query`. */
  path?: string;
  method?: 'GET' | 'POST';
  body?: unknown;
};

export class QboNotConnectedError extends Error {
  constructor() {
    super('QBO is not connected for this tenant.');
    this.name = 'QboNotConnectedError';
  }
}

export class QboApiError extends Error {
  status: number;
  responseBody: string;
  constructor(status: number, responseBody: string) {
    super(`QBO API error ${status}: ${responseBody.slice(0, 200)}`);
    this.name = 'QboApiError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

/**
 * Authenticated request against the QBO accounting API.
 * Throws `QboNotConnectedError` if the tenant has no valid tokens, or
 * `QboApiError` on any non-2xx response.
 */
export async function qboFetch(tenantId: string, opts: QboFetchOpts): Promise<unknown> {
  const conn = await loadValidTokens(tenantId);
  if (!conn) throw new QboNotConnectedError();

  const base = getQboApiBase(conn.environment);
  let url: string;
  if (opts.query) {
    const qs = new URLSearchParams({ query: opts.query }).toString();
    url = `${base}/v3/company/${conn.realmId}/query?${qs}`;
  } else if (opts.path) {
    url = `${base}/v3/company/${conn.realmId}/${opts.path.replace(/^\//, '')}`;
  } else {
    throw new Error('qboFetch requires either `query` or `path`.');
  }

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${conn.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new QboApiError(res.status, text);
  }
  return res.json();
}

/**
 * Fetch the connected company's display name. Used right after OAuth
 * callback so the settings UI can show "Connected to Acme Inc."
 */
export async function fetchCompanyInfo(
  tenantId: string,
): Promise<{ companyName: string; legalName: string | null } | null> {
  try {
    const json = (await qboFetch(tenantId, { path: 'companyinfo/1' })) as {
      CompanyInfo?: { CompanyName?: string; LegalName?: string };
    };
    const info = json?.CompanyInfo;
    if (!info) return null;
    return {
      companyName: info.CompanyName ?? 'QuickBooks Company',
      legalName: info.LegalName ?? null,
    };
  } catch (err) {
    console.error('[qbo.client] company_info_failed', {
      tenant_id: tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
