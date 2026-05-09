import { listScheduleTasksForProject } from '@/lib/db/queries/project-schedule';
import { formatDate } from '../format';
import type { AiTool } from '../types';

export const scheduleTaskTools: AiTool[] = [
  {
    definition: {
      name: 'list_schedule_tasks',
      description:
        'List the project\'s Gantt-schedule tasks (the bars on the Schedule tab). Use this when the operator references a task by name ("electrical", "drywall") so you can resolve it to a task id before updating. Each result shows id, name, start/end dates, duration, status, and confidence (rough = draft / firm = locked). The match against `name` is a case-insensitive substring.',
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project UUID' },
          name: {
            type: 'string',
            description:
              'Optional case-insensitive substring of the task name (e.g. "electrical" matches "Electrical rough-in").',
          },
        },
        required: ['project_id'],
      },
    },
    handler: async (input) => {
      try {
        const projectId = input.project_id as string;
        const nameFilter = (input.name as string | undefined)?.trim().toLowerCase() ?? null;
        const tasks = await listScheduleTasksForProject(projectId);
        const filtered = nameFilter
          ? tasks.filter((t) => t.name.toLowerCase().includes(nameFilter))
          : tasks;
        if (filtered.length === 0) {
          if (tasks.length === 0) {
            return 'This project has no Gantt schedule yet. Ask the operator to bootstrap it from the Schedule tab.';
          }
          return `No tasks matched "${nameFilter}". Tasks on this project: ${tasks.map((t) => t.name).join(', ')}.`;
        }
        let out = `Found ${filtered.length} task(s):\n\n`;
        for (const t of filtered) {
          const start = new Date(`${t.planned_start_date}T00:00:00Z`);
          const end = new Date(start);
          end.setUTCDate(end.getUTCDate() + Math.max(0, t.planned_duration_days - 1));
          out += `- ${t.name} · ${formatDate(t.planned_start_date)} – ${formatDate(end.toISOString().slice(0, 10))} · ${t.planned_duration_days}d · ${t.confidence} · ${t.status}\n`;
          out += `  ID: ${t.id}\n`;
        }
        return out;
      } catch (e) {
        return `Failed to list schedule tasks: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'update_schedule_task',
      description:
        'Patch a Gantt-schedule task — supply only the fields you want to change. Use this when the operator says things like "lock in electrical\'s dates" (set confidence=\'firm\'), "mark drywall done" (status=\'done\'), "hide the inspection day from the customer" (client_visible=false), or "push plumbing to March 18" (planned_start_date=\'2026-03-18\'). When the operator names a task, call list_schedule_tasks first to resolve the id. Date or duration changes auto-cascade to downstream tasks via the dependency graph.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Schedule task UUID. Required.' },
          name: { type: 'string', description: 'New name' },
          planned_start_date: {
            type: 'string',
            description: 'New start date (YYYY-MM-DD). Triggers cascade.',
          },
          planned_duration_days: {
            type: 'number',
            description: 'New duration in days (>=1). Triggers cascade.',
          },
          status: {
            type: 'string',
            enum: ['planned', 'scheduled', 'in_progress', 'done'],
            description:
              'Lifecycle state. Use "in_progress" when work begins, "done" when complete.',
          },
          confidence: {
            type: 'string',
            enum: ['rough', 'firm'],
            description:
              "Date-confidence level. 'rough' = draft (dashed bar), 'firm' = locked (solid bar). Operator says \"lock in the dates\" → set this to 'firm'.",
          },
          client_visible: {
            type: 'boolean',
            description: 'When false, this task is hidden from the customer portal Schedule tab.',
          },
          notes: { type: 'string', description: 'Free-text notes (or empty string to clear).' },
        },
        required: ['id'],
      },
    },
    handler: async (input) => {
      try {
        const { updateScheduleTaskAction } = await import('@/server/actions/project-schedule');
        const id = input.id as string;
        const patch: Record<string, unknown> = {};
        const setIf = <K extends string>(key: K, value: unknown) => {
          if (value !== undefined) patch[key] = value;
        };
        setIf('name', input.name);
        setIf('planned_start_date', input.planned_start_date);
        setIf('planned_duration_days', input.planned_duration_days);
        setIf('status', input.status);
        setIf('confidence', input.confidence);
        setIf('client_visible', input.client_visible);
        if (input.notes !== undefined) {
          patch.notes = input.notes === '' ? null : (input.notes as string);
        }

        if (Object.keys(patch).length === 0) {
          return 'Nothing to update — supply at least one field to change.';
        }

        const res = await updateScheduleTaskAction(id, patch as never);
        if (!res.ok) return `Failed to update task: ${res.error}`;

        const summary = Object.entries(patch)
          .map(([k, v]) => `${k} → ${v === null ? 'cleared' : String(v)}`)
          .join(', ');
        return `Task updated. ${summary}.`;
      } catch (e) {
        return `Failed to update task: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];
