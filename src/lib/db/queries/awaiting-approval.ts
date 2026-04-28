/**
 * Projects whose estimate has been sent to the customer and is waiting
 * on a decision. Powers the dashboard "Awaiting approval" section and
 * the matching sub-tab on /projects.
 *
 * Each row carries enough info to render status at a glance:
 *   - customer + project name
 *   - estimate total (sum of cost-bucket estimates)
 *   - days since sent
 *   - view count + last-viewed timestamp (from public_page_views)
 *
 * All queries are user-scoped so RLS handles tenant isolation.
 */

import { createClient } from '@/lib/supabase/server';

export type AwaitingApprovalProject = {
  id: string;
  name: string;
  customer_name: string | null;
  estimate_sent_at: string;
  total_cents: number;
  view_count: number;
  last_viewed_at: string | null;
  days_since_sent: number;
};

function daysSince(isoTimestamp: string): number {
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

export async function getProjectsAwaitingApproval(): Promise<AwaitingApprovalProject[]> {
  const supabase = await createClient();

  const { data: projects, error } = await supabase
    .from('projects')
    .select('id, name, estimate_sent_at, customers:customer_id (name)')
    .eq('lifecycle_stage', 'awaiting_approval')
    .not('estimate_sent_at', 'is', null)
    .is('deleted_at', null)
    .order('estimate_sent_at', { ascending: true });
  if (error) throw new Error(`Awaiting approval: ${error.message}`);
  if (!projects?.length) return [];

  const ids = projects.map((p) => p.id as string);

  const [{ data: buckets, error: bucketsErr }, { data: views, error: viewsErr }] =
    await Promise.all([
      supabase
        .from('project_budget_categories')
        .select('project_id, estimate_cents')
        .in('project_id', ids),
      supabase
        .from('public_page_views')
        .select('resource_id, viewed_at')
        .eq('resource_type', 'estimate')
        .in('resource_id', ids),
    ]);
  if (bucketsErr) throw new Error(`Awaiting approval: ${bucketsErr.message}`);
  if (viewsErr) throw new Error(`Awaiting approval: ${viewsErr.message}`);

  const totalsBy = new Map<string, number>();
  for (const b of buckets ?? []) {
    const pid = b.project_id as string;
    totalsBy.set(pid, (totalsBy.get(pid) ?? 0) + ((b.estimate_cents as number) ?? 0));
  }

  const viewsBy = new Map<string, { count: number; last: string | null }>();
  for (const v of views ?? []) {
    const pid = v.resource_id as string;
    const cur = viewsBy.get(pid) ?? { count: 0, last: null };
    cur.count++;
    const t = v.viewed_at as string;
    if (!cur.last || t > cur.last) cur.last = t;
    viewsBy.set(pid, cur);
  }

  return projects.map((p) => {
    const customerRaw = p.customers as { name?: string } | { name?: string }[] | null;
    const customerName = Array.isArray(customerRaw)
      ? (customerRaw[0]?.name ?? null)
      : (customerRaw?.name ?? null);
    const vs = viewsBy.get(p.id as string) ?? { count: 0, last: null };
    const sentAt = p.estimate_sent_at as string;
    return {
      id: p.id as string,
      name: p.name as string,
      customer_name: customerName,
      estimate_sent_at: sentAt,
      total_cents: totalsBy.get(p.id as string) ?? 0,
      view_count: vs.count,
      last_viewed_at: vs.last,
      days_since_sent: daysSince(sentAt),
    };
  });
}
