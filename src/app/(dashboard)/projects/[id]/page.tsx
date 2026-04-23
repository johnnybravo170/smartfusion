import { ImageIcon, Link2, Mic, Users } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChangeOrderList } from '@/components/features/change-orders/change-order-list';
import { PhotoUpload } from '@/components/features/photos/photo-upload';
import { ProjectPhotoGallery } from '@/components/features/photos/project-photo-gallery';
import { PortalToggle } from '@/components/features/portal/portal-toggle';
import { PortalUpdateForm } from '@/components/features/portal/portal-update-form';
import { BudgetSummaryCard } from '@/components/features/projects/budget-summary';
import { CloneProjectDialog } from '@/components/features/projects/clone-project-dialog';
import { CostBucketsTable } from '@/components/features/projects/cost-buckets-table';
import { CostsTab } from '@/components/features/projects/costs-tab';
import {
  CrewScheduleGrid,
  type ScheduleCell,
} from '@/components/features/projects/crew-schedule-grid';
import { CrewTab } from '@/components/features/projects/crew-tab';
import { DeleteProjectButton } from '@/components/features/projects/delete-project-button';
import { EstimateTab } from '@/components/features/projects/estimate-tab';
import { InvoicesTab } from '@/components/features/projects/invoices-tab';
import { PercentCompleteEditor } from '@/components/features/projects/percent-complete-editor';
import { ProjectIntakeZone } from '@/components/features/projects/project-intake-zone';
import { ProjectNameEditor } from '@/components/features/projects/project-name-editor';
import {
  type NoteFeedItem,
  ProjectNotesTab,
} from '@/components/features/projects/project-notes-tab';
import { ProjectStatusBadge } from '@/components/features/projects/project-status-badge';
import { ProjectTabSelect } from '@/components/features/projects/project-tab-select';
import { ProjectTimeline } from '@/components/features/projects/project-timeline';
import { TimeExpenseTab } from '@/components/features/projects/time-expense-tab';
import { VarianceTab } from '@/components/features/projects/variance-tab';
import { WorkerInvoicesSection } from '@/components/features/projects/worker-invoices-section';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { getChangeOrderSummaryForProject, listChangeOrders } from '@/lib/db/queries/change-orders';
import { getVarianceReport, listCostLines } from '@/lib/db/queries/cost-lines';
import { listCustomers } from '@/lib/db/queries/customers';
import { listExpenses } from '@/lib/db/queries/expenses';
import { listMaterialsCatalog } from '@/lib/db/queries/materials-catalog';
import { listPhotosByProject } from '@/lib/db/queries/photos';
import { getOperatorProfile } from '@/lib/db/queries/profile';
import { listAssignmentsForProject } from '@/lib/db/queries/project-assignments';
import { listProjectBills } from '@/lib/db/queries/project-bills';
import { getBudgetVsActual, listBucketsForProject } from '@/lib/db/queries/project-buckets';
import { getEstimateViewStats, listProjectEvents } from '@/lib/db/queries/project-events';
import { listProjectSubQuotes } from '@/lib/db/queries/project-sub-quotes';
import { getProject } from '@/lib/db/queries/projects';
import { listPurchaseOrders } from '@/lib/db/queries/purchase-orders';
import { listTimeEntries } from '@/lib/db/queries/time-entries';
import { listInvoicesForProject } from '@/lib/db/queries/worker-invoices';
import { listWorkerProfiles } from '@/lib/db/queries/worker-profiles';
import { listUnavailabilityForTenant, REASON_LABELS } from '@/lib/db/queries/worker-unavailability';
import { getSignedUrls } from '@/lib/storage/photos';
import { createAdminClient } from '@/lib/supabase/admin';
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
  | 'portal'
  | 'crew';

function buildNotesFeed(input: {
  notes: Array<Record<string, unknown>> | null;
  memos: Array<Record<string, unknown>> | null;
  events: Array<Record<string, unknown>> | null;
  artifactUrls: Map<string, string>;
}): NoteFeedItem[] {
  const items: NoteFeedItem[] = [];
  for (const n of input.notes ?? []) {
    const k = (n.kind as string) ?? 'text';
    if (k === 'reply_draft') {
      items.push({
        kind: 'reply_draft',
        id: n.id as string,
        created_at: n.created_at as string,
        body: n.body as string,
      });
    } else if (k === 'henry_q') {
      items.push({
        kind: 'henry_q',
        id: n.id as string,
        created_at: n.created_at as string,
        body: n.body as string,
      });
    } else if (k === 'henry_a') {
      items.push({
        kind: 'henry_a',
        id: n.id as string,
        created_at: n.created_at as string,
        body: n.body as string,
      });
    } else if (k === 'artifact') {
      const meta = (n.metadata as Record<string, unknown> | null) ?? {};
      const imagePath = (meta.image_path as string | undefined) ?? null;
      items.push({
        kind: 'artifact',
        id: n.id as string,
        created_at: n.created_at as string,
        body: n.body as string,
        artifact_kind: (meta.kind as string) ?? 'sketch',
        label: (meta.label as string) ?? 'Reference',
        image_url: imagePath ? (input.artifactUrls.get(imagePath) ?? null) : null,
      });
    } else {
      items.push({
        kind: 'note',
        id: n.id as string,
        created_at: n.created_at as string,
        body: n.body as string,
        author_name: null,
      });
    }
  }
  for (const m of input.memos ?? []) {
    items.push({
      kind: 'memo',
      id: m.id as string,
      created_at: m.created_at as string,
      transcript: (m.transcript as string | null) ?? null,
      status: (m.status as string) ?? 'ready',
    });
  }
  for (const e of input.events ?? []) {
    items.push({
      kind: 'event',
      id: e.id as string,
      created_at: e.created_at as string,
      title: (e.title as string | null) ?? null,
      body: (e.body as string | null) ?? null,
      entry_type: (e.entry_type as string) ?? 'system',
    });
  }
  // Newest first.
  items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return items;
}

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

  const [budget, tenant, currentUser] = await Promise.all([
    getBudgetVsActual(id),
    getCurrentTenant(),
    getCurrentUser(),
  ]);
  const operatorProfile =
    tenant && currentUser ? await getOperatorProfile(tenant.id, currentUser.id) : null;
  const ownerRateCents = operatorProfile?.defaultHourlyRateCents ?? null;

  // Load memos + project photos + project notes + project-scoped worklog
  // events. The Notes tab merges the last three sources chronologically.
  const supabase = await createClient();
  const [{ data: memos }, projectPhotos, { data: notes }, { data: events }] = await Promise.all([
    supabase
      .from('project_memos')
      .select('id, status, transcript, ai_extraction, created_at')
      .eq('project_id', id)
      .order('created_at', { ascending: false }),
    listPhotosByProject(id),
    supabase
      .from('project_notes')
      .select('id, body, created_at, user_id, kind, metadata')
      .eq('project_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('worklog_entries')
      .select('id, title, body, entry_type, created_at')
      .eq('related_type', 'project')
      .eq('related_id', id)
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  // Sign all artifact image paths up front so the Notes feed can render
  // thumbnails without per-card round trips.
  const artifactPaths = (notes ?? [])
    .filter((n) => (n.kind as string | undefined) === 'artifact')
    .map((n) => (n.metadata as { image_path?: string } | null)?.image_path)
    .filter((p): p is string => !!p);
  const artifactUrls = await getSignedUrls(artifactPaths);

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
  const [timeEntries, expenses, workerInvoices] = await Promise.all([
    listTimeEntries({ project_id: id, limit: 100 }),
    listExpenses({ project_id: id, limit: 100 }),
    listInvoicesForProject(project.tenant_id, id),
  ]);

  // Load job cost control data
  const [
    costLines,
    purchaseOrders,
    bills,
    subQuotes,
    variance,
    catalog,
    changeOrders,
    coSummary,
    projectEvents,
    estimateViewStats,
  ] = await Promise.all([
    listCostLines(id),
    listPurchaseOrders(id),
    listProjectBills(id),
    listProjectSubQuotes(id),
    getVarianceReport(id),
    listMaterialsCatalog(),
    listChangeOrders({ projectId: id }),
    getChangeOrderSummaryForProject(id),
    listProjectEvents(id),
    getEstimateViewStats(id),
  ]);

  const [crewAssignments, crewWorkers, projectBuckets, allCustomers] = await Promise.all([
    listAssignmentsForProject(project.tenant_id, id),
    listWorkerProfiles(project.tenant_id),
    listBucketsForProject(id),
    listCustomers({ limit: 500 }),
  ]);
  // Lookup map for the estimate tab's grouping (bucket_id → name/section/order).
  const bucketsById: Record<string, { name: string; section: string | null; order: number }> = {};
  for (const b of projectBuckets) {
    bucketsById[b.id] = { name: b.name, section: b.section ?? null, order: b.display_order };
  }

  // Customer feedback on the estimate. Attach line labels so the operator
  // sees which item each comment refers to.
  const { data: feedbackRowsRaw } = await supabase
    .from('project_estimate_comments')
    .select('id, body, cost_line_id, seen_at, created_at')
    .eq('project_id', id)
    .order('created_at', { ascending: false });
  const costLineLabelById = new Map(costLines.map((l) => [l.id, l.label]));
  const feedbackRows = (feedbackRowsRaw ?? []).map((r) => ({
    id: r.id as string,
    body: r.body as string,
    cost_line_id: (r.cost_line_id as string | null) ?? null,
    cost_line_label: r.cost_line_id
      ? (costLineLabelById.get(r.cost_line_id as string) ?? null)
      : null,
    seen_at: (r.seen_at as string | null) ?? null,
    created_at: r.created_at as string,
  }));
  const unseenFeedbackCount = feedbackRows.filter((f) => !f.seen_at).length;

  // Sign receipt URLs for any expense with a storage-backed receipt.
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

  // Sign cost-line photos (private `photos` bucket). Use the service-role
  // admin client to sign — the authed client silently returns no URLs under
  // storage RLS even when the user legitimately owns the objects (same
  // pattern as the showcase and portal flows).
  const costLinePhotoUrls: Record<string, string> = {};
  const costLinePhotoPaths = Array.from(
    new Set(costLines.flatMap((l) => l.photo_storage_paths ?? [])),
  );
  if (costLinePhotoPaths.length > 0) {
    const admin = createAdminClient();
    const { data: signed } = await admin.storage
      .from('photos')
      .createSignedUrls(costLinePhotoPaths, 3600);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) costLinePhotoUrls[row.path] = row.signedUrl;
    }
  }

  // Build a 14-day crew schedule grid starting today.
  const scheduleStart = new Date().toLocaleDateString('en-CA');
  const scheduleEnd = (() => {
    const d = new Date(`${scheduleStart}T00:00`);
    d.setDate(d.getDate() + 13);
    return d.toLocaleDateString('en-CA');
  })();

  // Workers on this project = anyone with an assignment on it.
  const scheduleWorkerIds = Array.from(new Set(crewAssignments.map((a) => a.worker_profile_id)));
  const scheduleWorkers = scheduleWorkerIds
    .map((wid) => {
      const w = crewWorkers.find((x) => x.id === wid);
      return w ? { profile_id: w.id, display_name: w.display_name ?? 'Worker' } : null;
    })
    .filter((x): x is { profile_id: string; display_name: string } => x !== null);

  const tenantUnavailability = scheduleWorkerIds.length
    ? await listUnavailabilityForTenant(project.tenant_id, scheduleStart, scheduleEnd)
    : [];

  const projectNameById = new Map<string, string>([[id, project.name]]);
  const scheduleCells: Record<string, ScheduleCell> = {};
  for (const a of crewAssignments) {
    if (!a.scheduled_date) continue;
    if (a.scheduled_date < scheduleStart || a.scheduled_date > scheduleEnd) continue;
    const key = `${a.worker_profile_id}|${a.scheduled_date}`;
    scheduleCells[key] = {
      type: 'scheduled',
      projectName: projectNameById.get(id) ?? project.name,
    };
  }
  for (const u of tenantUnavailability) {
    if (!scheduleWorkerIds.includes(u.worker_profile_id)) continue;
    const key = `${u.worker_profile_id}|${u.unavailable_date}`;
    const existing = scheduleCells[key];
    const label = REASON_LABELS[u.reason_tag];
    if (existing && existing.type === 'scheduled') {
      scheduleCells[key] = {
        type: 'both',
        projectName: existing.projectName,
        reasonLabel: label,
        reasonTag: u.reason_tag,
        reasonText: u.reason_text,
      };
    } else {
      scheduleCells[key] = {
        type: 'unavailable',
        reasonLabel: label,
        reasonTag: u.reason_tag,
        reasonText: u.reason_text,
      };
    }
  }

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

  // Core-workflow tabs stay in the main nav. Secondary resource views
  // (Gallery, Portal, Memos, Crew) move up to icon buttons in the header
  // so the tab row stays tight.
  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'buckets', label: 'Cost Buckets' },
    {
      key: 'estimate',
      label: unseenFeedbackCount > 0 ? `Estimate (${unseenFeedbackCount})` : 'Estimate',
    },
    { key: 'costs', label: 'Costs' },
    { key: 'variance', label: 'Variance' },
    { key: 'invoices', label: 'Invoices' },
    { key: 'time', label: 'Time & Expenses' },
    { key: 'change-orders', label: coLabel },
  ];
  const secondaryTabs: {
    key: Tab;
    label: string;
    icon: 'gallery' | 'portal' | 'memos' | 'crew';
  }[] = [
    { key: 'gallery', label: 'Gallery', icon: 'gallery' },
    { key: 'portal', label: 'Portal', icon: 'portal' },
    { key: 'memos', label: 'Notes', icon: 'memos' },
    { key: 'crew', label: 'Crew', icon: 'crew' },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl">
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
        <div className="flex items-center gap-1">
          {secondaryTabs.map((s) => {
            const active = tab === s.key;
            const Icon =
              s.icon === 'gallery'
                ? ImageIcon
                : s.icon === 'portal'
                  ? Link2
                  : s.icon === 'memos'
                    ? Mic
                    : Users;
            return (
              <Link
                key={s.key}
                href={`/projects/${id}?tab=${s.key}`}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                  active
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <Icon className="size-3.5" />
                {s.label}
              </Link>
            );
          })}
          <ProjectIntakeZone projectId={project.id} />
          <CloneProjectDialog
            projectId={project.id}
            projectName={project.name}
            defaultCustomerId={project.customer_id}
            customers={allCustomers.map((c) => ({ id: c.id, name: c.name }))}
          />
          <DeleteProjectButton projectId={project.id} projectName={project.name} />
        </div>
      </header>

      {/* Tab navigation: <select> dropdown on narrow screens, full row above
          the lg breakpoint. */}
      <div className="mb-6 lg:hidden">
        <ProjectTabSelect
          projectId={id}
          currentTab={tab}
          tabs={[...tabs, ...secondaryTabs.map((s) => ({ key: s.key, label: s.label }))]}
        />
      </div>
      <div className="mb-6 hidden flex-wrap gap-1 border-b lg:flex">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/projects/${id}?tab=${t.key}`}
            className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:border-gray-300 hover:text-foreground'
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

          <ProjectTimeline events={projectEvents} />
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
          costLinePhotoUrls={costLinePhotoUrls}
          managementFeeRate={project.management_fee_rate}
          feedback={feedbackRows}
          bucketsById={bucketsById}
          approval={{
            status: project.estimate_status,
            approval_code: project.estimate_approval_code,
            sent_at: project.estimate_sent_at,
            approved_at: project.estimate_approved_at,
            approved_by_name: project.estimate_approved_by_name,
            declined_at: project.estimate_declined_at,
            declined_reason: project.estimate_declined_reason,
            view_count: estimateViewStats.total,
            last_viewed_at: estimateViewStats.last_viewed_at,
          }}
        />
      ) : null}

      {tab === 'costs' ? (
        <CostsTab
          projectId={id}
          purchaseOrders={purchaseOrders}
          bills={bills}
          subQuotes={subQuotes}
          buckets={projectBuckets.map((b) => ({
            id: b.id,
            name: b.name,
            section: (b.section as 'interior' | 'exterior' | 'general') ?? 'general',
          }))}
        />
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
        <div className="space-y-6">
          <div>
            <h3 className="mb-2 text-sm font-semibold">Worker invoices</h3>
            <WorkerInvoicesSection invoices={workerInvoices} />
          </div>
          <TimeExpenseTab
            projectId={id}
            buckets={project.cost_buckets}
            ownerRateCents={ownerRateCents}
            timeEntries={timeEntries.map((e) => {
              const wp = e.worker_profile_id
                ? crewWorkers.find((w) => w.id === e.worker_profile_id)
                : null;
              return {
                id: e.id,
                entry_date: e.entry_date,
                hours: Number(e.hours),
                notes: e.notes ?? null,
                worker_profile_id: e.worker_profile_id ?? null,
                worker_name: wp?.display_name ?? null,
              };
            })}
            expenses={expenses.map((e) => {
              const wp = e.worker_profile_id
                ? crewWorkers.find((w) => w.id === e.worker_profile_id)
                : null;
              return {
                id: e.id,
                expense_date: e.expense_date,
                amount_cents: e.amount_cents,
                vendor: e.vendor ?? null,
                description: e.description ?? null,
                bucket_id: (e as { bucket_id: string | null }).bucket_id ?? null,
                worker_profile_id: e.worker_profile_id ?? null,
                worker_name: wp?.display_name ?? null,
                receipt_url: expenseReceiptUrls.get(e.id) ?? null,
              };
            })}
          />
        </div>
      ) : null}

      {tab === 'crew' ? (
        <div className="space-y-6">
          <CrewScheduleGrid
            projectId={id}
            startDate={scheduleStart}
            days={14}
            workers={scheduleWorkers}
            cells={scheduleCells}
          />
          <CrewTab
            projectId={id}
            workers={crewWorkers.map((w) => ({
              profile_id: w.id,
              display_name: w.display_name ?? 'Worker',
              worker_type: w.worker_type,
              default_hourly_rate_cents: w.default_hourly_rate_cents,
              default_charge_rate_cents: w.default_charge_rate_cents,
            }))}
            assignments={crewAssignments.map((a) => ({
              id: a.id,
              worker_profile_id: a.worker_profile_id,
              scheduled_date: a.scheduled_date,
              hourly_rate_cents: a.hourly_rate_cents,
              charge_rate_cents: a.charge_rate_cents,
              notes: a.notes,
            }))}
          />
        </div>
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
        <ProjectNotesTab
          projectId={id}
          feed={buildNotesFeed({ notes, memos, events, artifactUrls })}
          memoUploadProps={{
            projectId: id,
            memos: (memos ?? []).map((m) => ({
              id: m.id as string,
              status: m.status as string,
              transcript: m.transcript as string | null,
              ai_extraction: m.ai_extraction as Record<string, unknown> | null,
              created_at: m.created_at as string,
              photos: memoPhotosByMemo.get(m.id as string) ?? [],
            })),
            buckets: budget.lines.map((b) => ({
              id: b.bucket_id,
              name: b.bucket_name,
              section: b.section,
            })),
          }}
        />
      ) : null}

      {tab === 'gallery' ? (
        <div className="space-y-6">
          <PhotoUpload projectId={id} />
          <ProjectPhotoGallery projectId={id} tenantId={project.tenant_id} />
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
