/**
 * Authenticated QuickBooks Online API client.
 *
 * Phase 3 of the QBO Import V1 epic. Builds on the minimal fetcher from
 * Phase 2 with:
 *   - retry on 401 (refresh tokens, try once more)
 *   - retry on 429 + 5xx with exponential backoff
 *   - paginated SELECT iterators (`qboQueryAll`) using STARTPOSITION /
 *     MAXRESULTS — defaults to MAXRESULTS=1000 to minimize API calls
 *     against the 500k/month Intuit billing threshold
 *   - Change Data Capture (`qboCdc`) for re-sync against a timestamp,
 *     batched across up to 30 entity types per request
 *   - optional `onApiCall` callback so the import worker can increment
 *     `qbo_import_jobs.api_calls_used`
 *
 * Per-entity typed helpers (typed Customer, Invoice, etc.) live in the
 * import worker — this file stays generic.
 */

import { getQboApiBase } from './env';
import { refreshTokens } from './oauth';
import { clearConnection, loadConnection, loadValidTokens, saveConnection } from './tokens';

// =====================================================================
// Errors
// =====================================================================

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

// =====================================================================
// Core fetcher
// =====================================================================

export type QboFetchOpts = {
  /** QBO query string. e.g. `'SELECT * FROM Customer MAXRESULTS 1000'` */
  query?: string;
  /** Path under `/v3/company/{realmId}/`. Mutually exclusive with `query`. */
  path?: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Called once per API call attempt (including retries). Use to increment counters. */
  onApiCall?: () => void;
  /** Internal: prevents infinite refresh loops. */
  _hasRefreshed?: boolean;
};

const MAX_RETRY_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 2000;

/**
 * Authenticated request against the QBO accounting API.
 *
 * Retries:
 *   - 401 once after force-refreshing tokens (catches mid-session
 *     invalidation that the proactive refresh in `loadValidTokens` missed)
 *   - 429 / 5xx with exponential backoff up to `MAX_RETRY_ATTEMPTS` times
 *
 * Throws `QboNotConnectedError` if tokens are missing or unrefreshable,
 * `QboApiError` on any other non-2xx response after retries.
 */
export async function qboFetch(tenantId: string, opts: QboFetchOpts): Promise<unknown> {
  return qboFetchWithRetry(tenantId, opts, 1);
}

async function qboFetchWithRetry(
  tenantId: string,
  opts: QboFetchOpts,
  attempt: number,
): Promise<unknown> {
  const conn = await loadValidTokens(tenantId);
  if (!conn) throw new QboNotConnectedError();

  const url = buildQboUrl(getQboApiBase(conn.environment), conn.realmId, opts);

  opts.onApiCall?.();
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${conn.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (res.ok) return res.json();

  // 401 — token may have been invalidated server-side. Force refresh once.
  if (res.status === 401 && !opts._hasRefreshed) {
    const refreshed = await forceRefresh(tenantId);
    if (!refreshed) throw new QboNotConnectedError();
    return qboFetchWithRetry(tenantId, { ...opts, _hasRefreshed: true }, attempt);
  }

  // 429 (rate limit) or 5xx — exponential backoff
  if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRY_ATTEMPTS) {
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after')) ?? backoffDelay(attempt);
    await sleep(retryAfterMs);
    return qboFetchWithRetry(tenantId, opts, attempt + 1);
  }

  const text = await res.text().catch(() => '');
  throw new QboApiError(res.status, text);
}

/**
 * Build the QBO API URL. Exported only for unit testing — callers should
 * use `qboFetch` / `qboQuery` / `qboCdc` instead.
 */
export function buildQboUrl(base: string, realmId: string, opts: QboFetchOpts): string {
  const root = `${base}/v3/company/${realmId}`;
  if (opts.query) {
    const qs = new URLSearchParams({ query: opts.query }).toString();
    return `${root}/query?${qs}`;
  }
  if (opts.path) {
    return `${root}/${opts.path.replace(/^\//, '')}`;
  }
  throw new Error('qboFetch requires either `query` or `path`.');
}

async function forceRefresh(tenantId: string): Promise<boolean> {
  const conn = await loadConnection(tenantId);
  if (!conn) return false;
  try {
    const fresh = await refreshTokens(conn.refreshToken);
    await saveConnection(tenantId, conn.realmId, fresh);
    return true;
  } catch (err) {
    console.error('[qbo.client] force_refresh_failed', {
      tenant_id: tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    await clearConnection(tenantId, { keepRealmId: true });
    return false;
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  // HTTP-date format (rare from Intuit but spec-allowed)
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

function backoffDelay(attempt: number): number {
  return RETRY_BASE_DELAY_MS * 2 ** (attempt - 1); // 2s, 4s, 8s, 16s
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =====================================================================
// Typed query helpers
// =====================================================================

/**
 * Shape of `QueryResponse` for a SELECT against `entity`. QBO returns the
 * row array under the entity name; we widen this to indexable for the
 * generic helper. `startPosition` and `maxResults` echo what was requested.
 */
type QueryResponse<T> = {
  QueryResponse?: Record<string, T[] | number | undefined> & {
    startPosition?: number;
    maxResults?: number;
    totalCount?: number;
  };
};

export type QboQueryOpts = {
  onApiCall?: () => void;
};

/**
 * Single-page typed query. Caller is responsible for paginating — use
 * `qboQueryAll` for that.
 */
export async function qboQuery<T>(
  tenantId: string,
  queryString: string,
  opts: QboQueryOpts = {},
): Promise<{ items: T[]; totalCount: number | null }> {
  const json = (await qboFetch(tenantId, {
    query: queryString,
    onApiCall: opts.onApiCall,
  })) as QueryResponse<T>;

  const qr = json.QueryResponse ?? {};
  // First array-valued property under QueryResponse is the entity rows.
  const items = (Object.values(qr).find((v) => Array.isArray(v)) as T[] | undefined) ?? ([] as T[]);
  const totalCount = typeof qr.totalCount === 'number' ? qr.totalCount : null;
  return { items, totalCount };
}

export type QboQueryAllOpts = {
  /** WHERE clause body (no `WHERE` keyword). Optional. */
  where?: string;
  /** Page size. Default 1000 (Intuit's max). Lower for testing. */
  pageSize?: number;
  /** Stop after this many pages. Useful for tests + bounded backfills. */
  maxPages?: number;
  /** Called once per fetched page (after the API call). */
  onPage?: (items: unknown[], pageIndex: number) => void;
  /** Forwarded to `qboFetch`. */
  onApiCall?: () => void;
};

/**
 * Async iterator over all pages of a SELECT against `entity`. Each
 * yielded value is one page's worth of rows.
 *
 * QBO pagination convention: `STARTPOSITION 1 MAXRESULTS 1000`, then
 * `STARTPOSITION 1001 MAXRESULTS 1000`, etc. Stops when a page returns
 * fewer rows than requested (last page) or zero rows.
 *
 * Usage:
 *   for await (const page of qboQueryAll<QboCustomer>(tid, 'Customer')) {
 *     await persistBatch(page);
 *   }
 */
export async function* qboQueryAll<T>(
  tenantId: string,
  entity: string,
  opts: QboQueryAllOpts = {},
): AsyncGenerator<T[], void, void> {
  const pageSize = opts.pageSize ?? 1000;
  const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
  const whereClause = opts.where ? ` WHERE ${opts.where}` : '';

  let startPosition = 1;
  let pageIndex = 0;

  while (pageIndex < maxPages) {
    const queryString = `SELECT * FROM ${entity}${whereClause} STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`;
    const { items } = await qboQuery<T>(tenantId, queryString, { onApiCall: opts.onApiCall });
    opts.onPage?.(items as unknown[], pageIndex);
    if (items.length === 0) return;
    yield items;
    if (items.length < pageSize) return;
    startPosition += items.length;
    pageIndex += 1;
  }
}

// =====================================================================
// Change Data Capture (CDC)
// =====================================================================

/**
 * QBO CDC response. One key per entity, value is the array of changed
 * rows (including deletes marked with `status: 'Deleted'`).
 *
 * Intuit caps CDC requests at 30 entity types and the response set at
 * around 1000 rows per entity. For larger deltas we fall back to a full
 * SELECT against the changed entities — caller's call.
 */
export type CdcResponse = {
  /** Per-entity rows. Entity name → array of changed objects. */
  byEntity: Record<string, unknown[]>;
  /** Echoed back from QBO; useful for advancing the cursor on `tenants.qbo_cdc_cursors`. */
  cdcResponseTime: string | null;
};

export type QboCdcOpts = {
  onApiCall?: () => void;
};

/**
 * Fetch all entities changed since `changedSince`. Use this in place of
 * `qboQueryAll` on re-sync runs to keep API call counts low.
 *
 * @param tenantId      HH tenant
 * @param entities      Up to 30 QBO entity names, e.g. `['Customer','Invoice','Payment']`
 * @param changedSince  Timestamp from `tenants.qbo_cdc_cursors[entity]` (or the
 *                      last full-sync time on first delta run)
 */
export async function qboCdc(
  tenantId: string,
  entities: string[],
  changedSince: Date,
  opts: QboCdcOpts = {},
): Promise<CdcResponse> {
  if (entities.length === 0) {
    return { byEntity: {}, cdcResponseTime: null };
  }
  if (entities.length > 30) {
    throw new Error(`QBO CDC supports up to 30 entities per call; got ${entities.length}.`);
  }

  const path = `cdc?entities=${entities.join(',')}&changedSince=${changedSince.toISOString()}`;
  const json = (await qboFetch(tenantId, {
    path,
    onApiCall: opts.onApiCall,
  })) as {
    CDCResponse?: Array<{
      QueryResponse?: Array<Record<string, unknown>>;
    }>;
    time?: string;
  };

  const byEntity: Record<string, unknown[]> = {};
  const responses = json.CDCResponse?.[0]?.QueryResponse ?? [];
  for (const qr of responses) {
    for (const [key, value] of Object.entries(qr)) {
      if (Array.isArray(value)) {
        byEntity[key] = value;
      }
    }
  }
  return { byEntity, cdcResponseTime: json.time ?? null };
}

// =====================================================================
// Convenience: CompanyInfo
// =====================================================================

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
