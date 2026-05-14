/**
 * SLO dashboard data fetcher.
 *
 * Pulls performance + send-success numbers from two sources:
 *   - Sentry Discover API (errors + transaction p95/throughput)
 *   - HeyHenry Supabase (email_send_log, ar_send_log)
 *
 * Targets are intentionally permissive on day 1 — re-tune after a week of
 * baseline data.
 */

import { createServiceClient } from '@/lib/supabase';

const SENTRY_ORG = 'smart-fusion-marketing-inc-6r';
const _SENTRY_PROJECT = 'heyhenry';
const SENTRY_REGION = 'https://de.sentry.io';

export type SloStatus = 'ok' | 'warn' | 'breach' | 'no-data';

export type SloTile = {
  label: string;
  /** Human-readable actual value, e.g. "1.42 s", "99.7 %". */
  actual: string;
  /** Human-readable target, e.g. "< 2.0 s", "≥ 99.0 %". */
  target: string;
  status: SloStatus;
  /** Optional sample size / context line. */
  sub?: string;
};

export type HotPath = {
  transaction: string;
  p95Ms: number;
  count: number;
  errorRate: number;
  status: SloStatus;
};

export type SloPageData = {
  windowDays: number;
  generatedAt: string;
  overallTiles: SloTile[];
  hotPaths: HotPath[];
  sendStats: {
    transactional: SloTile;
    autoresponderEmail: SloTile;
    autoresponderSms: SloTile;
  };
  warning: string | null;
};

/**
 * Routes we explicitly track p95 on. Pattern strings match Sentry transaction
 * names exactly. Add to project = POST /projects/* (line items, tasks, etc.).
 */
const HOT_PATHS: { transaction: string; targetMs: number; warnMs: number }[] = [
  { transaction: '/projects/:id', targetMs: 3000, warnMs: 2000 },
  { transaction: 'POST /projects/*', targetMs: 2500, warnMs: 1500 },
  { transaction: 'POST /expenses/new', targetMs: 4000, warnMs: 2500 },
  { transaction: '/estimate/:code', targetMs: 3000, warnMs: 2000 },
  { transaction: '/login', targetMs: 2500, warnMs: 1500 },
  { transaction: '/dashboard', targetMs: 4000, warnMs: 2500 },
];

function statusForP95(actualMs: number, warnMs: number, targetMs: number): SloStatus {
  if (actualMs < warnMs) return 'ok';
  if (actualMs < targetMs) return 'warn';
  return 'breach';
}

function statusForRate(actualPct: number, warnPct: number, breachPct: number): SloStatus {
  // For success rates: higher is better.
  if (actualPct >= warnPct) return 'ok';
  if (actualPct >= breachPct) return 'warn';
  return 'breach';
}

type SentryEventsRow = Record<string, number | string>;

async function sentryDiscover(
  query: string,
  fields: string[],
  windowDays: number,
): Promise<SentryEventsRow[]> {
  const token = process.env.SENTRY_USER_TOKEN ?? process.env.SENTRY_AUTH_TOKEN;
  if (!token) throw new Error('SENTRY_USER_TOKEN missing');

  const params = new URLSearchParams();
  params.set('query', query);
  for (const f of fields) params.append('field', f);
  params.set('statsPeriod', `${windowDays}d`);
  params.set('per_page', '100');
  params.set('project', '4511284356448336');
  params.set('dataset', 'spans');

  const url = `${SENTRY_REGION}/api/0/organizations/${SENTRY_ORG}/events/?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    next: { revalidate: 60 },
  });
  if (!res.ok) {
    throw new Error(`Sentry ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { data?: SentryEventsRow[] };
  return json.data ?? [];
}

async function fetchHotPathStats(windowDays: number): Promise<HotPath[]> {
  // One Discover query covers all hot paths — we filter client-side after.
  // Sentry's `transaction:[a,b]` array form mishandles values containing
  // colons / spaces, so we OR them together instead.
  const transactionFilter = HOT_PATHS.map((h) => `transaction:"${h.transaction}"`).join(' OR ');
  const rows = await sentryDiscover(
    `is_transaction:true (${transactionFilter})`,
    ['transaction', 'p95(span.duration)', 'count()', 'failure_rate()'],
    windowDays,
  );

  return HOT_PATHS.map((path) => {
    const row = rows.find((r) => r.transaction === path.transaction);
    const p95Ms = Math.round(Number(row?.['p95(span.duration)'] ?? 0));
    const count = Number(row?.['count()'] ?? 0);
    const errorRate = Number(row?.['failure_rate()'] ?? 0);
    const status: SloStatus =
      count === 0 ? 'no-data' : statusForP95(p95Ms, path.warnMs, path.targetMs);
    return { transaction: path.transaction, p95Ms, count, errorRate, status };
  });
}

async function fetchOverallSentry(windowDays: number) {
  const rows = await sentryDiscover(
    'is_transaction:true',
    ['count()', 'failure_rate()'],
    windowDays,
  );
  const row = rows[0];
  return {
    txCount: Number(row?.['count()'] ?? 0),
    failureRate: Number(row?.['failure_rate()'] ?? 0),
  };
}

/**
 * PostgREST `in` list literal — `(id1,id2)` — for the QA / demo tenants,
 * or null when there are none. Demo tenants have suppressed (never-sent)
 * email + SMS, so their rows would otherwise skew send-success rates. The
 * HeyHenry app applies the same exclusion to its own metrics; see
 * `src/lib/tenants/demo.ts`.
 */
async function demoTenantExclusion(
  supabase: ReturnType<typeof createServiceClient>,
): Promise<string | null> {
  const { data } = await supabase.from('tenants').select('id').eq('is_demo', true);
  const ids = (data ?? []).map((r) => r.id as string);
  return ids.length ? `(${ids.join(',')})` : null;
}

async function fetchSendStats(windowDays: number) {
  const supabase = createServiceClient();
  const since = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const excludeDemo = await demoTenantExclusion(supabase);

  // Transactional email (email_send_log).
  let txEmailQ = supabase
    .from('email_send_log')
    .select('status', { count: 'exact' })
    .gte('created_at', since);
  if (excludeDemo) txEmailQ = txEmailQ.not('tenant_id', 'in', excludeDemo);
  const txEmail = await txEmailQ;

  // Autoresponder (ar_send_log) — split by channel.
  let arEmailQ = supabase
    .from('ar_send_log')
    .select('status', { count: 'exact' })
    .eq('channel', 'email')
    .gte('created_at', since);
  if (excludeDemo) arEmailQ = arEmailQ.not('tenant_id', 'in', excludeDemo);
  const arEmail = await arEmailQ;

  let arSmsQ = supabase
    .from('ar_send_log')
    .select('status', { count: 'exact' })
    .eq('channel', 'sms')
    .gte('created_at', since);
  if (excludeDemo) arSmsQ = arSmsQ.not('tenant_id', 'in', excludeDemo);
  const arSms = await arSmsQ;

  function toTile(label: string, rows: { status: string }[] | null, total: number): SloTile {
    if (!rows || total === 0) {
      return { label, actual: '—', target: '≥ 98.0 %', status: 'no-data', sub: '0 sends' };
    }
    const failed = rows.filter((r) => r.status === 'failed' || r.status === 'bounced').length;
    const successPct = ((total - failed) / total) * 100;
    return {
      label,
      actual: `${successPct.toFixed(1)} %`,
      target: '≥ 98.0 %',
      status: statusForRate(successPct, 99, 98),
      sub: `${total - failed}/${total} sent · ${failed} failed`,
    };
  }

  return {
    transactional: toTile('Transactional email', txEmail.data ?? [], txEmail.count ?? 0),
    autoresponderEmail: toTile('Autoresponder email', arEmail.data ?? [], arEmail.count ?? 0),
    autoresponderSms: toTile('Autoresponder SMS', arSms.data ?? [], arSms.count ?? 0),
  };
}

export async function getSloPageData(windowDays = 7): Promise<SloPageData> {
  let warning: string | null = null;

  let hotPaths: HotPath[] = [];
  let overall = { txCount: 0, failureRate: 0 };
  let sendStats: SloPageData['sendStats'] = {
    transactional: {
      label: 'Transactional email',
      actual: '—',
      target: '≥ 98.0 %',
      status: 'no-data',
    },
    autoresponderEmail: {
      label: 'Autoresponder email',
      actual: '—',
      target: '≥ 98.0 %',
      status: 'no-data',
    },
    autoresponderSms: {
      label: 'Autoresponder SMS',
      actual: '—',
      target: '≥ 98.0 %',
      status: 'no-data',
    },
  };

  try {
    [hotPaths, overall, sendStats] = await Promise.all([
      fetchHotPathStats(windowDays),
      fetchOverallSentry(windowDays),
      fetchSendStats(windowDays),
    ]);
  } catch (err) {
    warning = err instanceof Error ? err.message : 'Failed to load SLO data';
  }

  const errorRatePct = overall.failureRate * 100;
  const overallTiles: SloTile[] = [
    {
      label: 'Error-free transactions',
      actual: overall.txCount === 0 ? '—' : `${(100 - errorRatePct).toFixed(2)} %`,
      target: '≥ 99.5 %',
      status: overall.txCount === 0 ? 'no-data' : statusForRate(100 - errorRatePct, 99.5, 99.0),
      sub: `${overall.txCount.toLocaleString()} transactions in ${windowDays}d`,
    },
  ];

  return {
    windowDays,
    generatedAt: new Date().toISOString(),
    overallTiles,
    hotPaths,
    sendStats,
    warning,
  };
}
