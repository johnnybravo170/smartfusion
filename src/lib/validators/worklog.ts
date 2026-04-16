/**
 * Zod validators for worklog forms and server actions.
 *
 * Only `note`-type entries are editable through the UI. System/milestone
 * entries are immutable from the application layer — they are emitted by
 * other tracks (e.g. job status transitions write a `system` entry).
 *
 * See PHASE_1_PLAN.md §8 Track E.
 */

import { z } from 'zod';

export const worklogEntryTypes = ['note', 'system', 'milestone'] as const;
export type WorklogEntryType = (typeof worklogEntryTypes)[number];

export const worklogEntryTypeLabels: Record<WorklogEntryType, string> = {
  note: 'Note',
  system: 'System',
  milestone: 'Milestone',
};

export const worklogRelatedTypes = ['customer', 'quote', 'job', 'invoice'] as const;
export type WorklogRelatedType = (typeof worklogRelatedTypes)[number];

export const worklogRelatedTypeLabels: Record<WorklogRelatedType, string> = {
  customer: 'Customer',
  quote: 'Quote',
  job: 'Job',
  invoice: 'Invoice',
};

export const worklogNoteCreateSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, { message: 'Title is required.' })
    .max(200, { message: 'Title must be at most 200 characters.' }),
  body: z
    .string()
    .trim()
    .max(5000, { message: 'Body must be at most 5000 characters.' })
    .optional()
    .or(z.literal('')),
  related_type: z.enum(worklogRelatedTypes).optional(),
  related_id: z.string().uuid({ message: 'Invalid related id.' }).optional().or(z.literal('')),
});

export const worklogNoteUpdateSchema = worklogNoteCreateSchema.extend({
  id: z.string().uuid({ message: 'Invalid entry id.' }),
});

export type WorklogNoteInput = z.infer<typeof worklogNoteCreateSchema>;
export type WorklogNoteUpdateInput = z.infer<typeof worklogNoteUpdateSchema>;

/**
 * Collapse empty strings from the form into `null` so the DB stores a real
 * "no value" instead of the literal empty string.
 */
export function emptyToNull(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
