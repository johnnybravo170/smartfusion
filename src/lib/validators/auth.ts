/**
 * Zod validators for auth forms and server actions.
 *
 * Used from both the client (react-hook-form resolvers) and the server
 * (server actions). Keeping the schemas in one file ensures the two sides
 * agree on shape + error messages.
 */

import { z } from 'zod';

/**
 * Password rule: at least 8 chars, must contain at least one letter and one
 * digit. Symbols are allowed but not required. Matches the task spec in
 * PHASE_1_PLAN §8 Task 1.6.
 */
const passwordRule = z
  .string()
  .min(8, { message: 'Password must be at least 8 characters long.' })
  .regex(/[a-zA-Z]/, { message: 'Password must contain at least one letter.' })
  .regex(/[0-9]/, { message: 'Password must contain at least one number.' });

export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email({ message: 'Enter a valid email address.' }),
  password: passwordRule,
  firstName: z
    .string()
    .trim()
    .min(1, { message: 'Enter your first name.' })
    .max(60, { message: 'First name is too long.' }),
  lastName: z
    .string()
    .trim()
    .min(1, { message: 'Enter your last name.' })
    .max(60, { message: 'Last name is too long.' }),
  businessName: z
    .string()
    .trim()
    .min(2, { message: 'Business name must be at least 2 characters.' })
    .max(100, { message: 'Business name must be at most 100 characters.' }),
  phone: z
    .string()
    .trim()
    .min(7, { message: 'Enter a phone number we can text a code to.' })
    .max(20, { message: 'Phone number is too long.' }),
  // Defence in depth: the form blocks submit until the box is checked, but we
  // also reject server-side so a tampered request can't bypass the gate.
  acceptedPolicies: z.literal(true, {
    message: 'You must accept the Terms of Service and Privacy Policy.',
  }),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email({ message: 'Enter a valid email address.' }),
  password: z.string().min(1, { message: 'Password is required.' }),
});

export const magicLinkSchema = z.object({
  email: z.string().trim().toLowerCase().email({ message: 'Enter a valid email address.' }),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type MagicLinkInput = z.infer<typeof magicLinkSchema>;
