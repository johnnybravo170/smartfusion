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

import { ProjectStartDateEditor } from '@/components/features/projects/project-start-date-editor';
import { ScheduleBootstrapPanel } from '@/components/features/projects/schedule-bootstrap-panel';
import { ScheduleInteractive } from '@/components/features/projects/schedule-interactive';
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
  const [
    tasks,
    { data: templateRows },
    { data: joinRows },
    { data: phaseRows },
    { data: tradeRows },
    { data: projectMeta },
  ] = await Promise.all([
    listScheduleTasksForProject(projectId),
    supabase.from('project_type_templates').select('id, slug, name, description'),
    supabase.from('project_type_template_trades').select('project_type_template_id'),
    supabase
      .from('project_phases')
      .select('id, name, display_order')
      .eq('project_id', projectId)
      .order('display_order', { ascending: true }),
    supabase.from('trade_templates').select('id, typical_phase'),
    // Pending customer-notify state for the Undo affordance. Only the
    // scheduled_at matters when sent_at and cancelled_at are both null
    // — any other combination = no Undo available.
    // Project metadata — start_date for the editor + timeline anchor;
    // schedule_notify_* for the Undo affordance.
    supabase
      .from('projects')
      .select(
        'start_date, schedule_notify_scheduled_at, schedule_notify_sent_at, schedule_notify_cancelled_at',
      )
      .eq('id', projectId)
      .maybeSingle(),
  ]);

  const pn = projectMeta as Record<string, unknown> | null;
  const startDate = (pn?.start_date as string | null) ?? null;
  const pendingNotifyAt =
    pn &&
    pn.schedule_notify_scheduled_at &&
    !pn.schedule_notify_sent_at &&
    !pn.schedule_notify_cancelled_at
      ? (pn.schedule_notify_scheduled_at as string)
      : null;

  const phases = (phaseRows ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      name: r.name as string,
      display_order: (r.display_order as number) ?? 0,
    };
  });

  // Trade-template typical_phase fallback for tasks whose project uses
  // custom phase names that don't resolve to the canonical color map.
  const tradeTypicalPhaseById = new Map<string, string>();
  for (const tr of tradeRows ?? []) {
    const r = tr as Record<string, unknown>;
    const tp = r.typical_phase as string | null;
    if (tp) tradeTypicalPhaseById.set(r.id as string, tp);
  }

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
    return (
      <div className="space-y-3">
        <ProjectStartDateEditor projectId={projectId} startDate={startDate} />
        <ScheduleBootstrapPanel projectId={projectId} templates={templates} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ProjectStartDateEditor projectId={projectId} startDate={startDate} />
      <ScheduleInteractive
        projectId={projectId}
        tasks={tasks}
        phases={phases}
        tradeTypicalPhase={Object.fromEntries(tradeTypicalPhaseById)}
        pendingNotifyAt={pendingNotifyAt}
      />
    </div>
  );
}
