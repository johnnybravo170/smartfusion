/**
 * Admin queries that bypass RLS via the service-role Supabase client.
 *
 * These are platform-level queries for Jonathan's admin dashboard. They reach
 * across all tenants and should NEVER be exposed to operator-facing routes.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { demoExclusionList, getDemoTenantIds } from '@/lib/tenants/demo';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlatformStats = {
  totalTenants: number;
  totalJobs: number;
  totalRevenueCents: number;
  activeTenantsLast30Days: number;
};

export type TenantListRow = {
  id: string;
  name: string;
  ownerEmail: string | null;
  createdAt: string;
  jobCount: number;
  revenueCents: number;
  lastActive: string | null;
  stripeConnected: boolean;
  isDemo: boolean;
};

export type TenantDetailData = {
  id: string;
  name: string;
  slug: string | null;
  ownerEmail: string | null;
  createdAt: string;
  timezone: string;
  currency: string;
  province: string | null;
  stripeAccountId: string | null;
  stripeOnboardedAt: string | null;
  stats: {
    customers: number;
    quotes: number;
    jobs: number;
    invoices: number;
    photos: number;
  };
  recentActivity: Array<{
    id: string;
    entryType: string;
    title: string | null;
    body: string | null;
    relatedType: string | null;
    createdAt: string;
  }>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a map of user_id -> email using the admin auth API.
 * Supabase paginates listUsers at 1000 per page; fine for early stage.
 */
async function getUserEmailMap(
  admin: ReturnType<typeof createAdminClient>,
): Promise<Map<string, string>> {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const map = new Map<string, string>();
  for (const u of data.users) {
    if (u.email) map.set(u.id, u.email);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getPlatformStats(): Promise<PlatformStats> {
  const admin = createAdminClient();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // QA / demo tenants are excluded from every platform aggregate. Tables
  // with a tenant_id get a `not in (...)` filter; the tenants table itself
  // filters on is_demo directly.
  const exclude = demoExclusionList(await getDemoTenantIds());

  const tenantsQ = admin
    .from('tenants')
    .select('*', { count: 'exact', head: true })
    .is('deleted_at', null)
    .not('is_demo', 'is', true);
  let jobsQ = admin.from('jobs').select('*', { count: 'exact', head: true }).is('deleted_at', null);
  let paidInvoicesQ = admin
    .from('invoices')
    .select('amount_cents')
    .eq('status', 'paid')
    .is('deleted_at', null);
  // Active tenants: had a job created in last 30 days
  let activeJobsQ = admin
    .from('jobs')
    .select('tenant_id')
    .gte('created_at', thirtyDaysAgo)
    .is('deleted_at', null);
  // Active tenants: had a worklog entry in last 30 days
  let activeWorklogQ = admin
    .from('worklog_entries')
    .select('tenant_id')
    .gte('created_at', thirtyDaysAgo);
  if (exclude) {
    jobsQ = jobsQ.not('tenant_id', 'in', exclude);
    paidInvoicesQ = paidInvoicesQ.not('tenant_id', 'in', exclude);
    activeJobsQ = activeJobsQ.not('tenant_id', 'in', exclude);
    activeWorklogQ = activeWorklogQ.not('tenant_id', 'in', exclude);
  }

  const [tenantsRes, jobsRes, paidInvoicesRes, activeJobsRes, activeWorklogRes] = await Promise.all(
    [tenantsQ, jobsQ, paidInvoicesQ, activeJobsQ, activeWorklogQ],
  );

  const totalRevenueCents = (paidInvoicesRes.data ?? []).reduce(
    (sum, row) => sum + (row.amount_cents ?? 0),
    0,
  );

  // Unique tenant IDs with activity in last 30 days
  const activeTenantIds = new Set<string>();
  for (const row of activeJobsRes.data ?? []) activeTenantIds.add(row.tenant_id);
  for (const row of activeWorklogRes.data ?? []) activeTenantIds.add(row.tenant_id);

  return {
    totalTenants: tenantsRes.count ?? 0,
    totalJobs: jobsRes.count ?? 0,
    totalRevenueCents,
    activeTenantsLast30Days: activeTenantIds.size,
  };
}

export async function listTenantsWithStats(): Promise<TenantListRow[]> {
  const admin = createAdminClient();

  // Fetch all tenants
  // Demo tenants stay in the list (you need to find the QA account) but
  // are flagged so the UI can badge them and skip them in any rollup.
  const { data: tenants, error: tenantErr } = await admin
    .from('tenants')
    .select('id, name, stripe_account_id, created_at, is_demo')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (tenantErr) throw tenantErr;
  if (!tenants?.length) return [];

  // Fetch owner user_ids from tenant_members
  const { data: members } = await admin
    .from('tenant_members')
    .select('tenant_id, user_id, role')
    .eq('role', 'owner');

  // Build email map
  const emailMap = await getUserEmailMap(admin);

  // Fetch aggregated job counts per tenant
  const { data: allJobs } = await admin.from('jobs').select('tenant_id').is('deleted_at', null);

  // Fetch paid invoices for revenue per tenant
  const { data: paidInvoices } = await admin
    .from('invoices')
    .select('tenant_id, amount_cents')
    .eq('status', 'paid')
    .is('deleted_at', null);

  // Fetch last activity: most recent worklog entry per tenant
  const { data: recentWorklog } = await admin
    .from('worklog_entries')
    .select('tenant_id, created_at')
    .order('created_at', { ascending: false });

  // Fetch last job created per tenant
  const { data: recentJobs } = await admin
    .from('jobs')
    .select('tenant_id, created_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  // Build lookup maps
  const ownerMap = new Map<string, string>();
  for (const m of members ?? []) {
    ownerMap.set(m.tenant_id, m.user_id);
  }

  const jobCountMap = new Map<string, number>();
  for (const j of allJobs ?? []) {
    jobCountMap.set(j.tenant_id, (jobCountMap.get(j.tenant_id) ?? 0) + 1);
  }

  const revenueMap = new Map<string, number>();
  for (const inv of paidInvoices ?? []) {
    revenueMap.set(inv.tenant_id, (revenueMap.get(inv.tenant_id) ?? 0) + (inv.amount_cents ?? 0));
  }

  const lastActivityMap = new Map<string, string>();
  for (const w of recentWorklog ?? []) {
    if (!lastActivityMap.has(w.tenant_id)) lastActivityMap.set(w.tenant_id, w.created_at);
  }
  for (const j of recentJobs ?? []) {
    const existing = lastActivityMap.get(j.tenant_id);
    if (!existing || j.created_at > existing) {
      lastActivityMap.set(j.tenant_id, j.created_at);
    }
  }

  const rows: TenantListRow[] = tenants.map((t) => {
    const ownerUserId = ownerMap.get(t.id);
    return {
      id: t.id,
      name: t.name,
      ownerEmail: ownerUserId ? (emailMap.get(ownerUserId) ?? null) : null,
      createdAt: t.created_at,
      jobCount: jobCountMap.get(t.id) ?? 0,
      revenueCents: revenueMap.get(t.id) ?? 0,
      lastActive: lastActivityMap.get(t.id) ?? null,
      stripeConnected: !!t.stripe_account_id,
      isDemo: !!t.is_demo,
    };
  });

  // Sort by most recently active first (nulls last)
  rows.sort((a, b) => {
    if (!a.lastActive && !b.lastActive) return 0;
    if (!a.lastActive) return 1;
    if (!b.lastActive) return -1;
    return b.lastActive.localeCompare(a.lastActive);
  });

  return rows;
}

export async function getTenantDetail(tenantId: string): Promise<TenantDetailData | null> {
  const admin = createAdminClient();

  // Fetch tenant
  const { data: tenant, error: tenantErr } = await admin
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .is('deleted_at', null)
    .maybeSingle();

  if (tenantErr) throw tenantErr;
  if (!tenant) return null;

  // Fetch owner email
  const { data: ownerMember } = await admin
    .from('tenant_members')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('role', 'owner')
    .maybeSingle();

  let ownerEmail: string | null = null;
  if (ownerMember?.user_id) {
    const emailMap = await getUserEmailMap(admin);
    ownerEmail = emailMap.get(ownerMember.user_id) ?? null;
  }

  // Fetch counts in parallel
  const [customersRes, quotesRes, jobsRes, invoicesRes, photosRes, worklogRes] = await Promise.all([
    admin
      .from('customers')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .is('deleted_at', null),
    admin
      .from('quotes')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .is('deleted_at', null),
    admin
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .is('deleted_at', null),
    admin
      .from('invoices')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .is('deleted_at', null),
    admin.from('photos').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId),
    admin
      .from('worklog_entries')
      .select('id, entry_type, title, body, related_type, created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    ownerEmail,
    createdAt: tenant.created_at,
    timezone: tenant.timezone,
    currency: tenant.currency,
    province: tenant.province,
    stripeAccountId: tenant.stripe_account_id,
    stripeOnboardedAt: tenant.stripe_onboarded_at,
    stats: {
      customers: customersRes.count ?? 0,
      quotes: quotesRes.count ?? 0,
      jobs: jobsRes.count ?? 0,
      invoices: invoicesRes.count ?? 0,
      photos: photosRes.count ?? 0,
    },
    recentActivity: (worklogRes.data ?? []).map((w) => ({
      id: w.id,
      entryType: w.entry_type,
      title: w.title,
      body: w.body,
      relatedType: w.related_type,
      createdAt: w.created_at,
    })),
  };
}
