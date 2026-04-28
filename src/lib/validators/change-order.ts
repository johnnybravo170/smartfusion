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

export const changeOrderCreateSchema = z
  .object({
    project_id: z.string().uuid({ message: 'Invalid project id.' }).optional(),
    job_id: z.string().uuid({ message: 'Invalid job id.' }).optional(),
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
    /**
     * Per-budget-category attribution. Sum of amount_cents must equal
     * cost_impact_cents (validated server-side via .superRefine below).
     * Categories with amount_cents === 0 are stripped before insert.
     */
    cost_breakdown: z
      .array(
        z.object({
          budget_category_id: z.string().uuid(),
          amount_cents: z.coerce
            .number()
            .int({ message: 'Per-category amount must be whole cents.' }),
        }),
      )
      .default([]),
    category_notes: z
      .array(
        z.object({
          budget_category_id: z.string().uuid(),
          note: z.string().trim().max(2000),
        }),
      )
      .default([]),
  })
  .superRefine((data, ctx) => {
    if (data.cost_breakdown.length === 0) return;
    const sum = data.cost_breakdown.reduce((s, r) => s + r.amount_cents, 0);
    if (sum !== data.cost_impact_cents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cost_breakdown'],
        message: `Per-category amounts must sum to the total cost impact ($${(data.cost_impact_cents / 100).toFixed(2)}); got $${(sum / 100).toFixed(2)}.`,
      });
    }
  })
  .refine((data) => data.project_id || data.job_id, {
    message: 'Either project_id or job_id is required.',
    path: ['project_id'],
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
