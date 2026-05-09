/**
 * Zod validators for business + operator profile forms.
 *
 * URLs stay permissive (optional strings) because operators paste from all
 * kinds of sources — we normalize via `toAbsoluteUrl()` at read-time rather
 * than rejecting at write-time.
 */

import { z } from 'zod';
import { optionalGstNumberSchema } from './tax-id';

const OPTIONAL_STRING = z.string().trim().max(500, 'Too long.').optional().or(z.literal(''));

export const businessProfileSchema = z.object({
  name: z.string().trim().min(1, 'Business name is required.').max(200),
  addressLine1: OPTIONAL_STRING,
  addressLine2: OPTIONAL_STRING,
  city: OPTIONAL_STRING,
  province: OPTIONAL_STRING,
  postalCode: OPTIONAL_STRING,
  phone: OPTIONAL_STRING,
  contactEmail: z.string().trim().email('Not a valid email.').optional().or(z.literal('')),
  websiteUrl: OPTIONAL_STRING,
  reviewUrl: OPTIONAL_STRING,
  gstNumber: optionalGstNumberSchema,
  wcbNumber: OPTIONAL_STRING,
});

export type BusinessProfileInput = z.infer<typeof businessProfileSchema>;

export const socialsSchema = z.object({
  instagram: OPTIONAL_STRING,
  facebook: OPTIONAL_STRING,
  tiktok: OPTIONAL_STRING,
  youtube: OPTIONAL_STRING,
  googleBusiness: OPTIONAL_STRING,
  linkedin: OPTIONAL_STRING,
  x: OPTIONAL_STRING,
});

export type SocialsInput = z.infer<typeof socialsSchema>;

export const operatorProfileSchema = z.object({
  firstName: OPTIONAL_STRING,
  lastName: OPTIONAL_STRING,
  title: OPTIONAL_STRING,
  notificationPhone: OPTIONAL_STRING,
  defaultHourlyRateCents: z.coerce.number().int().min(0).nullable().optional(),
  notifyCustomerFeedbackEmail: z.boolean().default(true),
  notifyCustomerFeedbackSms: z.boolean().default(false),
  notifyChangeOrderResponseEmail: z.boolean().default(true),
  notifyChangeOrderResponseSms: z.boolean().default(false),
});

export type OperatorProfileInput = z.infer<typeof operatorProfileSchema>;

export function emptyToNull(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Coerce a user-entered URL into a click-safe absolute URL. Returns null
 * if the value is empty or can't be parsed. Tolerates "example.com",
 * "www.example.com", "instagram.com/foo" — prepends https:// as needed.
 */
export function toAbsoluteUrl(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^mailto:/i.test(v) || /^tel:/i.test(v)) return v;
  return `https://${v}`;
}
