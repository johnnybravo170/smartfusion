/**
 * Unit tests for the customer Zod validators.
 *
 * Covers the three customer types, required-field enforcement, invalid email
 * handling, and the "empty string is allowed" contract for optional fields.
 */

import { describe, expect, it } from 'vitest';
import { customerCreateSchema, customerUpdateSchema, emptyToNull } from '@/lib/validators/customer';

describe('customerCreateSchema', () => {
  it('accepts a fully populated residential customer', () => {
    const parsed = customerCreateSchema.safeParse({
      type: 'residential',
      name: 'Sarah Chen',
      email: 'Sarah.Chen@example.com',
      phone: '604-555-0142',
      addressLine1: '3412 Springfield Dr',
      city: 'Abbotsford',
      province: 'BC',
      postalCode: 'V2S 7K9',
      notes: 'Gate code 4821, dog in yard.',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('residential');
      // Email should be lower-cased.
      expect(parsed.data.email).toBe('sarah.chen@example.com');
    }
  });

  it('accepts a minimal commercial customer', () => {
    const parsed = customerCreateSchema.safeParse({
      type: 'commercial',
      name: 'Abbotsford Plaza',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an agent with brokerage notes', () => {
    const parsed = customerCreateSchema.safeParse({
      type: 'agent',
      name: 'Helen Fraser (ReMax)',
      email: 'hfraser@remax.ca',
      notes: 'Bill ReMax directly, net-15.',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a missing name', () => {
    const parsed = customerCreateSchema.safeParse({
      type: 'residential',
      name: '',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.name?.[0]).toMatch(/required/i);
    }
  });

  it('rejects an invalid email', () => {
    const parsed = customerCreateSchema.safeParse({
      type: 'residential',
      name: 'Jane',
      email: 'not-an-email',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.email?.[0]).toMatch(/valid/i);
    }
  });

  it('rejects an unknown customer type', () => {
    const parsed = customerCreateSchema.safeParse({
      type: 'VIP',
      name: 'Someone',
    });
    expect(parsed.success).toBe(false);
  });

  it('allows empty strings for optional fields', () => {
    const parsed = customerCreateSchema.safeParse({
      type: 'residential',
      name: 'Karen Jones',
      email: '',
      phone: '',
      addressLine1: '',
      city: '',
      province: '',
      postalCode: '',
      notes: '',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a name longer than 100 characters', () => {
    const parsed = customerCreateSchema.safeParse({
      type: 'residential',
      name: 'a'.repeat(101),
    });
    expect(parsed.success).toBe(false);
  });
});

describe('customerUpdateSchema', () => {
  it('requires a UUID id', () => {
    const parsed = customerUpdateSchema.safeParse({
      type: 'residential',
      name: 'Jane',
      id: 'not-a-uuid',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a valid UUID id', () => {
    const parsed = customerUpdateSchema.safeParse({
      id: '11111111-2222-4333-8444-555555555555',
      type: 'residential',
      name: 'Jane',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('emptyToNull', () => {
  it('converts empty strings to null', () => {
    expect(emptyToNull('')).toBeNull();
    expect(emptyToNull('   ')).toBeNull();
  });

  it('trims whitespace but returns non-empty values', () => {
    expect(emptyToNull('  hello  ')).toBe('hello');
  });

  it('passes through null and undefined', () => {
    expect(emptyToNull(null)).toBeNull();
    expect(emptyToNull(undefined)).toBeNull();
  });
});
