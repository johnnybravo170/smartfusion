/**
 * Henry tool stub for the Tasks module. One tool: `add_task`. Phase 4 will
 * grow this into list/update/blocker-detection/etc.
 */

import { assignTaskAction, createTaskAction } from '@/server/actions/tasks';
import type { AiTool } from '../types';

export const taskTools: AiTool[] = [
  {
    definition: {
      name: 'add_task',
      description:
        'Create a task. Defaults to a personal todo for the current user. Pass scope="project" with a job_id to attach the task to a job.',
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
      return `Task created. ID: ${result.id.slice(0, 8)}`;
    },
  },
  {
    definition: {
      name: 'assign_task',
      description:
        'Assign (or reassign) an existing task to a worker by their auth user id. Pass assignee_id=null to clear the assignment. Only owners and admins can assign; RLS rejects other callers.',
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
];
