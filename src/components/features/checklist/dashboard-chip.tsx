import { ListChecks } from 'lucide-react';
import Link from 'next/link';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { listOpenChecklistRollup } from '@/lib/db/queries/project-checklist';

/**
 * Compact rollup pill for the GC dashboard. Hidden when the team checklist
 * is empty across all projects so we don't add noise to the dashboard.
 */
export async function ChecklistDashboardChip() {
  const tenant = await getCurrentTenant();
  if (!tenant) return null;

  const projects = await listOpenChecklistRollup(tenant.id);
  if (projects.length === 0) return null;

  const total = projects.reduce((acc, p) => acc + p.open_count, 0);

  return (
    <Link
      href="/checklists"
      className="inline-flex items-center gap-2 self-start rounded-md border bg-card px-3 py-1.5 text-xs hover:bg-muted"
    >
      <ListChecks className="size-3.5 text-muted-foreground" />
      <span className="font-medium">Team checklist:</span>
      <span className="text-muted-foreground">
        {total} open across {projects.length} {projects.length === 1 ? 'project' : 'projects'}
      </span>
    </Link>
  );
}
