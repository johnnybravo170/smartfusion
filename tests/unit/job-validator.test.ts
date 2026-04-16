/**
 * Unit tests for the job Zod validators.
 *
 * Covers the four statuses, required-field enforcement, UUID validation,
 * and the "empty string is allowed" contract for optional fields.
 */

import { describe, expect, it } from 'vitest';
import {
  emptyToNull,
  jobCreateSchema,
  jobStatusChangeSchema,
  jobUpdateSchema,
} from '@/lib/validators/job';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';
const OTHER_UUID = '99999999-8888-4777-8666-555555555555';

describe('jobCreateSchema', () => {
  it('accepts a fully populated job', () => {
    const parsed = jobCreateSchema.safeParse({
      customer_id: VALID_UUID,
      quote_id: OTHER_UUID,
      status: 'booked',
      scheduled_at: '2026-04-20T09:00',
      notes: 'Bring the long wand.',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe('booked');
      expect(parsed.data.customer_id).toBe(VALID_UUID);
    }
  });

  it('defaults status to booked when omitted', () => {
    const parsed = jobCreateSchema.safeParse({
      customer_id: VALID_UUID,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe('booked');
    }
  });

  it('rejects a missing customer_id', () => {
    const parsed = jobCreateSchema.safeParse({
      customer_id: '',
      status: 'booked',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.customer_id?.[0]).toMatch(/pick a customer/i);
    }
  });

  it('rejects an invalid customer_id uuid', () => {
    const parsed = jobCreateSchema.safeParse({
      customer_id: 'not-a-uuid',
      status: 'booked',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown status', () => {
    const parsed = jobCreateSchema.safeParse({
      customer_id: VALID_UUID,
      status: 'pending',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an empty quote_id (no linked quote)', () => {
    const parsed = jobCreateSchema.safeParse({
      customer_id: VALID_UUID,
      quote_id: '',
      status: 'booked',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a malformed quote_id', () => {
    const parsed = jobCreateSchema.safeParse({
      customer_id: VALID_UUID,
      quote_id: 'not-a-uuid',
      status: 'booked',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an ISO datetime-local value for scheduled_at', () => {
    const parsed = jobCreateSchema.safeParse({
      customer_id: VALID_UUID,
      scheduled_at: '2026-04-20T09:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts empty notes and empty scheduled_at', () => {
    const parsed = jobCreateSchema.safeParse({
      customer_id: VALID_UUID,
      scheduled_at: '',
      notes: '',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects notes longer than 2000 characters', () => {
    const parsed = jobCreateSchema.safeParse({
      customer_id: VALID_UUID,
      notes: 'x'.repeat(2001),
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts all four statuses', () => {
    for (const status of ['booked', 'in_progress', 'complete', 'cancelled'] as const) {
      const parsed = jobCreateSchema.safeParse({
        customer_id: VALID_UUID,
        status,
      });
      expect(parsed.success).toBe(true);
    }
  });
});

describe('jobUpdateSchema', () => {
  it('requires a UUID id', () => {
    const parsed = jobUpdateSchema.safeParse({
      id: 'not-a-uuid',
      customer_id: VALID_UUID,
      status: 'booked',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a valid update payload', () => {
    const parsed = jobUpdateSchema.safeParse({
      id: VALID_UUID,
      customer_id: OTHER_UUID,
      status: 'in_progress',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('jobStatusChangeSchema', () => {
  it('accepts a valid transition', () => {
    const parsed = jobStatusChangeSchema.safeParse({
      id: VALID_UUID,
      status: 'complete',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a bad status', () => {
    const parsed = jobStatusChangeSchema.safeParse({
      id: VALID_UUID,
      status: 'done',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing id', () => {
    const parsed = jobStatusChangeSchema.safeParse({
      status: 'booked',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('emptyToNull', () => {
  it('converts empty and whitespace-only strings to null', () => {
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
