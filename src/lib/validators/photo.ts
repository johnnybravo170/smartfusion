/**
 * Zod validators for photo forms and server actions.
 *
 * The photo tag mirrors the `CHECK` constraint on `photos.tag` in migration
 * 0010. Keep the enum in sync with the DB — adding a value requires a new
 * migration, not just a validator tweak.
 *
 * Optional string fields accept an empty string from the form; the action
 * converts "" to null before writing. Same convention as the job/customer
 * validators (Tracks A and C).
 *
 * See PHASE_1_PLAN.md §8 Track D.
 */

import { z } from 'zod';

export const photoTags = [
  'before',
  'after',
  'progress',
  'damage',
  'materials',
  'equipment',
  'serial',
  'concern',
  'other',
] as const;
export type PhotoTag = (typeof photoTags)[number];

export const photoTagLabels: Record<PhotoTag, string> = {
  before: 'Before',
  after: 'After',
  progress: 'Progress',
  damage: 'Damage',
  materials: 'Materials',
  equipment: 'Equipment',
  serial: 'Serial / Model',
  concern: 'Concern / Flag',
  other: 'Other',
};

/**
 * Validates the metadata attached to an upload. The file itself is handled
 * outside Zod (binary not in JSON); we validate everything around it.
 */
export const photoUploadSchema = z.object({
  job_id: z.string().uuid({ message: 'Invalid job id.' }),
  tag: z.enum(photoTags).default('other'),
  caption: z
    .string()
    .trim()
    .max(500, { message: 'Caption must be at most 500 characters.' })
    .optional()
    .or(z.literal('')),
});

export const photoUpdateSchema = z.object({
  id: z.string().uuid({ message: 'Invalid photo id.' }),
  tag: z.enum(photoTags).optional(),
  caption: z
    .string()
    .trim()
    .max(500, { message: 'Caption must be at most 500 characters.' })
    .optional()
    .or(z.literal('')),
});

export type PhotoUploadInput = z.infer<typeof photoUploadSchema>;
export type PhotoUpdateInput = z.infer<typeof photoUpdateSchema>;

/** Collapse empty-string caption to `null` before writing to the DB. */
export function emptyToNull(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
