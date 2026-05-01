/**
 * Henry tools — Tasks module.
 *
 * Conventions:
 *   - Henry-initiated creates and updates stamp `created_by='henry'` so the
 *     audit trail tells you which rows came from the assistant. (`created_by`
 *     is TEXT in the schema, not a UUID FK — see migration 0118.)
 *   - Henry NEVER auto-assigns; the `assign_task` tool requires explicit
 *     owner confirmation in the chat (see description text).
 */

import { buildMorningBriefing, renderBriefing } from '@/lib/ai/briefing';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { listJobs } from '@/lib/db/queries/jobs';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import {
  assignTaskAction,
  changeStatusAction,
  createTaskAction,
  verifyTaskAction,
} from '@/server/actions/tasks';
import { formatDate } from '../format';
import type { AiTool } from '../types';

const HENRY_ACTOR = 'henry';

/** Re-stamp `created_by='henry'` on a row created via the standard action. */
async function stampHenryCreatedBy(taskId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from('tasks').update({ created_by: HENRY_ACTOR }).eq('id', taskId);
  } catch (e) {
    console.error('[henry-tools] stamp created_by failed:', e);
  }
}

export const taskTools: AiTool[] = [
  {
    definition: {
      name: 'create_task',
      description:
        'Create a task. Defaults to a personal task on the operator\'s /todos list (also shown in the dashboard "Personal" task bucket). Pass scope="project" with a job_id to attach to a job, or scope="lead" with a lead_id. Do NOT use this for the legacy /inbox Todos tab — that uses create_todo. Henry stamps created_by="henry" for audit.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          scope: {
            type: 'string',
            enum: ['personal', 'project', 'lead'],
            description: "Task scope (default 'personal')",
          },
          job_id: { type: 'string', description: 'Job UUID (required when scope=project)' },
          due_date: { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['title'],
      },
    },
    handler: async (input) => {
      const scope = (input.scope as string) ?? 'personal';
      const result = await createTaskAction({
        title: input.title,
        scope,
        job_id: input.job_id,
        due_date: input.due_date,
      });
      if (!result.ok) return `Failed to create task: ${result.error}`;
      await stampHenryCreatedBy(result.id);
      return `Task created. ID: ${result.id.slice(0, 8)}`;
    },
  },
  {
    definition: {
      name: 'assign_task',
      description:
        'Assign (or reassign) an existing task to a worker by their auth user id. Pass assignee_id=null to clear the assignment. Only owners and admins can assign; RLS rejects other callers. Always confirm with the owner before calling. Do not assign autonomously.',
      input_schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task UUID' },
          assignee_id: {
            type: ['string', 'null'],
            description: 'Worker auth user UUID, or null to unassign.',
          },
        },
        required: ['task_id'],
      },
    },
    handler: async (input) => {
      const result = await assignTaskAction({
        id: input.task_id as string,
        assignee_id: (input.assignee_id as string | null) ?? null,
      });
      if (!result.ok) return `Failed to assign task: ${result.error}`;
      return input.assignee_id ? 'Task assigned.' : 'Task unassigned.';
    },
  },
  {
    definition: {
      name: 'update_task',
      description:
        'Patch an existing task by id. Owner-only fields (title, status, blocker_reason, due_date, phase, description). Pass only fields you want to change.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task UUID' },
          title: { type: 'string' },
          description: { type: 'string' },
          phase: { type: 'string' },
          status: {
            type: 'string',
            enum: [
              'ready',
              'in_progress',
              'waiting_client',
              'waiting_material',
              'waiting_sub',
              'blocked',
              'done',
              'verified',
            ],
          },
          blocker_reason: { type: 'string' },
          due_date: { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['id'],
      },
    },
    handler: async (input) => {
      try {
        const id = input.id as string;
        if (!id) return 'Missing task id.';
        const supabase = await createClient();
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        for (const k of [
          'title',
          'description',
          'phase',
          'status',
          'blocker_reason',
          'due_date',
        ] as const) {
          if (input[k] !== undefined) patch[k] = input[k];
        }
        // Status side-effects (mirror changeStatusAction).
        if (patch.status === 'done') patch.completed_at = new Date().toISOString();
        if (patch.status === 'verified') patch.verified_at = new Date().toISOString();
        const { error } = await supabase.from('tasks').update(patch).eq('id', id);
        if (error) return `Failed to update task: ${error.message}`;
        return `Task ${id.slice(0, 8)} updated.`;
      } catch (e) {
        return `Failed to update task: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'list_tasks',
      description:
        'List tasks with optional filters. Returns id, title, status, due date, scope, job_id, assignee_id.',
      input_schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['personal', 'project', 'lead'] },
          status: {
            type: 'string',
            description:
              "Single status, or 'open' to exclude done+verified, or 'blocked' to bucket all waiting/blocked rows.",
          },
          job_id: { type: 'string' },
          assignee_id: { type: 'string' },
          due_within_days: {
            type: 'number',
            description: 'Only tasks with due_date within the next N days.',
          },
          blocked_only: { type: 'boolean' },
          limit: { type: 'number', description: 'Default 25, max 100' },
        },
      },
    },
    handler: async (input) => {
      try {
        const supabase = await createClient();
        let q = supabase
          .from('tasks')
          .select('id, title, status, due_date, scope, job_id, assignee_id, phase');

        if (input.scope) q = q.eq('scope', input.scope as string);
        if (input.job_id) q = q.eq('job_id', input.job_id as string);
        if (input.assignee_id) q = q.eq('assignee_id', input.assignee_id as string);

        if (input.blocked_only === true || input.status === 'blocked') {
          q = q.in('status', ['blocked', 'waiting_client', 'waiting_material', 'waiting_sub']);
        } else if (input.status === 'open') {
          q = q.not('status', 'in', '(done,verified)');
        } else if (input.status) {
          q = q.eq('status', input.status as string);
        }

        if (input.due_within_days !== undefined) {
          const d = Number(input.due_within_days);
          const cutoff = new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          q = q.lte('due_date', cutoff).not('due_date', 'is', null);
        }

        const limit = Math.min((input.limit as number) || 25, 100);
        q = q.order('due_date', { ascending: true, nullsFirst: false }).limit(limit);

        const { data, error } = await q;
        if (error) return `Failed to list tasks: ${error.message}`;
        const rows = data ?? [];
        if (rows.length === 0) return 'No tasks match those filters.';

        let out = `Found ${rows.length} task(s):\n\n`;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i] as Record<string, unknown>;
          out += `${i + 1}. ${r.title}\n`;
          out += `   Status: ${r.status}`;
          if (r.due_date) out += ` | Due: ${formatDate(r.due_date as string)}`;
          if (r.phase) out += ` | Phase: ${r.phase}`;
          out += `\n   Scope: ${r.scope}`;
          if (r.job_id) out += ` | Job: ${(r.job_id as string).slice(0, 8)}`;
          if (r.assignee_id) out += ` | Assignee: ${(r.assignee_id as string).slice(0, 8)}`;
          out += `\n   ID: ${r.id}\n\n`;
        }
        return out;
      } catch (e) {
        return `Failed to list tasks: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'get_task',
      description:
        'Get full details for a single task by id, including assignee name, job and customer context, and phase.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Task UUID' } },
        required: ['id'],
      },
    },
    handler: async (input) => {
      try {
        const supabase = await createClient();
        const { data, error } = await supabase
          .from('tasks')
          .select(
            'id, title, description, status, scope, phase, due_date, blocker_reason, required_photos, created_by, assignee_id, job_id, completed_at, verified_at, jobs:job_id (id, customers:customer_id (name))',
          )
          .eq('id', input.id as string)
          .maybeSingle();
        if (error) return `Failed to get task: ${error.message}`;
        if (!data) return 'Task not found.';

        const job = Array.isArray((data as Record<string, unknown>).jobs)
          ? (data as { jobs: unknown[] }).jobs[0]
          : (data as { jobs: unknown }).jobs;
        const jobObj = job as
          | { id: string; customers: { name: string } | { name: string }[] | null }
          | null
          | undefined;
        const customerObj = jobObj
          ? Array.isArray(jobObj.customers)
            ? jobObj.customers[0]
            : jobObj.customers
          : null;

        // Resolve assignee name if present.
        let assigneeName = '';
        if (data.assignee_id) {
          const admin = createAdminClient();
          const { data: prof } = await admin
            .from('worker_profiles')
            .select('display_name')
            .eq('user_id', data.assignee_id as string)
            .maybeSingle();
          assigneeName = (prof?.display_name as string) ?? '';
        }

        let out = `Task: ${data.title}\n${'='.repeat(40)}\n`;
        out += `Status: ${data.status}\n`;
        out += `Scope: ${data.scope}`;
        if (data.phase) out += ` | Phase: ${data.phase}`;
        out += '\n';
        if (data.due_date) out += `Due: ${formatDate(data.due_date as string)}\n`;
        if (data.blocker_reason) out += `Blocker: ${data.blocker_reason}\n`;
        if (data.required_photos) out += 'Requires photo for verification.\n';
        if (customerObj) out += `Customer: ${(customerObj as { name: string }).name}\n`;
        if (jobObj) out += `Job: ${jobObj.id.slice(0, 8)}\n`;
        if (data.assignee_id)
          out += `Assignee: ${assigneeName || (data.assignee_id as string).slice(0, 8)}\n`;
        out += `Created by: ${data.created_by}\n`;
        if (data.completed_at) out += `Completed: ${data.completed_at}\n`;
        if (data.verified_at) out += `Verified: ${data.verified_at}\n`;
        if (data.description) out += `\nDescription:\n${data.description}\n`;
        out += `\nID: ${data.id}`;
        return out;
      } catch (e) {
        return `Failed to get task: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'find_blocked_tasks_for_job',
      description:
        'Find blocked / waiting tasks on a job. Pass job_name (fuzzy match against the customer name) or job_id directly. Returns title, status, blocker reason.',
      input_schema: {
        type: 'object',
        properties: {
          job_name: { type: 'string', description: 'Fuzzy-match against customer name' },
          job_id: { type: 'string', description: 'Job UUID (skip job_name resolution)' },
        },
      },
    },
    handler: async (input) => {
      try {
        let jobId = input.job_id as string | undefined;
        if (!jobId && input.job_name) {
          // Reuse listJobs to fuzzy-resolve via customer name.
          const matches = await listJobs({ limit: 25 });
          const needle = (input.job_name as string).toLowerCase();
          const hit = matches.find((j) => j.customer?.name?.toLowerCase().includes(needle));
          if (!hit) return `No job matches "${input.job_name}".`;
          jobId = hit.id;
        }
        if (!jobId) return 'Provide either job_id or job_name.';

        const supabase = await createClient();
        const { data, error } = await supabase
          .from('tasks')
          .select('id, title, status, blocker_reason, due_date, updated_at')
          .eq('job_id', jobId)
          .in('status', ['blocked', 'waiting_client', 'waiting_material', 'waiting_sub']);
        if (error) return `Failed to query: ${error.message}`;
        const rows = data ?? [];
        if (rows.length === 0) return `No blocked tasks on job ${jobId.slice(0, 8)}.`;

        let out = `${rows.length} blocked task(s) on job ${jobId.slice(0, 8)}:\n\n`;
        for (const r of rows) {
          out += `- ${r.title} [${r.status}]`;
          if (r.blocker_reason) out += ` — ${r.blocker_reason}`;
          out += `\n  ID: ${(r.id as string).slice(0, 8)}\n`;
        }
        return out;
      } catch (e) {
        return `Failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'complete_task',
      description:
        'Mark a task as done (owner-mediated). Crew normally does this from the worker UI; use this when the owner asks Henry to close out a task.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Task UUID' } },
        required: ['id'],
      },
    },
    handler: async (input) => {
      const result = await changeStatusAction({ id: input.id as string, status: 'done' });
      if (!result.ok) return `Failed to complete task: ${result.error}`;
      return `Task ${(input.id as string).slice(0, 8)} marked done.`;
    },
  },
  {
    definition: {
      name: 'verify_task',
      description:
        'Owner verification — flips a done task to verified. Owners/admins only; RLS rejects other callers.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Task UUID' } },
        required: ['id'],
      },
    },
    handler: async (input) => {
      const result = await verifyTaskAction(input.id as string);
      if (!result.ok) return `Failed to verify task: ${result.error}`;
      return `Task ${(input.id as string).slice(0, 8)} verified.`;
    },
  },
  {
    definition: {
      name: 'get_morning_briefing',
      description:
        "Returns Jonathan's day-at-a-glance: tasks due tomorrow, overdue today, blocked, To-Verify queue count, and open Henry suggestions from the last 24h. Use when the owner asks 'what's on my plate' or 'what does my day look like'.",
      input_schema: { type: 'object', properties: {} },
    },
    handler: async () => {
      try {
        const tenant = await getCurrentTenant();
        if (!tenant) return 'Not authenticated.';
        const user = await getCurrentUser();
        if (!user) return 'Not authenticated.';
        const briefing = await buildMorningBriefing(tenant.id);
        return renderBriefing(briefing);
      } catch (e) {
        return `Failed to build briefing: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];
