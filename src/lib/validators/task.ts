/**
 * Zod validators + label maps for the tasks module.
 *
 * Status enum, scope enum, default phase list, and label maps are all
 * imported from here — server actions, DB queries, badge components, and
 * the AI tool all depend on these strings, so keep them in one place.
 */

import { z } from 'zod';

export const taskScopes = ['personal', 'project', 'lead'] as const;
export type TaskScope = (typeof taskScopes)[number];

export const taskStatuses = [
  'ready',
  'in_progress',
  'waiting_client',
  'waiting_material',
  'waiting_sub',
  'blocked',
  'done',
  'verified',
] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const taskStatusLabels: Record<TaskStatus, string> = {
  ready: 'Ready',
  in_progress: 'In Progress',
  waiting_client: 'Waiting — Client',
  waiting_material: 'Waiting — Material',
  waiting_sub: 'Waiting — Sub',
  blocked: 'Blocked',
  done: 'Done',
  verified: 'Verified',
};

export const taskVisibilities = ['internal', 'crew', 'client'] as const;
export type TaskVisibility = (typeof taskVisibilities)[number];

/** Default renovation-vertical phase list. Owners can rename or add. */
export const defaultRenovationPhases = [
  'Pre-Construction',
  'Demo',
  'Rough-Ins',
  'Inspection',
  'Finish',
  'Punch',
  'Closeout',
] as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .optional()
  .or(z.literal(''));

export const taskCreateSchema = z
  .object({
    title: z.string().trim().min(1, 'Title required').max(500),
    description: z.string().trim().max(5000).optional().or(z.literal('')),
    scope: z.enum(taskScopes),
    job_id: z.string().uuid().optional().or(z.literal('')),
    lead_id: z.string().uuid().optional().or(z.literal('')),
    phase: z.string().trim().max(100).optional().or(z.literal('')),
    status: z.enum(taskStatuses).default('ready'),
    blocker_reason: z.string().trim().max(1000).optional().or(z.literal('')),
    assignee_id: z.string().uuid().optional().or(z.literal('')),
    visibility: z.enum(taskVisibilities).default('internal'),
    client_summary: z.string().trim().max(2000).optional().or(z.literal('')),
    required_photos: z.boolean().default(false),
    due_date: isoDate,
  })
  .superRefine((val, ctx) => {
    if (val.scope === 'personal' && (val.job_id || val.lead_id)) {
      ctx.addIssue({ code: 'custom', message: 'Personal tasks cannot have a job or lead.' });
    }
    if (val.scope === 'project' && !val.job_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['job_id'],
        message: 'Project-scoped tasks need a job.',
      });
    }
    if (val.scope === 'lead' && !val.lead_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['lead_id'],
        message: 'Lead-scoped tasks need a lead.',
      });
    }
  });

export const taskUpdateSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().trim().max(5000).optional().or(z.literal('')).nullable(),
  phase: z.string().trim().max(100).optional().or(z.literal('')).nullable(),
  status: z.enum(taskStatuses).optional(),
  blocker_reason: z.string().trim().max(1000).optional().or(z.literal('')).nullable(),
  assignee_id: z.string().uuid().optional().or(z.literal('')).nullable(),
  visibility: z.enum(taskVisibilities).optional(),
  client_summary: z.string().trim().max(2000).optional().or(z.literal('')).nullable(),
  required_photos: z.boolean().optional(),
  due_date: isoDate.nullable(),
});

export const taskStatusChangeSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(taskStatuses),
});

export const taskAssignSchema = z.object({
  id: z.string().uuid(),
  assignee_id: z.string().uuid().nullable(),
});

export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;
