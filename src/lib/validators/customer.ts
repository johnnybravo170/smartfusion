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

export const customerTypes = ['residential', 'commercial', 'agent'] as const;
export type CustomerType = (typeof customerTypes)[number];

export const customerTypeLabels: Record<CustomerType, string> = {
  residential: 'Residential',
  commercial: 'Commercial',
  agent: 'Agent',
};

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
  type: z.enum(customerTypes, { message: 'Choose a customer type.' }),
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
