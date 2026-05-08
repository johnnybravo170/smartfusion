import {
  CrewScheduleGrid,
  type ScheduleCell,
} from '@/components/features/projects/crew-schedule-grid';
import { CrewTab } from '@/components/features/projects/crew-tab';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { listAssignmentsForProject } from '@/lib/db/queries/project-assignments';
import { getProject } from '@/lib/db/queries/projects';
import { listWorkerProfiles } from '@/lib/db/queries/worker-profiles';
import { listUnavailabilityForTenant, REASON_LABELS } from '@/lib/db/queries/worker-unavailability';

export default async function CrewTabServer({ projectId }: { projectId: string }) {
  const [project, tenant] = await Promise.all([getProject(projectId), getCurrentTenant()]);
  if (!project) return null;
  const tz = tenant?.timezone ?? 'America/Vancouver';

  const [crewAssignments, crewWorkers] = await Promise.all([
    listAssignmentsForProject(project.tenant_id, projectId),
    listWorkerProfiles(project.tenant_id),
  ]);

  // 14-day window starting today (tenant-local).
  const tzFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  const scheduleStart = tzFmt.format(new Date());
  const scheduleEnd = (() => {
    const d = new Date(`${scheduleStart}T00:00`);
    d.setDate(d.getDate() + 13);
    return tzFmt.format(d);
  })();

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

  const scheduleCells: Record<string, ScheduleCell> = {};
  for (const a of crewAssignments) {
    if (!a.scheduled_date) continue;
    if (a.scheduled_date < scheduleStart || a.scheduled_date > scheduleEnd) continue;
    const key = `${a.worker_profile_id}|${a.scheduled_date}`;
    scheduleCells[key] = {
      type: 'scheduled',
      projectName: project.name,
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

  return (
    <div className="space-y-6">
      <CrewScheduleGrid
        projectId={projectId}
        startDate={scheduleStart}
        days={14}
        workers={scheduleWorkers}
        cells={scheduleCells}
      />
      <CrewTab
        projectId={projectId}
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
  );
}
