import { TimeExpenseTab } from '@/components/features/projects/time-expense-tab';
import { WorkerInvoicesSection } from '@/components/features/projects/worker-invoices-section';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { getOperatorProfile } from '@/lib/db/queries/profile';
import { getProject } from '@/lib/db/queries/projects';
import { listTimeEntries } from '@/lib/db/queries/time-entries';
import { listInvoicesForProject } from '@/lib/db/queries/worker-invoices';
import { listWorkerProfiles } from '@/lib/db/queries/worker-profiles';
import { getOperatorNamesForTenant } from '@/lib/operator-names';
import { createClient } from '@/lib/supabase/server';

/**
 * Time tab — labour only. Expenses moved to the Costs tab (2026-04-24) so
 * the full cost lifecycle (sub quote → PO → bill → expense) stays together.
 */
export default async function TimeTabServer({ projectId }: { projectId: string }) {
  const [project, user, tenant] = await Promise.all([
    getProject(projectId),
    getCurrentUser(),
    getCurrentTenant(),
  ]);
  if (!project || !tenant) return null;

  const supabase = await createClient();
  const [operatorProfile, timeEntries, workerInvoices, crewWorkers, operatorNames, costLinesRes] =
    await Promise.all([
      user ? getOperatorProfile(tenant.id, user.id) : null,
      listTimeEntries({ project_id: projectId, limit: 100 }),
      listInvoicesForProject(project.tenant_id, projectId),
      listWorkerProfiles(project.tenant_id),
      getOperatorNamesForTenant(project.tenant_id),
      // Cost lines feed the cost-line picker on the Time form so labour
      // can be tagged to a specific line (not just its parent category).
      // Without this, the Budget tab's per-line Spent column never sees
      // category-only labour. Skip zero-priced lines — they're stubs.
      supabase
        .from('project_cost_lines')
        .select('id, label, budget_category_id, line_price_cents')
        .eq('project_id', projectId)
        .order('sort_order')
        .order('created_at'),
    ]);
  const ownerRateCents = operatorProfile?.defaultHourlyRateCents ?? null;
  const costLines = (
    (costLinesRes.data ?? []) as Array<{
      id: string;
      label: string;
      budget_category_id: string | null;
      line_price_cents: number;
    }>
  ).map((l) => ({
    id: l.id,
    label: l.label,
    budget_category_id: l.budget_category_id,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-2 text-sm font-semibold">Worker invoices</h3>
        <WorkerInvoicesSection invoices={workerInvoices} />
      </div>
      <TimeExpenseTab
        projectId={projectId}
        categories={project.budget_categories}
        costLines={costLines}
        ownerRateCents={ownerRateCents}
        showExpenses={false}
        expenses={[]}
        timeEntries={timeEntries.map((e) => {
          const wp = e.worker_profile_id
            ? crewWorkers.find((w) => w.id === e.worker_profile_id)
            : null;
          // Prefer worker display name; otherwise resolve owner/admin from
          // tenant_members + auth email so we don't fall back to
          // "Owner/admin" when the person actually has a name set.
          const posterName =
            wp?.display_name ?? (e.user_id ? operatorNames.get(e.user_id) : undefined) ?? null;
          const cat = e.budget_category_id
            ? project.budget_categories.find((b) => b.id === e.budget_category_id)
            : null;
          return {
            id: e.id,
            entry_date: e.entry_date,
            hours: Number(e.hours),
            notes: e.notes ?? null,
            worker_profile_id: e.worker_profile_id ?? null,
            worker_name: posterName,
            budget_category_id: e.budget_category_id ?? null,
            budget_category_name: cat?.name ?? null,
          };
        })}
      />
    </div>
  );
}
