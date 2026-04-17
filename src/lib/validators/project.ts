/**
 * Zod validators for project forms and server actions.
 *
 * Same dual-use pattern as job.ts: client (React Hook Form) + server actions.
 */

import { z } from 'zod';

export const projectStatuses = ['planning', 'in_progress', 'complete', 'cancelled'] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

export const projectStatusLabels: Record<ProjectStatus, string> = {
  planning: 'Planning',
  in_progress: 'In Progress',
  complete: 'Complete',
  cancelled: 'Cancelled',
};

export const projectCreateSchema = z.object({
  customer_id: z.string().uuid({ message: 'Pick a customer.' }),
  name: z
    .string()
    .trim()
    .min(1, { message: 'Project name is required.' })
    .max(200, { message: 'Name must be at most 200 characters.' }),
  description: z
    .string()
    .trim()
    .max(2000, { message: 'Description must be at most 2000 characters.' })
    .optional()
    .or(z.literal('')),
  start_date: z.string().optional().or(z.literal('')),
  target_end_date: z.string().optional().or(z.literal('')),
  management_fee_rate: z.coerce
    .number()
    .min(0, { message: 'Fee rate cannot be negative.' })
    .max(1, { message: 'Fee rate cannot exceed 100%.' })
    .default(0.12),
});

export const projectUpdateSchema = projectCreateSchema.extend({
  id: z.string().uuid({ message: 'Invalid project id.' }),
  status: z.enum(projectStatuses).optional(),
  phase: z
    .string()
    .trim()
    .max(200, { message: 'Phase must be at most 200 characters.' })
    .optional()
    .or(z.literal('')),
  percent_complete: z.coerce
    .number()
    .int()
    .min(0, { message: 'Cannot be negative.' })
    .max(100, { message: 'Cannot exceed 100%.' })
    .optional(),
});

export const projectStatusChangeSchema = z.object({
  id: z.string().uuid({ message: 'Invalid project id.' }),
  status: z.enum(projectStatuses),
});

export type ProjectInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;
export type ProjectStatusChangeInput = z.infer<typeof projectStatusChangeSchema>;

export function emptyToNull(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
