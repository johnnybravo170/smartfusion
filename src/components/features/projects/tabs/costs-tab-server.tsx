import { CostsTab } from '@/components/features/projects/costs-tab';
import { listCostLines } from '@/lib/db/queries/cost-lines';
import { listExpenses } from '@/lib/db/queries/expenses';
import { listProjectBills } from '@/lib/db/queries/project-bills';
import { listBudgetCategoriesForProject } from '@/lib/db/queries/project-budget-categories';
import { listProjectSubQuotes } from '@/lib/db/queries/project-sub-quotes';
import { getProject } from '@/lib/db/queries/projects';
import { listPurchaseOrders } from '@/lib/db/queries/purchase-orders';
import { listWorkerProfiles } from '@/lib/db/queries/worker-profiles';
import { getOperatorNamesForTenant } from '@/lib/operator-names';
import { createClient } from '@/lib/supabase/server';

export default async function CostsTabServer({ projectId }: { projectId: string }) {
  const project = await getProject(projectId);
  if (!project) return null;

  const [
    purchaseOrders,
    bills,
    subQuotes,
    projectCategories,
    expenses,
    crewWorkers,
    operatorNameByUserId,
    costLines,
  ] = await Promise.all([
    listPurchaseOrders(projectId),
    listProjectBills(projectId),
    listProjectSubQuotes(projectId),
    listBudgetCategoriesForProject(projectId),
    listExpenses({ project_id: projectId, limit: 200 }),
    listWorkerProfiles(project.tenant_id),
    getOperatorNamesForTenant(project.tenant_id),
    listCostLines(projectId),
  ]);

  const costLinesByCategory = new Map<string, Array<{ id: string; label: string }>>();
  for (const l of costLines) {
    if (!l.budget_category_id) continue;
    const arr = costLinesByCategory.get(l.budget_category_id) ?? [];
    arr.push({ id: l.id, label: l.label });
    costLinesByCategory.set(l.budget_category_id, arr);
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

  // Sign bill attachments (receipts bucket — same as expenses).
  const billAttachmentUrls = new Map<string, string>();
  const billPaths = bills
    .map((b) => ({ id: b.id, path: b.attachment_storage_path }))
    .filter((r): r is { id: string; path: string } => !!r.path);
  if (billPaths.length > 0) {
    const { data } = await supabase.storage.from('receipts').createSignedUrls(
      billPaths.map((r) => r.path),
      3600,
    );
    if (data) {
      for (let i = 0; i < data.length; i++) {
        const entry = data[i];
        if (entry?.signedUrl && !entry.error) {
          billAttachmentUrls.set(billPaths[i].id, entry.signedUrl);
        }
      }
    }
  }
  const billItems = bills.map((b) => ({
    ...b,
    attachment_signed_url: billAttachmentUrls.get(b.id) ?? b.receipt_url ?? null,
    attachment_mime_hint: (b.attachment_storage_path?.toLowerCase().endsWith('.pdf')
      ? 'pdf'
      : b.attachment_storage_path || b.receipt_url
        ? 'image'
        : null) as 'image' | 'pdf' | null,
  }));

  // Sign sub-quote attachments (sub-quotes bucket).
  const quoteAttachmentUrls = new Map<string, string>();
  const quotePaths = subQuotes
    .map((q) => ({ id: q.id, path: q.attachment_storage_path }))
    .filter((r): r is { id: string; path: string } => !!r.path);
  if (quotePaths.length > 0) {
    const { data } = await supabase.storage.from('sub-quotes').createSignedUrls(
      quotePaths.map((r) => r.path),
      3600,
    );
    if (data) {
      for (let i = 0; i < data.length; i++) {
        const entry = data[i];
        if (entry?.signedUrl && !entry.error) {
          quoteAttachmentUrls.set(quotePaths[i].id, entry.signedUrl);
        }
      }
    }
  }
  const subQuoteItems = subQuotes.map((q) => ({
    ...q,
    attachment_signed_url: quoteAttachmentUrls.get(q.id) ?? null,
    attachment_mime_hint: (q.attachment_storage_path?.toLowerCase().endsWith('.pdf')
      ? 'pdf'
      : q.attachment_storage_path
        ? 'image'
        : null) as 'image' | 'pdf' | null,
  }));

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
      budget_category_id: e.budget_category_id ?? null,
      cost_line_id: e.cost_line_id ?? null,
      worker_profile_id: e.worker_profile_id ?? null,
      worker_name: posterName,
      receipt_url: expenseReceiptUrls.get(e.id) ?? null,
      receipt_mime_hint: (e.receipt_storage_path?.toLowerCase().endsWith('.pdf')
        ? 'pdf'
        : e.receipt_storage_path || e.receipt_url
          ? 'image'
          : null) as 'image' | 'pdf' | null,
    };
  });

  return (
    <CostsTab
      projectId={projectId}
      purchaseOrders={purchaseOrders}
      bills={billItems}
      subQuotes={subQuoteItems}
      expenses={expenseItems}
      categories={projectCategories.map((b) => ({
        id: b.id,
        name: b.name,
        section: (b.section as 'interior' | 'exterior' | 'general') ?? 'general',
        cost_lines: costLinesByCategory.get(b.id) ?? [],
      }))}
    />
  );
}
