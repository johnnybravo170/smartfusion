/**
 * Zod validators for job forms and server actions.
 *
 * The same schemas back both the client (React Hook Form resolver) and the
 * server (server actions). Optional text fields accept an empty string from
 * the form; the server action converts "" to null before writing to the DB.
 *
 * See PHASE_1_PLAN.md §8 Track C.
 */

import { z } from 'zod';

export const jobStatuses = ['booked', 'in_progress', 'complete', 'cancelled'] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const jobStatusLabels: Record<JobStatus, string> = {
  booked: 'Booked',
  in_progress: 'In progress',
  complete: 'Complete',
  cancelled: 'Cancelled',
};

export const jobCreateSchema = z.object({
  customer_id: z.string().uuid({ message: 'Pick a customer.' }),
  quote_id: z.string().uuid({ message: 'Invalid quote id.' }).optional().or(z.literal('')),
  status: z.enum(jobStatuses).default('booked'),
  scheduled_at: z.string().optional().or(z.literal('')),
  notes: z
    .string()
    .trim()
    .max(2000, { message: 'Notes must be at most 2000 characters.' })
    .optional()
    .or(z.literal('')),
});

export const jobUpdateSchema = jobCreateSchema.extend({
  id: z.string().uuid({ message: 'Invalid job id.' }),
});

export const jobStatusChangeSchema = z.object({
  id: z.string().uuid({ message: 'Invalid job id.' }),
  status: z.enum(jobStatuses),
});

export type JobInput = z.infer<typeof jobCreateSchema>;
export type JobUpdateInput = z.infer<typeof jobUpdateSchema>;
export type JobStatusChangeInput = z.infer<typeof jobStatusChangeSchema>;

/**
 * Collapse empty strings from the form into `null` so the DB stores a real
 * "no value" instead of the literal empty string.
 */
export function emptyToNull(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
