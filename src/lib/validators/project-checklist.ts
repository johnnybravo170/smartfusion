import { z } from 'zod';

export const checklistItemCreateSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1, 'Add a title').max(500, 'Keep it under 500 characters'),
  category: z
    .string()
    .trim()
    .max(60, 'Category is too long')
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

export const checklistItemIdSchema = z.object({
  itemId: z.string().uuid(),
});

export const checklistItemTitleUpdateSchema = z.object({
  itemId: z.string().uuid(),
  title: z.string().trim().min(1, 'Add a title').max(500),
});

export const checklistHideHoursSchema = z.object({
  // 24h, 48h, 168h (7d), or null = never hide
  hours: z.union([z.literal(24), z.literal(48), z.literal(168), z.null()]),
});

export const CHECKLIST_HIDE_HOURS_DEFAULT = 48;
