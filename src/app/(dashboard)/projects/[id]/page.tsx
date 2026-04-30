import { FileText, ImageIcon, Link2, Mic, Palette, Users } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { DeleteProjectButton } from '@/components/features/projects/delete-project-button';
import { PercentCompleteEditor } from '@/components/features/projects/percent-complete-editor';
import { ProjectIntakeZone } from '@/components/features/projects/project-intake-zone';
import { ProjectNameEditor } from '@/components/features/projects/project-name-editor';
import { ProjectStatusBadge } from '@/components/features/projects/project-status-badge';
import { ProjectTabSelect } from '@/components/features/projects/project-tab-select';
import { ScopeDiffReview } from '@/components/features/projects/scope-diff-review';
import BudgetTabServer from '@/components/features/projects/tabs/budget-tab-server';
import ChangeOrdersTabServer from '@/components/features/projects/tabs/change-orders-tab-server';
import CostsTabServer from '@/components/features/projects/tabs/costs-tab-server';
import CrewTabServer from '@/components/features/projects/tabs/crew-tab-server';
import DocumentsTabServer from '@/components/features/projects/tabs/documents-tab-server';
import EstimateTabServer from '@/components/features/projects/tabs/estimate-tab-server';
import GalleryTabServer from '@/components/features/projects/tabs/gallery-tab-server';
import InvoicesTabServer from '@/components/features/projects/tabs/invoices-tab-server';
import MemosTabServer from '@/components/features/projects/tabs/memos-tab-server';
import OverviewTabServer from '@/components/features/projects/tabs/overview-tab-server';
import PortalTabServer from '@/components/features/projects/tabs/portal-tab-server';
import SelectionsTabServer from '@/components/features/projects/tabs/selections-tab-server';
import { TabSkeleton } from '@/components/features/projects/tabs/tab-skeleton';
import TimeTabServer from '@/components/features/projects/tabs/time-tab-server';
import { UnsentChangesChip } from '@/components/features/projects/unsent-changes-chip';
import { VersionsDropdown } from '@/components/features/projects/versions-dropdown';
import { getProjectProgress } from '@/lib/db/queries/cost-lines';
import { getProjectDrawSummary } from '@/lib/db/queries/invoices';
import { listBudgetCategoriesForProject } from '@/lib/db/queries/project-budget-categories';
import { getProject } from '@/lib/db/queries/projects';
import { formatCurrency } from '@/lib/pricing/calculator';
import type { LifecycleStage } from '@/lib/validators/project';

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
  | 'budget'
  | 'estimate'
  | 'costs'
  | 'variance'
  | 'invoices'
  | 'time'
  | 'memos'
  | 'gallery'
  | 'change-orders'
  | 'portal'
  | 'selections'
  | 'documents'
  | 'crew';

/**
 * Project detail shell. Renders the header + tab nav synchronously, then
 * defers each tab's data fetching to its own `<Suspense>`-wrapped server
 * component. Compared to the previous single-page-loads-everything design,
 * this:
 *
 *   - cuts the shell's DB round-trips from ~30 to ~3
 *   - fetches per-tab data only when that tab is active
 *   - streams tab content in, so the header renders in <100ms regardless of
 *     which tab is open
 *
 * Each tab component lives in `src/components/features/projects/tabs/`.
 * They share `getProject` and a few other queries via `React.cache()`, so
 * multiple tabs calling the same query in the same render dedupe.
 */
export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  // Alias: old `?tab=buckets` bookmarks → `budget`. Renamed 2026-04-28.
  const rawTab = resolvedSearchParams.tab;
  const explicitTab = rawTab === 'buckets' ? 'budget' : (rawTab as Tab | undefined);

  // Shell-only queries. getProject is React.cache-wrapped, so generateMetadata
  // + the shell + any inner tab that also calls it (e.g. OverviewTab) dedupe
  // to a single DB hit per request.
  const [project, projectBuckets, progress, draws] = await Promise.all([
    getProject(id),
    listBudgetCategoriesForProject(id),
    getProjectProgress(id),
    getProjectDrawSummary(id),
  ]);
  if (!project) notFound();

  // Stage-aware default tab when the operator hits /projects/[id] without a
  // ?tab=... query. Planning lands on Budget (the work to do); active and
  // beyond land on Overview (the running status). Explicit ?tab=... wins.
  const stage = project.lifecycle_stage as LifecycleStage;
  const defaultTab: Tab =
    stage === 'planning' || stage === 'awaiting_approval' ? 'budget' : 'overview';
  const tab: Tab = explicitTab ?? defaultTab;

  // Tab order follows the project lifecycle: plan (Budget, Estimate) → do
  // (Spend, Time, Changes, Customer Billing) → review (Overview). Slugs
  // stay as-is to avoid breaking deep links + worker-app references; only
  // labels are user-facing.
  const tabs: { key: Tab; label: string }[] = [
    { key: 'budget', label: 'Budget' },
    { key: 'estimate', label: 'Estimate' },
    { key: 'costs', label: 'Spend' },
    { key: 'time', label: 'Time' },
    { key: 'change-orders', label: 'Changes' },
    { key: 'invoices', label: 'Customer Billing' },
    { key: 'overview', label: 'Overview' },
  ];
  const secondaryTabs: {
    key: Tab;
    label: string;
    icon: 'gallery' | 'portal' | 'memos' | 'crew' | 'selections' | 'documents';
  }[] = [
    { key: 'gallery', label: 'Gallery', icon: 'gallery' },
    { key: 'portal', label: 'Portal', icon: 'portal' },
    { key: 'selections', label: 'Selections', icon: 'selections' },
    { key: 'documents', label: 'Documents', icon: 'documents' },
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
            <ProjectStatusBadge stage={project.lifecycle_stage as LifecycleStage} />
            <Suspense fallback={null}>
              <VersionsDropdown projectId={id} />
            </Suspense>
          </div>
          {project.customer ? (
            <p className="mt-1 text-sm text-muted-foreground">
              <Link href={`/contacts/${project.customer.id}`} className="hover:underline">
                {project.customer.name}
              </Link>
            </p>
          ) : null}
          {project.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{project.description}</p>
          ) : null}
          <div className="mt-1">
            <PercentCompleteEditor
              workStatusPct={progress.workStatusPct}
              costBurnPct={progress.costBurnPct}
            />
          </div>
          {draws.has_any ? (
            <p className="mt-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Draws</span>{' '}
              {formatCurrency(draws.sent_cents)} sent
              <span className="mx-1">·</span>
              {formatCurrency(draws.paid_cents)} paid
              {draws.outstanding_cents > 0 ? (
                <>
                  <span className="mx-1">·</span>
                  <span className="font-medium text-amber-700">
                    {formatCurrency(draws.outstanding_cents)} outstanding
                  </span>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {secondaryTabs.map((s) => {
            const active = tab === s.key;
            const Icon =
              s.icon === 'gallery'
                ? ImageIcon
                : s.icon === 'portal'
                  ? Link2
                  : s.icon === 'selections'
                    ? Palette
                    : s.icon === 'documents'
                      ? FileText
                      : s.icon === 'memos'
                        ? Mic
                        : Users;
            return (
              <Link
                key={s.key}
                href={`/projects/${id}?tab=${s.key}`}
                prefetch={false}
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
          <ProjectIntakeZone
            projectId={project.id}
            buckets={projectBuckets.map((b) => ({
              id: b.id,
              name: b.name,
              section: (b.section as 'interior' | 'exterior' | 'general') ?? 'general',
            }))}
          />
          <DeleteProjectButton projectId={project.id} projectName={project.name} />
        </div>
      </header>

      {/* Unsent changes chip — surfaces when working state has diverged
          from the latest signed snapshot. Hidden on legacy / planning
          projects (no snapshot). Streams in its own Suspense so it
          never blocks the tab nav. */}
      <Suspense fallback={null}>
        <UnsentChangesChip projectId={id} />
      </Suspense>

      {/* Diff review modal — opens when ?review=diff is in the URL. */}
      <Suspense fallback={null}>
        <ScopeDiffReview projectId={id} />
      </Suspense>

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
            prefetch={false}
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

      {/* Tab content — each tab streams independently. */}
      <Suspense key={tab} fallback={<TabSkeleton />}>
        {tab === 'overview' ? <OverviewTabServer projectId={id} /> : null}
        {tab === 'budget' ? <BudgetTabServer projectId={id} /> : null}
        {tab === 'estimate' ? <EstimateTabServer projectId={id} /> : null}
        {tab === 'costs' ? <CostsTabServer projectId={id} /> : null}
        {/* Variance merged into Overview — keep route alive for old bookmarks
            but render Overview content. Drop entirely in a future cleanup. */}
        {tab === 'variance' ? <OverviewTabServer projectId={id} /> : null}
        {tab === 'invoices' ? <InvoicesTabServer projectId={id} /> : null}
        {tab === 'time' ? <TimeTabServer projectId={id} /> : null}
        {tab === 'memos' ? <MemosTabServer projectId={id} /> : null}
        {tab === 'gallery' ? <GalleryTabServer projectId={id} /> : null}
        {tab === 'change-orders' ? <ChangeOrdersTabServer projectId={id} /> : null}
        {tab === 'portal' ? <PortalTabServer projectId={id} /> : null}
        {tab === 'selections' ? <SelectionsTabServer projectId={id} /> : null}
        {tab === 'documents' ? <DocumentsTabServer projectId={id} /> : null}
        {tab === 'crew' ? <CrewTabServer projectId={id} /> : null}
      </Suspense>
    </div>
  );
}
