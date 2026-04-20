import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChangeOrderList } from '@/components/features/change-orders/change-order-list';
import { MemoUpload } from '@/components/features/memos/memo-upload';
import { PhotoUpload } from '@/components/features/photos/photo-upload';
import { ProjectPhotoGallery } from '@/components/features/photos/project-photo-gallery';
import { PortalToggle } from '@/components/features/portal/portal-toggle';
import { PortalUpdateForm } from '@/components/features/portal/portal-update-form';
import { BudgetSummaryCard } from '@/components/features/projects/budget-summary';
import { CostBucketsTable } from '@/components/features/projects/cost-buckets-table';
import { CostsTab } from '@/components/features/projects/costs-tab';
import { EstimateTab } from '@/components/features/projects/estimate-tab';
import { InvoicesTab } from '@/components/features/projects/invoices-tab';
import { PercentCompleteEditor } from '@/components/features/projects/percent-complete-editor';
import { ProjectNameEditor } from '@/components/features/projects/project-name-editor';
import { ProjectStatusBadge } from '@/components/features/projects/project-status-badge';
import { TimeExpenseTab } from '@/components/features/projects/time-expense-tab';
import { VarianceTab } from '@/components/features/projects/variance-tab';
import { getChangeOrderSummaryForProject, listChangeOrders } from '@/lib/db/queries/change-orders';
import { getVarianceReport, listCostLines } from '@/lib/db/queries/cost-lines';
import { listExpenses } from '@/lib/db/queries/expenses';
import { listMaterialsCatalog } from '@/lib/db/queries/materials-catalog';
import { listPhotosByProject } from '@/lib/db/queries/photos';
import { listProjectBills } from '@/lib/db/queries/project-bills';
import { getBudgetVsActual } from '@/lib/db/queries/project-buckets';
import { getProject } from '@/lib/db/queries/projects';
import { listPurchaseOrders } from '@/lib/db/queries/purchase-orders';
import { listTimeEntries } from '@/lib/db/queries/time-entries';
import { createClient } from '@/lib/supabase/server';
import type { ProjectStatus } from '@/lib/validators/project';

// Audio transcription of voice memos can take up to ~30s — bump the
// server-action timeout past Vercel's 10s Hobby default.
export const maxDuration = 60;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await getProject(id);
  return { title: project ? `${project.name} — HeyHenry` : 'Project — HeyHenry' };
}

type Tab =
  | 'overview'
  | 'buckets'
  | 'estimate'
  | 'costs'
  | 'variance'
  | 'invoices'
  | 'time'
  | 'memos'
  | 'gallery'
  | 'change-orders'
  | 'portal';

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const tab = (resolvedSearchParams.tab as Tab) || 'overview';

  const project = await getProject(id);
  if (!project) notFound();

  const budget = await getBudgetVsActual(id);

  // Load memos for the memos tab, plus any photos attached to memos on this
  // project so the memo card can show their thumbnails and work-item rows
  // can reference them by index.
  const supabase = await createClient();
  const [{ data: memos }, projectPhotos] = await Promise.all([
    supabase
      .from('project_memos')
      .select('id, status, transcript, ai_extraction, created_at')
      .eq('project_id', id)
      .order('created_at', { ascending: false }),
    listPhotosByProject(id),
  ]);

  const memoPhotosByMemo = new Map<
    string,
    { id: string; url: string | null; caption: string | null }[]
  >();
  for (const p of projectPhotos) {
    if (!p.memo_id) continue;
    const list = memoPhotosByMemo.get(p.memo_id) ?? [];
    list.push({ id: p.id, url: p.url, caption: p.caption });
    memoPhotosByMemo.set(p.memo_id, list);
  }

  // Load time entries and expenses for the time tab
  const [timeEntries, expenses] = await Promise.all([
    listTimeEntries({ project_id: id, limit: 100 }),
    listExpenses({ project_id: id, limit: 100 }),
  ]);

  // Load job cost control data
  const [costLines, purchaseOrders, bills, variance, catalog, changeOrders, coSummary] =
    await Promise.all([
      listCostLines(id),
      listPurchaseOrders(id),
      listProjectBills(id),
      getVarianceReport(id),
      listMaterialsCatalog(),
      listChangeOrders({ projectId: id }),
      getChangeOrderSummaryForProject(id),
    ]);

  // Load project invoices
  const { data: projectInvoices } = await supabase
    .from('invoices')
    .select('id, status, amount_cents, tax_cents, customer_note, created_at')
    .eq('project_id', id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  // Load portal updates
  const { data: portalUpdates } = await supabase
    .from('project_portal_updates')
    .select('id, type, title, body, photo_url, created_at')
    .eq('project_id', id)
    .order('created_at', { ascending: false })
    .limit(50);

  // Access portal columns via raw query since they aren't in the typed ProjectRow yet
  const { data: portalData } = await supabase
    .from('projects')
    .select('portal_slug, portal_enabled')
    .eq('id', id)
    .single();

  const portalEnabled = (portalData?.portal_enabled as boolean) ?? false;
  const portalSlug = (portalData?.portal_slug as string | null) ?? null;

  const coLabel =
    coSummary.pending_count > 0 ? `Change Orders (${coSummary.pending_count})` : 'Change Orders';

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'buckets', label: 'Cost Buckets' },
    { key: 'estimate', label: 'Estimate' },
    { key: 'costs', label: 'POs & Bills' },
    { key: 'variance', label: 'Variance' },
    { key: 'invoices', label: 'Invoices' },
    { key: 'time', label: 'Time & Expenses' },
    { key: 'change-orders', label: coLabel },
    { key: 'memos', label: 'Memos' },
    { key: 'gallery', label: 'Gallery' },
    { key: 'portal', label: 'Portal' },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl">
      {/* Back link */}
      <Link
        href="/projects"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Projects
      </Link>

      {/* Header */}
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <ProjectNameEditor projectId={project.id} name={project.name} />
            <ProjectStatusBadge status={project.status as ProjectStatus} />
          </div>
          {project.customer ? (
            <p className="mt-1 text-sm text-muted-foreground">
              <Link href={`/customers/${project.customer.id}`} className="hover:underline">
                {project.customer.name}
              </Link>
            </p>
          ) : null}
          {project.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{project.description}</p>
          ) : null}
          <div className="mt-1">
            <PercentCompleteEditor project={project} />
          </div>
        </div>
      </header>

      {/* Tab navigation */}
      <div className="mb-6 flex gap-1 border-b">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/projects/${id}?tab=${t.key}`}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-gray-300'
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' ? (
        <div className="space-y-6">
          <BudgetSummaryCard budget={budget} />

          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">Start Date</p>
              <p className="text-sm font-medium">
                {project.start_date
                  ? new Date(project.start_date).toLocaleDateString('en-CA', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })
                  : 'Not set'}
              </p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">Target End</p>
              <p className="text-sm font-medium">
                {project.target_end_date
                  ? new Date(project.target_end_date).toLocaleDateString('en-CA', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })
                  : 'Not set'}
              </p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">Mgmt Fee</p>
              <p className="text-sm font-medium">
                {Math.round(project.management_fee_rate * 100)}%
              </p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">Cost Buckets</p>
              <p className="text-sm font-medium">{project.cost_buckets.length}</p>
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'buckets' ? (
        <CostBucketsTable
          lines={budget.lines}
          projectId={id}
          costLines={costLines}
          catalog={catalog}
        />
      ) : null}

      {tab === 'estimate' ? (
        <EstimateTab
          projectId={id}
          costLines={costLines}
          catalog={catalog}
          managementFeeRate={project.management_fee_rate}
        />
      ) : null}

      {tab === 'costs' ? (
        <CostsTab projectId={id} purchaseOrders={purchaseOrders} bills={bills} />
      ) : null}

      {tab === 'variance' ? <VarianceTab variance={variance} /> : null}

      {tab === 'invoices' ? (
        <InvoicesTab
          projectId={id}
          invoices={(projectInvoices ?? []).map((inv) => ({
            id: inv.id as string,
            status: inv.status as string,
            amount_cents: inv.amount_cents as number,
            tax_cents: inv.tax_cents as number,
            customer_note: inv.customer_note as string | null,
            created_at: inv.created_at as string,
          }))}
        />
      ) : null}

      {tab === 'time' ? (
        <TimeExpenseTab
          projectId={id}
          buckets={project.cost_buckets}
          timeEntries={timeEntries.map((e) => ({
            id: e.id,
            entry_date: e.entry_date,
            hours: Number(e.hours),
            notes: e.notes ?? null,
          }))}
          expenses={expenses.map((e) => ({
            id: e.id,
            expense_date: e.expense_date,
            amount_cents: e.amount_cents,
            vendor: e.vendor ?? null,
            description: e.description ?? null,
          }))}
        />
      ) : null}

      {tab === 'change-orders' ? (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Link
              href={`/projects/${id}/change-orders/new`}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              New Change Order
            </Link>
          </div>
          <ChangeOrderList changeOrders={changeOrders} projectId={id} />
        </div>
      ) : null}

      {tab === 'memos' ? (
        <MemoUpload
          projectId={id}
          memos={(memos ?? []).map((m) => ({
            id: m.id as string,
            status: m.status as string,
            transcript: m.transcript as string | null,
            ai_extraction: m.ai_extraction as Record<string, unknown> | null,
            created_at: m.created_at as string,
            photos: memoPhotosByMemo.get(m.id as string) ?? [],
          }))}
          buckets={budget.lines.map((b) => ({
            id: b.bucket_id,
            name: b.bucket_name,
            section: b.section,
          }))}
        />
      ) : null}

      {tab === 'gallery' ? (
        <div className="space-y-6">
          <PhotoUpload projectId={id} />
          <ProjectPhotoGallery projectId={id} />
        </div>
      ) : null}

      {tab === 'portal' ? (
        <div className="space-y-6">
          <PortalToggle projectId={id} portalEnabled={portalEnabled} portalSlug={portalSlug} />

          {portalEnabled ? (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Portal Updates</h3>
                <PortalUpdateForm projectId={id} />
              </div>

              {(portalUpdates ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No portal updates yet.</p>
              ) : (
                <div className="space-y-3">
                  {(portalUpdates ?? []).map((u) => {
                    const ud = u as Record<string, unknown>;
                    return (
                      <div key={ud.id as string} className="rounded-md border p-3">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                            {ud.type as string}
                          </span>
                          <span className="text-sm font-medium">{ud.title as string}</span>
                          <span className="ml-auto text-xs text-muted-foreground">
                            {new Date(ud.created_at as string).toLocaleDateString('en-CA', {
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                        {ud.body ? (
                          <p className="mt-1 text-sm text-muted-foreground">{ud.body as string}</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
