import { describe, expect, it } from 'vitest';
import {
  formatGstNumber,
  gstNumberSchema,
  isValidGstNumber,
  normalizeGstNumber,
  optionalGstNumberSchema,
} from '@/lib/validators/tax-id';

describe('normalizeGstNumber', () => {
  it('strips whitespace and uppercases', () => {
    expect(normalizeGstNumber(' 123 456 789 rt 0001 ')).toBe('123456789RT0001');
  });
});

describe('isValidGstNumber', () => {
  it('accepts the canonical CRA shape', () => {
    expect(isValidGstNumber('123456789RT0001')).toBe(true);
    expect(isValidGstNumber('123456789 RT0001')).toBe(true);
    expect(isValidGstNumber('123456789 rt0001')).toBe(true);
  });

  it('rejects partial or wrong-shaped values', () => {
    expect(isValidGstNumber('')).toBe(false);
    expect(isValidGstNumber(null)).toBe(false);
    expect(isValidGstNumber(undefined)).toBe(false);
    expect(isValidGstNumber('123456789')).toBe(false); // missing RT account
    expect(isValidGstNumber('12345678 RT0001')).toBe(false); // 8-digit BN
    expect(isValidGstNumber('123456789RP0001')).toBe(false); // RP, not RT
    expect(isValidGstNumber('123456789RT00001')).toBe(false); // 5-digit account
  });
});

describe('formatGstNumber', () => {
  it('renders with a single space between BN and RT account', () => {
    expect(formatGstNumber('123456789RT0001')).toBe('123456789 RT0001');
    expect(formatGstNumber(' 123456789rt0001 ')).toBe('123456789 RT0001');
  });

  it('returns original input when format is invalid', () => {
    expect(formatGstNumber('not a gst number')).toBe('not a gst number');
    expect(formatGstNumber('')).toBe('');
  });
});

describe('gstNumberSchema (required)', () => {
  it('parses + normalizes a valid value', () => {
    const parsed = gstNumberSchema.safeParse(' 123456789 rt0001 ');
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe('123456789RT0001');
  });

  it('rejects empty string with the required message', () => {
    const parsed = gstNumberSchema.safeParse('');
    expect(parsed.success).toBe(false);
  });

  it('rejects malformed values with the format hint', () => {
    const parsed = gstNumberSchema.safeParse('123-456-789');
    expect(parsed.success).toBe(false);
  });
});

describe('optionalGstNumberSchema', () => {
  it('accepts empty string (operator can save profile without GST# yet)', () => {
    expect(optionalGstNumberSchema.safeParse('').success).toBe(true);
    expect(optionalGstNumberSchema.safeParse(undefined).success).toBe(true);
  });

  it('accepts a valid value', () => {
    expect(optionalGstNumberSchema.safeParse('123456789 RT0001').success).toBe(true);
  });

  it('rejects an invalid non-empty value', () => {
    expect(optionalGstNumberSchema.safeParse('garbage').success).toBe(false);
  });
});
