/**
 * Operator's Schedule tab — server entry.
 *
 * Empty state: renders the bootstrap panel (template / budget / blank
 * choice). Populated state: renders the read-only Gantt + a
 * Clear & re-bootstrap escape hatch.
 *
 * v0 is read-only. Drag-to-reschedule + click-to-edit + custom-task
 * creation land in v1 (kanban 6f110321).
 */

import { ScheduleBootstrapPanel } from '@/components/features/projects/schedule-bootstrap-panel';
import { ScheduleClearButton } from '@/components/features/projects/schedule-clear-button';
import { ScheduleGantt } from '@/components/features/projects/schedule-gantt';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { listScheduleTasksForProject } from '@/lib/db/queries/project-schedule';
import { createClient } from '@/lib/supabase/server';

export default async function ScheduleTabServer({ projectId }: { projectId: string }) {
  // Resolve the operator's tenant before kicking off queries — mirrors
  // the working pattern in portal-tab-server / budget-tab-server. The
  // tenant lookup hydrates the Supabase session in this RSC so parallel
  // RLS-gated reads don't run as anon (which would silently return
  // empty arrays for `TO authenticated`-only policies like ours).
  await getCurrentTenant();
  const supabase = await createClient();

  // Tasks + project_type_templates + trade-count rows load in parallel.
  // Trade counts come back as a separate query because the nested-embed
  // syntax (`templates(id)`) was empty in early testing — likely a
  // PostgREST schema-cache lag on freshly-created tables. Two flat
  // queries are robust and basically free for these small lookups.
  const [tasks, { data: templateRows }, { data: joinRows }] = await Promise.all([
    listScheduleTasksForProject(projectId),
    supabase.from('project_type_templates').select('id, slug, name, description'),
    supabase.from('project_type_template_trades').select('project_type_template_id'),
  ]);

  const tradeCountByTemplate = new Map<string, number>();
  for (const j of joinRows ?? []) {
    const k = (j as Record<string, unknown>).project_type_template_id as string;
    tradeCountByTemplate.set(k, (tradeCountByTemplate.get(k) ?? 0) + 1);
  }

  const templates = (templateRows ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const id = r.id as string;
    return {
      id,
      slug: r.slug as string,
      name: r.name as string,
      description: (r.description as string | null) ?? null,
      tradeCount: tradeCountByTemplate.get(id) ?? 0,
    };
  });

  if (tasks.length === 0) {
    return <ScheduleBootstrapPanel projectId={projectId} templates={templates} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} ·{' '}
          <span className="text-foreground">read-only</span> in v0; drag &amp; edit lands in v1.
        </p>
        <ScheduleClearButton projectId={projectId} />
      </div>
      <ScheduleGantt tasks={tasks} />
    </div>
  );
}
