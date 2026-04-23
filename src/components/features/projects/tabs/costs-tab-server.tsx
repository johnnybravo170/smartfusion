import { CostsTab } from '@/components/features/projects/costs-tab';
import { listExpenses } from '@/lib/db/queries/expenses';
import { listProjectBills } from '@/lib/db/queries/project-bills';
import { listBucketsForProject } from '@/lib/db/queries/project-buckets';
import { listProjectSubQuotes } from '@/lib/db/queries/project-sub-quotes';
import { getProject } from '@/lib/db/queries/projects';
import { listPurchaseOrders } from '@/lib/db/queries/purchase-orders';
import { listWorkerProfiles } from '@/lib/db/queries/worker-profiles';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

/**
 * Resolve a display name for an operator account (someone who logged an
 * expense from the dashboard, not a worker with a profile). Priority:
 *   1. "First Last" if tenant_members has the name
 *   2. First name alone
 *   3. Email local part (before @) as a last-resort readable label
 *   4. undefined — caller falls back to "Owner/admin"
 */
function composeOperatorName(params: {
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  email: string | null | undefined;
}): string | undefined {
  const first = params.firstName?.trim();
  const last = params.lastName?.trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  if (params.email) {
    const local = params.email.split('@')[0];
    if (local) return local;
  }
  return undefined;
}

export default async function CostsTabServer({ projectId }: { projectId: string }) {
  const project = await getProject(projectId);
  if (!project) return null;

  const admin = createAdminClient();
  const [
    purchaseOrders,
    bills,
    subQuotes,
    projectBuckets,
    expenses,
    crewWorkers,
    { data: tenantMembers },
  ] = await Promise.all([
    listPurchaseOrders(projectId),
    listProjectBills(projectId),
    listProjectSubQuotes(projectId),
    listBucketsForProject(projectId),
    listExpenses({ project_id: projectId, limit: 200 }),
    listWorkerProfiles(project.tenant_id),
    admin
      .from('tenant_members')
      .select('user_id, first_name, last_name')
      .eq('tenant_id', project.tenant_id),
  ]);

  // Resolve operator names for expenses logged straight from the dashboard
  // (no worker_profile_id). Pull names from tenant_members + emails from
  // auth.users so we never have to fall back to a generic "Owner/admin"
  // when we actually know who posted it.
  const memberUserIds = Array.from(
    new Set((tenantMembers ?? []).map((m) => m.user_id as string).filter(Boolean)),
  );
  const emailByUserId = new Map<string, string>();
  if (memberUserIds.length > 0) {
    // listUsers doesn't filter server-side, so grab a page and match client-side.
    const { data: authPage } = await admin.auth.admin.listUsers({ perPage: 200 });
    for (const u of authPage?.users ?? []) {
      if (u.email && memberUserIds.includes(u.id)) emailByUserId.set(u.id, u.email);
    }
  }
  const operatorNameByUserId = new Map<string, string>();
  for (const m of tenantMembers ?? []) {
    const name = composeOperatorName({
      firstName: m.first_name as string | null,
      lastName: m.last_name as string | null,
      email: emailByUserId.get(m.user_id as string),
    });
    if (name) operatorNameByUserId.set(m.user_id as string, name);
  }

  // Sign receipt URLs for any expense with a storage-backed receipt.
  const supabase = await createClient();
  const expenseReceiptUrls = new Map<string, string>();
  const receiptPaths = expenses
    .map((e) => ({ id: e.id, path: e.receipt_storage_path }))
    .filter((r): r is { id: string; path: string } => !!r.path);
  if (receiptPaths.length > 0) {
    const { data } = await supabase.storage.from('receipts').createSignedUrls(
      receiptPaths.map((r) => r.path),
      3600,
    );
    if (data) {
      for (let i = 0; i < data.length; i++) {
        const entry = data[i];
        if (entry?.signedUrl && !entry.error) {
          expenseReceiptUrls.set(receiptPaths[i].id, entry.signedUrl);
        }
      }
    }
  }
  for (const e of expenses) {
    if (!e.receipt_storage_path && e.receipt_url) {
      expenseReceiptUrls.set(e.id, e.receipt_url);
    }
  }

  const expenseItems = expenses.map((e) => {
    const wp = e.worker_profile_id ? crewWorkers.find((w) => w.id === e.worker_profile_id) : null;
    // Prefer worker display name (if a worker logged it), else the operator's
    // name resolved via tenant_members + auth email. Falls through to the
    // "Owner/admin" label in the component when we genuinely can't resolve.
    const posterName =
      wp?.display_name ?? (e.user_id ? operatorNameByUserId.get(e.user_id) : undefined) ?? null;
    return {
      id: e.id,
      expense_date: e.expense_date,
      amount_cents: e.amount_cents,
      vendor: e.vendor ?? null,
      description: e.description ?? null,
      bucket_id: (e as { bucket_id: string | null }).bucket_id ?? null,
      worker_profile_id: e.worker_profile_id ?? null,
      worker_name: posterName,
      receipt_url: expenseReceiptUrls.get(e.id) ?? null,
    };
  });

  return (
    <CostsTab
      projectId={projectId}
      purchaseOrders={purchaseOrders}
      bills={bills}
      subQuotes={subQuotes}
      expenses={expenseItems}
      buckets={projectBuckets.map((b) => ({
        id: b.id,
        name: b.name,
        section: (b.section as 'interior' | 'exterior' | 'general') ?? 'general',
      }))}
    />
  );
}
