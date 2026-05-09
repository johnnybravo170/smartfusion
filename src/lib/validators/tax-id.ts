/**
 * Validators for Canadian tax identification numbers.
 *
 * GST/HST registration numbers issued by the CRA are a 9-digit Business
 * Number followed by a 4-character account suffix (`RT0001` for the first
 * GST/HST account, `RT0002` for a second one, etc.). We accept the value
 * with or without internal whitespace, normalize on save, and re-format
 * with a single space between the BN and the RT account when displaying.
 *
 * Why we gate at first-send (not at signup): collecting GST# during
 * onboarding tanks activation — most contractors don't have it handy.
 * The first-send gate lands the requirement at the moment it actually
 * matters (CRA-compliant invoice/estimate document) without slowing
 * down sign-up.
 */

import { z } from 'zod';

const GST_NUMBER_PATTERN = /^\d{9}RT\d{4}$/;

export const GST_NUMBER_FORMAT_HINT =
  'Enter a 9-digit business number followed by RT0001 (e.g. 123456789 RT0001).';

/** Strip whitespace and uppercase. */
export function normalizeGstNumber(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

export function isValidGstNumber(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return GST_NUMBER_PATTERN.test(normalizeGstNumber(raw));
}

/** Display form: `123456789 RT0001` (single space between BN and RT). */
export function formatGstNumber(raw: string | null | undefined): string {
  if (!raw) return '';
  const n = normalizeGstNumber(raw);
  if (!GST_NUMBER_PATTERN.test(n)) return raw.trim();
  return `${n.slice(0, 9)} ${n.slice(9)}`;
}

/** Required, must match the 9-digit + RT#### shape. Output is normalized. */
export const gstNumberSchema = z
  .string()
  .trim()
  .min(1, 'GST/HST number is required.')
  .transform(normalizeGstNumber)
  .refine((v) => GST_NUMBER_PATTERN.test(v), GST_NUMBER_FORMAT_HINT);

/**
 * Optional — empty input passes. When present, must match the format.
 * Used by the business profile form (operator can save the rest of their
 * profile without setting GST# yet).
 */
export const optionalGstNumberSchema = z
  .string()
  .trim()
  .max(30, 'Too long.')
  .optional()
  .or(z.literal(''))
  .refine((v) => !v || GST_NUMBER_PATTERN.test(normalizeGstNumber(v)), GST_NUMBER_FORMAT_HINT);
