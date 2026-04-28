/**
 * Dashboard queries — all data fetching for the morning briefing page.
 *
 * Tenant isolation is enforced by RLS policies on every table. We never
 * filter on `tenant_id` in application code.
 */

import { createClient } from '@/lib/supabase/server';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TodaysJob = {
  id: string;
  status: string;
  scheduled_at: string;
  notes: string | null;
  customer: {
    id: string;
    name: string;
    address_line1: string | null;
    city: string | null;
  } | null;
};

export type KeyMetrics = {
  revenueThisMonthCents: number;
  outstandingCents: number;
  openJobsCount: number;
  pendingQuotesCount: number;
};

export type AttentionItem =
  | { kind: 'overdue_todo'; id: string; title: string; daysOverdue: number }
  | {
      kind: 'stale_quote';
      id: string;
      customerName: string;
      daysSinceSent: number;
    }
  | {
      kind: 'overdue_invoice';
      id: string;
      customerName: string;
      amountCents: number;
      taxCents: number;
      daysSinceSent: number;
    };

export type RecentWorklogEntry = {
  id: string;
  entry_type: string;
  title: string | null;
  created_at: string;
  related_type: string | null;
  related_id: string | null;
  related_name: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the start and end of "today" in the given IANA timezone as ISO strings. */
export function todayBounds(timezone: string): { start: string; end: string } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localDate = formatter.format(now); // "2026-04-16"
  const start = new Date(`${localDate}T00:00:00`);
  const end = new Date(`${localDate}T23:59:59.999`);

  // Convert back to UTC by calculating the offset
  const offsetMs = getTimezoneOffsetMs(timezone, now);
  return {
    start: new Date(start.getTime() - offsetMs).toISOString(),
    end: new Date(end.getTime() - offsetMs).toISOString(),
  };
}

/** Get timezone offset in milliseconds for a given IANA timezone. */
function getTimezoneOffsetMs(timezone: string, date: Date): number {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = date.toLocaleString('en-US', { timeZone: timezone });
  return new Date(tzStr).getTime() - new Date(utcStr).getTime();
}

/** Start of current month in UTC. */
function monthStartIso(timezone: string): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localDate = formatter.format(now); // "2026-04-16"
  const [year, month] = localDate.split('-');
  const monthStart = new Date(`${year}-${month}-01T00:00:00`);
  const offsetMs = getTimezoneOffsetMs(timezone, now);
  return new Date(monthStart.getTime() - offsetMs).toISOString();
}

/** Today's date string in tenant timezone (YYYY-MM-DD). */
function todayDateStr(timezone: string): string {
  const now = new Date();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Days between two dates (positive if target is in the past). */
function daysBetween(isoDate: string, referenceDate: Date): number {
  const target = new Date(isoDate);
  const diffMs = referenceDate.getTime() - target.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Extractors (Supabase join normalization)
// ---------------------------------------------------------------------------

function extractCustomer(raw: unknown): TodaysJob['customer'] {
  if (!raw) return null;
  const c = Array.isArray(raw) ? raw[0] : raw;
  if (!c || typeof c !== 'object') return null;
  const obj = c as Record<string, unknown>;
  return {
    id: obj.id as string,
    name: obj.name as string,
    address_line1: (obj.address_line1 as string) ?? null,
    city: (obj.city as string) ?? null,
  };
}

function extractCustomerName(raw: unknown): string {
  if (!raw) return 'Unknown';
  const c = Array.isArray(raw) ? raw[0] : raw;
  if (!c || typeof c !== 'object') return 'Unknown';
  return ((c as Record<string, unknown>).name as string) ?? 'Unknown';
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getTodaysJobs(timezone: string): Promise<TodaysJob[]> {
  const supabase = await createClient();
  const bounds = todayBounds(timezone);

  const { data, error } = await supabase
    .from('jobs')
    .select(
      'id, status, scheduled_at, notes, customers:customer_id (id, name, address_line1, city)',
    )
    .is('deleted_at', null)
    .gte('scheduled_at', bounds.start)
    .lte('scheduled_at', bounds.end)
    .order('scheduled_at', { ascending: true });

  if (error) throw new Error(`Failed to load today's jobs: ${error.message}`);

  return (data ?? []).map((row) => {
    const { customers: customerRaw, ...rest } = row as Record<string, unknown>;
    return {
      ...(rest as Omit<TodaysJob, 'customer'>),
      customer: extractCustomer(customerRaw),
    };
  });
}

export async function getKeyMetrics(timezone: string): Promise<KeyMetrics> {
  const supabase = await createClient();
  const monthStart = monthStartIso(timezone);

  const [paidThisMonth, sentInvoices, openJobs, pendingQuotes] = await Promise.all([
    // Revenue this month: sum of paid invoices
    supabase
      .from('invoices')
      .select('amount_cents, tax_cents')
      .eq('status', 'paid')
      .gte('paid_at', monthStart)
      .is('deleted_at', null),
    // Outstanding: sent but unpaid invoices
    supabase
      .from('invoices')
      .select('amount_cents, tax_cents')
      .eq('status', 'sent')
      .is('deleted_at', null),
    // Open jobs count
    supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .in('status', ['booked', 'in_progress'])
      .is('deleted_at', null),
    // Pending quotes count
    supabase
      .from('quotes')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'sent')
      .is('deleted_at', null),
  ]);

  if (paidThisMonth.error) throw new Error(`Metrics: ${paidThisMonth.error.message}`);
  if (sentInvoices.error) throw new Error(`Metrics: ${sentInvoices.error.message}`);
  if (openJobs.error) throw new Error(`Metrics: ${openJobs.error.message}`);
  if (pendingQuotes.error) throw new Error(`Metrics: ${pendingQuotes.error.message}`);

  const revenueThisMonthCents = (paidThisMonth.data ?? []).reduce(
    (sum, inv) => sum + (inv.amount_cents as number) + (inv.tax_cents as number),
    0,
  );

  const outstandingCents = (sentInvoices.data ?? []).reduce(
    (sum, inv) => sum + (inv.amount_cents as number) + (inv.tax_cents as number),
    0,
  );

  return {
    revenueThisMonthCents,
    outstandingCents,
    openJobsCount: openJobs.count ?? 0,
    pendingQuotesCount: pendingQuotes.count ?? 0,
  };
}

export type PipelineMetrics = {
  draftQuoteCount: number;
  draftQuoteValueCents: number;
  sentQuoteCount: number;
  sentQuoteValueCents: number;
  expiredQuoteCount: number;
  expiredQuoteValueCents: number;
  activeProjectCount: number;
  /** Sum of cost-bucket estimates for projects in planning + in_progress. */
  activeProjectValueCents: number;
};

/**
 * Pipeline snapshot for the dashboard: counts + totals for the quote
 * stages the operator is actively working, plus active project count
 * and the aggregate estimate value for those active projects.
 *
 * Quote values come from `quotes.total_cents` (includes tax). Active
 * project value is a two-step: fetch active project ids, then sum the
 * child `project_budget_categories.estimate_cents` rows. Accepts the extra
 * round-trip because Supabase's PostgREST can't do cross-table SUMs.
 */
export async function getPipelineMetrics(): Promise<PipelineMetrics> {
  const supabase = await createClient();

  const [draftQuotes, sentQuotes, expiredQuotes, activeProjectIds] = await Promise.all([
    supabase.from('quotes').select('total_cents').eq('status', 'draft').is('deleted_at', null),
    supabase.from('quotes').select('total_cents').eq('status', 'sent').is('deleted_at', null),
    supabase.from('quotes').select('total_cents').eq('status', 'expired').is('deleted_at', null),
    // "Active projects" on the pipeline card = projects the operator is
    // actively working. Explicitly excludes on_hold / declined / cancelled
    // so weather-paused jobs don't inflate the count.
    supabase
      .from('projects')
      .select('id')
      .in('lifecycle_stage', ['planning', 'awaiting_approval', 'active'])
      .is('deleted_at', null),
  ]);

  if (draftQuotes.error) throw new Error(`Pipeline: ${draftQuotes.error.message}`);
  if (sentQuotes.error) throw new Error(`Pipeline: ${sentQuotes.error.message}`);
  if (expiredQuotes.error) throw new Error(`Pipeline: ${expiredQuotes.error.message}`);
  if (activeProjectIds.error) throw new Error(`Pipeline: ${activeProjectIds.error.message}`);

  const projectIds = (activeProjectIds.data ?? []).map((p) => p.id as string);

  // Skip the second round-trip when there are no active projects.
  let activeProjectValueCents = 0;
  if (projectIds.length > 0) {
    const { data: buckets, error: bucketsErr } = await supabase
      .from('project_budget_categories')
      .select('estimate_cents')
      .in('project_id', projectIds);
    if (bucketsErr) throw new Error(`Pipeline: ${bucketsErr.message}`);
    activeProjectValueCents = (buckets ?? []).reduce(
      (sum, b) => sum + ((b.estimate_cents as number) ?? 0),
      0,
    );
  }

  const sumTotals = (rows: { total_cents: number }[] | null | undefined) =>
    (rows ?? []).reduce((sum, q) => sum + (q.total_cents as number), 0);

  return {
    draftQuoteCount: draftQuotes.data?.length ?? 0,
    draftQuoteValueCents: sumTotals(draftQuotes.data),
    sentQuoteCount: sentQuotes.data?.length ?? 0,
    sentQuoteValueCents: sumTotals(sentQuotes.data),
    expiredQuoteCount: expiredQuotes.data?.length ?? 0,
    expiredQuoteValueCents: sumTotals(expiredQuotes.data),
    activeProjectCount: projectIds.length,
    activeProjectValueCents,
  };
}

export type RenovationPipelineMetrics = {
  planningCount: number;
  planningValueCents: number;
  awaitingApprovalCount: number;
  awaitingApprovalValueCents: number;
  activeCount: number;
  activeValueCents: number;
  completeThisYearCount: number;
};

/**
 * Renovation-vertical pipeline snapshot. All counts/values come from
 * projects (via cost buckets), not quotes — the polygon quoting tool
 * is irrelevant for GCs.
 *
 * Values are summed from `project_budget_categories.estimate_cents` for each
 * stage. Single round-trip to projects, then one to buckets filtered
 * by the project ids we care about. "Complete this year" is a count
 * only (no value) because it's a retrospective metric.
 */
export async function getRenovationPipelineMetrics(
  timezone: string,
): Promise<RenovationPipelineMetrics> {
  const supabase = await createClient();
  const yearStart = new Date(
    new Date().toLocaleString('en-US', { timeZone: timezone }),
  ).getFullYear();
  const yearStartIso = `${yearStart}-01-01T00:00:00.000Z`;

  const [stageRows, completeThisYear] = await Promise.all([
    supabase
      .from('projects')
      .select('id, lifecycle_stage')
      .in('lifecycle_stage', ['planning', 'awaiting_approval', 'active'])
      .is('deleted_at', null),
    supabase
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .eq('lifecycle_stage', 'complete')
      .gte('updated_at', yearStartIso)
      .is('deleted_at', null),
  ]);

  if (stageRows.error) throw new Error(`Renovation pipeline: ${stageRows.error.message}`);
  if (completeThisYear.error)
    throw new Error(`Renovation pipeline: ${completeThisYear.error.message}`);

  const rows = (stageRows.data ?? []) as Array<{ id: string; lifecycle_stage: string }>;
  const idsByStage = new Map<string, string[]>();
  for (const r of rows) {
    const existing = idsByStage.get(r.lifecycle_stage) ?? [];
    existing.push(r.id);
    idsByStage.set(r.lifecycle_stage, existing);
  }

  const allIds = rows.map((r) => r.id);
  let valueByProject = new Map<string, number>();
  if (allIds.length > 0) {
    const { data: buckets, error: bucketsErr } = await supabase
      .from('project_budget_categories')
      .select('project_id, estimate_cents')
      .in('project_id', allIds);
    if (bucketsErr) throw new Error(`Renovation pipeline: ${bucketsErr.message}`);
    valueByProject = new Map();
    for (const b of buckets ?? []) {
      const pid = b.project_id as string;
      valueByProject.set(pid, (valueByProject.get(pid) ?? 0) + ((b.estimate_cents as number) ?? 0));
    }
  }

  const valueForStage = (stage: string): number =>
    (idsByStage.get(stage) ?? []).reduce((s, id) => s + (valueByProject.get(id) ?? 0), 0);

  return {
    planningCount: (idsByStage.get('planning') ?? []).length,
    planningValueCents: valueForStage('planning'),
    awaitingApprovalCount: (idsByStage.get('awaiting_approval') ?? []).length,
    awaitingApprovalValueCents: valueForStage('awaiting_approval'),
    activeCount: (idsByStage.get('active') ?? []).length,
    activeValueCents: valueForStage('active'),
    completeThisYearCount: completeThisYear.count ?? 0,
  };
}

export async function getAttentionItems(timezone: string): Promise<AttentionItem[]> {
  const supabase = await createClient();
  const now = new Date();
  const today = todayDateStr(timezone);
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const [overdueTodos, staleQuotes, overdueInvoices] = await Promise.all([
    // Overdue todos
    supabase
      .from('todos')
      .select('id, title, due_date')
      .eq('done', false)
      .lt('due_date', today)
      .order('due_date', { ascending: true })
      .limit(10),
    // Stale quotes (sent > 3 days ago, no response)
    supabase
      .from('quotes')
      .select('id, sent_at, customers:customer_id (name)')
      .eq('status', 'sent')
      .lt('sent_at', threeDaysAgo)
      .is('deleted_at', null)
      .order('sent_at', { ascending: true })
      .limit(10),
    // Overdue invoices (sent > 14 days ago, unpaid)
    supabase
      .from('invoices')
      .select('id, amount_cents, tax_cents, sent_at, customers:customer_id (name)')
      .eq('status', 'sent')
      .lt('sent_at', fourteenDaysAgo)
      .is('deleted_at', null)
      .order('sent_at', { ascending: true })
      .limit(10),
  ]);

  if (overdueTodos.error) throw new Error(`Attention: ${overdueTodos.error.message}`);
  if (staleQuotes.error) throw new Error(`Attention: ${staleQuotes.error.message}`);
  if (overdueInvoices.error) throw new Error(`Attention: ${overdueInvoices.error.message}`);

  const items: AttentionItem[] = [];

  for (const todo of overdueTodos.data ?? []) {
    const dueDate = (todo as { due_date: string }).due_date;
    items.push({
      kind: 'overdue_todo',
      id: todo.id as string,
      title: (todo as { title: string }).title,
      daysOverdue: daysBetween(`${dueDate}T00:00:00`, now),
    });
  }

  for (const quote of staleQuotes.data ?? []) {
    const row = quote as Record<string, unknown>;
    items.push({
      kind: 'stale_quote',
      id: row.id as string,
      customerName: extractCustomerName(row.customers),
      daysSinceSent: daysBetween(row.sent_at as string, now),
    });
  }

  for (const invoice of overdueInvoices.data ?? []) {
    const row = invoice as Record<string, unknown>;
    items.push({
      kind: 'overdue_invoice',
      id: row.id as string,
      customerName: extractCustomerName(row.customers),
      amountCents: row.amount_cents as number,
      taxCents: row.tax_cents as number,
      daysSinceSent: daysBetween(row.sent_at as string, now),
    });
  }

  // Sort by urgency: overdue todos first, then stale quotes, then overdue invoices
  // Within each kind, already sorted by date (oldest first)
  const kindOrder: Record<AttentionItem['kind'], number> = {
    overdue_todo: 0,
    stale_quote: 1,
    overdue_invoice: 2,
  };
  items.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind]);

  return items;
}

export async function getRecentActivity(): Promise<RecentWorklogEntry[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('worklog_entries')
    .select('id, entry_type, title, created_at, related_type, related_id')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) throw new Error(`Failed to load recent activity: ${error.message}`);

  const rows = (data ?? []) as Array<Omit<RecentWorklogEntry, 'related_name'>>;

  // Hydrate related names in one round-trip per entity type so the UI can
  // render "Project: Graham reno" instead of just "Project created".
  const idsByType = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.related_type || !r.related_id) continue;
    if (!idsByType.has(r.related_type)) idsByType.set(r.related_type, new Set());
    idsByType.get(r.related_type)?.add(r.related_id);
  }

  const nameById = new Map<string, string>();

  const customerIds = idsByType.get('customer');
  if (customerIds?.size) {
    const { data: rows } = await supabase
      .from('customers')
      .select('id, name')
      .in('id', Array.from(customerIds));
    for (const row of rows ?? []) nameById.set(row.id as string, (row as { name: string }).name);
  }

  const projectIds = idsByType.get('project');
  if (projectIds?.size) {
    const { data: rows } = await supabase
      .from('projects')
      .select('id, name')
      .in('id', Array.from(projectIds));
    for (const row of rows ?? []) nameById.set(row.id as string, (row as { name: string }).name);
  }

  const jobIds = idsByType.get('job');
  if (jobIds?.size) {
    const { data: rows } = await supabase
      .from('jobs')
      .select('id, customers:customer_id (name)')
      .in('id', Array.from(jobIds));
    for (const row of rows ?? []) {
      const customerRaw = (row as { customers?: unknown }).customers;
      const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
      const name =
        customer && typeof customer === 'object' && 'name' in customer
          ? (customer as { name: string }).name
          : 'Job';
      nameById.set((row as { id: string }).id, name);
    }
  }

  const quoteIds = idsByType.get('quote');
  if (quoteIds?.size) {
    const { data: rows } = await supabase
      .from('quotes')
      .select('id, customers:customer_id (name)')
      .in('id', Array.from(quoteIds));
    for (const row of rows ?? []) {
      const customerRaw = (row as { customers?: unknown }).customers;
      const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
      const name =
        customer && typeof customer === 'object' && 'name' in customer
          ? (customer as { name: string }).name
          : 'Quote';
      nameById.set((row as { id: string }).id, name);
    }
  }

  const invoiceIds = idsByType.get('invoice');
  if (invoiceIds?.size) {
    const { data: rows } = await supabase
      .from('invoices')
      .select('id, customers:customer_id (name)')
      .in('id', Array.from(invoiceIds));
    for (const row of rows ?? []) {
      const customerRaw = (row as { customers?: unknown }).customers;
      const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
      const name =
        customer && typeof customer === 'object' && 'name' in customer
          ? (customer as { name: string }).name
          : 'Invoice';
      nameById.set((row as { id: string }).id, name);
    }
  }

  return rows.map((r) => ({
    ...r,
    related_name: r.related_id ? (nameById.get(r.related_id) ?? null) : null,
  }));
}

/** Start of current year in UTC (for YTD queries). */
function yearStartIso(timezone: string): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
  });
  const year = formatter.format(now); // "2026"
  const yearStart = new Date(`${year}-01-01T00:00:00`);
  const offsetMs = getTimezoneOffsetMs(timezone, now);
  return new Date(yearStart.getTime() - offsetMs).toISOString();
}

export async function getRevenueYtd(timezone: string): Promise<number> {
  const supabase = await createClient();
  const start = yearStartIso(timezone);

  const { data, error } = await supabase
    .from('invoices')
    .select('amount_cents, tax_cents')
    .eq('status', 'paid')
    .gte('paid_at', start)
    .is('deleted_at', null);

  if (error) throw new Error(`Revenue YTD: ${error.message}`);

  return (data ?? []).reduce(
    (sum, inv) => sum + (inv.amount_cents as number) + (inv.tax_cents as number),
    0,
  );
}

/** Get the hour of day in tenant timezone (0-23). */
export function getHourInTimezone(timezone: string): number {
  const now = new Date();
  const hour = Number(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(now),
  );
  return hour;
}
