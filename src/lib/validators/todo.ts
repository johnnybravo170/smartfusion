/**
 * Zod validators for todo forms and server actions.
 *
 * The same schemas back both the client (React Hook Form resolver) and the
 * server (server actions). Optional fields accept an empty string from the
 * form; the server action normalises "" to null before hitting the DB.
 *
 * See PHASE_1_PLAN.md §8 Track E.
 */

import { z } from 'zod';

export const todoRelatedTypes = ['customer', 'quote', 'job', 'invoice'] as const;
export type TodoRelatedType = (typeof todoRelatedTypes)[number];

export const todoRelatedTypeLabels: Record<TodoRelatedType, string> = {
  customer: 'Customer',
  quote: 'Quote',
  job: 'Job',
  invoice: 'Invoice',
};

export const todoCreateSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, { message: 'Title is required.' })
    .max(200, { message: 'Title must be at most 200 characters.' }),
  due_date: z.string().optional().or(z.literal('')),
  related_type: z.enum(todoRelatedTypes).optional(),
  related_id: z.string().uuid({ message: 'Invalid related id.' }).optional().or(z.literal('')),
});

export const todoUpdateSchema = todoCreateSchema.extend({
  id: z.string().uuid({ message: 'Invalid todo id.' }),
});

export const todoToggleSchema = z.object({
  id: z.string().uuid({ message: 'Invalid todo id.' }),
  done: z.boolean(),
});

export type TodoInput = z.infer<typeof todoCreateSchema>;
export type TodoUpdateInput = z.infer<typeof todoUpdateSchema>;
export type TodoToggleInput = z.infer<typeof todoToggleSchema>;

/**
 * Collapse empty strings from the form into `null` so the DB stores a real
 * "no value" instead of the literal empty string.
 */
export function emptyToNull(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
