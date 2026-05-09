import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Detect whether a tenant is in "first-run" state — no customers, no
 * projects, no quotes yet. Used by the dashboard to decide whether to
 * show the quickstart hero card. As soon as any of these exists we
 * assume the customer is past the welcome moment and the hero hides.
 *
 * Counts are cheap (head-only with `count: 'exact'`); cached for the
 * duration of the request via React's request memoization at the
 * component level.
 */
export async function isFirstRunTenant(tenantId: string): Promise<boolean> {
  const admin = createAdminClient();
  const [contacts, projects, quotes] = await Promise.all([
    admin.from('customers').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
    admin.from('projects').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
    admin.from('quotes').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
  ]);
  return (contacts.count ?? 0) === 0 && (projects.count ?? 0) === 0 && (quotes.count ?? 0) === 0;
}
