/**
 * Zod validators for customer forms and server actions.
 *
 * The same schemas back both the client (React Hook Form resolver) and the
 * server (server actions). Optional text fields accept an empty string from
 * the form; the server action converts "" to null before writing to the DB.
 *
 * See PHASE_1_PLAN.md §8 Track A.
 */

import { z } from 'zod';

/**
 * Contact kinds (per the `customers.kind` column introduced in migration
 * 0111). Governs which detail-page sections apply and which subtype /
 * detail extraction the AI intake uses.
 */
export const contactKinds = [
  'lead',
  'customer',
  'vendor',
  'sub',
  'agent',
  'inspector',
  'referral',
  'other',
] as const;
export type ContactKind = (typeof contactKinds)[number];

export const contactKindLabels: Record<ContactKind, string> = {
  lead: 'Lead',
  customer: 'Customer',
  vendor: 'Vendor',
  sub: 'Sub-trade',
  agent: 'Agent',
  inspector: 'Inspector',
  referral: 'Referral partner',
  other: 'Other',
};

/**
 * Form-level customer type option (what the legacy new-customer form shows).
 * Physically persists as either `customers.type` (for residential / commercial)
 * or `customers.kind='agent'` (for agent) — the server action translates via
 * `resolveKindAndSubtypeFromLegacyType` below. This lets the existing form
 * keep working unchanged while Slice C introduces the kind-first UX.
 *
 * Valid `customers.type` values in the DB are now only `residential | commercial | NULL`
 * — see `customers_type_check` in migration 0111.
 */
export const customerTypes = ['residential', 'commercial', 'agent'] as const;
export type CustomerType = (typeof customerTypes)[number];

export const customerTypeLabels: Record<CustomerType, string> = {
  residential: 'Residential',
  commercial: 'Commercial',
  agent: 'Agent',
};

/**
 * Map the legacy three-way form value onto the new kind/subtype pair.
 * Residential and commercial remain customer subtypes; agent becomes its own
 * contact kind.
 */
export function resolveKindAndSubtypeFromLegacyType(formType: CustomerType): {
  kind: ContactKind;
  subtype: 'residential' | 'commercial' | null;
} {
  if (formType === 'agent') return { kind: 'agent', subtype: null };
  return { kind: 'customer', subtype: formType };
}

/**
 * `z.email()` refuses empty strings, so every optional-email-or-empty field
 * is a union with a literal empty. We lower-case emails for consistency and
 * trim every text field.
 */
const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email({ message: 'Enter a valid email address.' })
  .optional()
  .or(z.literal(''));

const optionalText = (max: number, label = 'value') =>
  z
    .string()
    .trim()
    .max(max, { message: `${label} must be at most ${max} characters.` })
    .optional()
    .or(z.literal(''));

export const customerCreateSchema = z.object({
  /**
   * Legacy three-way form value. Kept for existing callers; new kind-aware
   * callers should pass `kind` + optional `subtype` instead. If `kind` is
   * provided, `type` is derived by the server and ignored here.
   */
  type: z.enum(customerTypes, { message: 'Choose a type.' }),
  /** New kind-first field (optional during the transition). */
  kind: z.enum(contactKinds).optional(),
  name: z
    .string()
    .trim()
    .min(1, { message: 'Name is required.' })
    .max(100, { message: 'Name must be at most 100 characters.' }),
  email: optionalEmail,
  phone: optionalText(30, 'Phone'),
  addressLine1: optionalText(200, 'Address'),
  city: optionalText(100, 'City'),
  province: optionalText(40, 'Province'),
  postalCode: optionalText(20, 'Postal code'),
  notes: optionalText(2000, 'Notes'),
  /**
   * Set by the form after the operator sees the duplicates banner and
   * clicks "Create anyway". Server skips the dedup check when true.
   */
  confirmCreate: z.boolean().optional(),
});

export const customerUpdateSchema = customerCreateSchema.extend({
  id: z.string().uuid({ message: 'Invalid customer id.' }),
});

export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;
export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;

/**
 * Collapse empty strings from the form into `null` so the DB stores a real
 * "no value" instead of the literal empty string. Keeps filtering + display
 * logic simple.
 */
export function emptyToNull(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
