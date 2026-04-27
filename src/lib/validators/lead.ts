/**
 * Zod validators for the public lead-gen quoting widget.
 *
 * Validates homeowner contact info and surfaces submitted through the
 * public /q/[slug] page. Intentionally separate from operator-facing
 * quote validators.
 */

import { z } from 'zod';

export const leadSurfaceSchema = z.object({
  surface_type: z.string().min(1, 'Surface type is required'),
  sqft: z.number().positive('Area must be greater than zero'),
  price_cents: z.number().int().nonnegative(),
  polygon_geojson: z.any().optional(),
});

export const leadSubmitSchema = z.object({
  tenantId: z.string().uuid('Invalid tenant'),
  name: z.string().trim().min(1, 'Name is required').max(200),
  email: z.string().trim().email('Enter a valid email'),
  phone: z.string().trim().min(7, 'Enter a valid phone number').max(30),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  marketingOptIn: z.boolean().optional(),
  marketingWording: z.string().max(1000).optional(),
  surfaces: z.array(leadSurfaceSchema).min(1, 'Add at least one surface'),
});

export type LeadSubmitInput = z.infer<typeof leadSubmitSchema>;

export const slugSchema = z
  .string()
  .trim()
  .min(3, 'Slug must be at least 3 characters')
  .max(50, 'Slug must be 50 characters or fewer')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters, numbers, and hyphens only');
