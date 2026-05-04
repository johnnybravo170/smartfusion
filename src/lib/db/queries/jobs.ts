/**
 * Job queries that run through the RLS-aware Supabase server client.
 *
 * Tenant isolation is enforced by `current_tenant_id()` in the `jobs` RLS
 * policies (see `supabase/migrations/0016_all_rls_policies.sql`). We never
 * filter on `tenant_id` in application code; doing so would be redundant and
 * hide RLS failures.
 *
 * Soft-delete: `jobs.deleted_at` is added in 0018. All listers skip
 * soft-deleted rows.
 */

import { createClient } from '@/lib/supabase/server';
import type { JobStatus } from '@/lib/validators/job';

export type JobCustomerSummary = {
  id: string;
  name: string;
  type: 'residential' | 'commercial' | 'agent';
};

export type JobRow = {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  quote_id: string | null;
  status: JobStatus;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type JobWithCustomer = JobRow & {
  customer: JobCustomerSummary | null;
  has_invoice?: boolean;
};

export type JobQuoteSummary = {
  id: string;
  status: string;
  total_cents: number;
  created_at: string;
};

export type JobInvoiceSummary = {
  id: string;
  status: string;
  amount_cents: number;
  tax_cents: number;
  tax_inclusive: boolean;
  created_at: string;
};

export type JobWorklogEntry = {
  id: string;
  entry_type: 'note' | 'system' | 'milestone';
  title: string | null;
  body: string | null;
  created_at: string;
};

export type JobWithRelations = JobWithCustomer & {
  quote: JobQuoteSummary | null;
  invoices: JobInvoiceSummary[];
};

export type JobListFilters = {
  status?: JobStatus;
  customer_id?: string;
  limit?: number;
  offset?: number;
};

export type JobBoardData = {
  booked: JobWithCustomer[];
  in_progress: JobWithCustomer[];
  complete: JobWithCustomer[];
  cancelled: JobWithCustomer[];
};

export type JobStatusCounts = {
  booked: number;
  in_progress: number;
  complete: number;
  cancelled: number;
};

const JOB_COLUMNS =
  'id, tenant_id, customer_id, quote_id, status, scheduled_at, started_at, completed_at, notes, created_at, updated_at, deleted_at';

const JOB_WITH_CUSTOMER_SELECT = `${JOB_COLUMNS}, customers:customer_id (id, name, type)`;

/**
 * Supabase returns the joined `customers` shape as an array when the
 * foreign key cardinality is inferred as one-to-many, or an object when
 * it's one-to-one. We declared a scalar FK so it's an object at runtime,
 * but we defensively handle both forms.
 */
function extractCustomer(raw: unknown): JobCustomerSummary | null {
  if (!raw) return null;
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (!candidate || typeof candidate !== 'object') return null;
  const obj = candidate as Record<string, unknown>;
  if (typeof obj.id !== 'string' || typeof obj.name !== 'string' || typeof obj.type !== 'string') {
    return null;
  }
  return {
    id: obj.id,
    name: obj.name,
    type: obj.type as JobCustomerSummary['type'],
  };
}

function normalizeJob(row: Record<string, unknown>): JobWithCustomer {
  const { customers: customerRaw, ...rest } = row;
  return {
    ...(rest as JobRow),
    customer: extractCustomer(customerRaw),
  };
}

export async function listJobs(filters: JobListFilters = {}): Promise<JobWithCustomer[]> {
  const supabase = await createClient();
  const limit = filters.limit ?? 200;
  const offset = filters.offset ?? 0;

  let query = supabase.from('jobs').select(JOB_WITH_CUSTOMER_SELECT).is('deleted_at', null);

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.customer_id) query = query.eq('customer_id', filters.customer_id);

  const { data, error } = await query
    .order('scheduled_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Failed to list jobs: ${error.message}`);
  }
  return (data ?? []).map((row) => normalizeJob(row as Record<string, unknown>));
}

export async function getJob(id: string): Promise<JobWithRelations | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('jobs')
    .select(
      `${JOB_COLUMNS},
       customers:customer_id (id, name, type),
       quotes:quote_id (id, status, total_cents, created_at)`,
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load job: ${error.message}`);
  }
  if (!data) return null;

  const { customers: customerRaw, quotes: quoteRaw, ...rest } = data as Record<string, unknown>;
  const base: JobRow = rest as JobRow;

  const quoteCandidate = Array.isArray(quoteRaw) ? quoteRaw[0] : quoteRaw;
  const quote: JobQuoteSummary | null =
    quoteCandidate && typeof quoteCandidate === 'object'
      ? {
          id: (quoteCandidate as Record<string, unknown>).id as string,
          status: (quoteCandidate as Record<string, unknown>).status as string,
          total_cents: (quoteCandidate as Record<string, unknown>).total_cents as number,
          created_at: (quoteCandidate as Record<string, unknown>).created_at as string,
        }
      : null;

  const { data: invoiceData, error: invErr } = await supabase
    .from('invoices')
    .select('id, status, amount_cents, tax_cents, tax_inclusive, line_items, created_at')
    .eq('job_id', id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (invErr) {
    throw new Error(`Failed to load job invoices: ${invErr.message}`);
  }

  return {
    ...base,
    customer: extractCustomer(customerRaw),
    quote,
    invoices: (invoiceData ?? []) as JobInvoiceSummary[],
  };
}

export async function countJobsByStatus(): Promise<JobStatusCounts> {
  const supabase = await createClient();
  const { data, error } = await supabase.from('jobs').select('status').is('deleted_at', null);

  if (error) {
    throw new Error(`Failed to count jobs: ${error.message}`);
  }

  const counts: JobStatusCounts = { booked: 0, in_progress: 0, complete: 0, cancelled: 0 };
  for (const row of data ?? []) {
    const s = (row as { status?: string }).status;
    if (s === 'booked' || s === 'in_progress' || s === 'complete' || s === 'cancelled') {
      counts[s] += 1;
    }
  }
  return counts;
}

export async function getBoardData(): Promise<JobBoardData> {
  const supabase = await createClient();
  const jobs = await listJobs({ limit: 500 });

  // Batch query: which jobs have invoices?
  const jobIds = jobs.map((j) => j.id);
  const invoicedJobIds = new Set<string>();
  if (jobIds.length > 0) {
    const { data: invoiceRows } = await supabase
      .from('invoices')
      .select('job_id')
      .in('job_id', jobIds)
      .is('deleted_at', null);
    for (const row of invoiceRows ?? []) {
      if (row.job_id) invoicedJobIds.add(row.job_id as string);
    }
  }

  const board: JobBoardData = {
    booked: [],
    in_progress: [],
    complete: [],
    cancelled: [],
  };
  for (const job of jobs) {
    job.has_invoice = invoicedJobIds.has(job.id);
    board[job.status].push(job);
  }
  return board;
}

export async function listWorklogForJob(jobId: string): Promise<JobWorklogEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('worklog_entries')
    .select('id, entry_type, title, body, created_at')
    .eq('related_type', 'job')
    .eq('related_id', jobId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to load worklog for job: ${error.message}`);
  }
  return (data ?? []) as JobWorklogEntry[];
}
