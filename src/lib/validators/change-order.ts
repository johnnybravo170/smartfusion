/**
 * Zod validators for change order forms and server actions.
 */

import { z } from 'zod';

export const changeOrderStatuses = [
  'draft',
  'pending_approval',
  'approved',
  'declined',
  'voided',
] as const;
export type ChangeOrderStatus = (typeof changeOrderStatuses)[number];

export const changeOrderStatusLabels: Record<ChangeOrderStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending Approval',
  approved: 'Approved',
  declined: 'Declined',
  voided: 'Voided',
};

export const changeOrderCreateSchema = z.object({
  project_id: z.string().uuid({ message: 'Invalid project id.' }),
  title: z
    .string()
    .trim()
    .min(1, { message: 'Title is required.' })
    .max(200, { message: 'Title must be at most 200 characters.' }),
  description: z
    .string()
    .trim()
    .min(1, { message: 'Description is required.' })
    .max(5000, { message: 'Description must be at most 5000 characters.' }),
  reason: z
    .string()
    .trim()
    .max(2000, { message: 'Reason must be at most 2000 characters.' })
    .optional()
    .or(z.literal('')),
  cost_impact_cents: z.coerce
    .number()
    .int({ message: 'Cost impact must be a whole number of cents.' }),
  timeline_impact_days: z.coerce.number().int({ message: 'Timeline impact must be whole days.' }),
  affected_buckets: z.array(z.string().uuid()).default([]),
});

export const changeOrderApprovalSchema = z.object({
  approved_by_name: z
    .string()
    .trim()
    .min(1, { message: 'Please type your name to approve.' })
    .max(200, { message: 'Name must be at most 200 characters.' }),
});

export type ChangeOrderInput = z.infer<typeof changeOrderCreateSchema>;
export type ChangeOrderApprovalInput = z.infer<typeof changeOrderApprovalSchema>;
