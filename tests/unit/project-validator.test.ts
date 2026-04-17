/**
 * Unit tests for the project Zod validators.
 */

import { describe, expect, it } from 'vitest';
import {
  emptyToNull,
  projectCreateSchema,
  projectStatusChangeSchema,
  projectUpdateSchema,
} from '@/lib/validators/project';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';
const OTHER_UUID = '99999999-8888-4777-8666-555555555555';

describe('projectCreateSchema', () => {
  it('accepts a fully populated project', () => {
    const parsed = projectCreateSchema.safeParse({
      customer_id: VALID_UUID,
      name: 'Main St Renovation',
      description: 'Full interior + exterior',
      start_date: '2026-05-01',
      target_end_date: '2026-08-01',
      management_fee_rate: 0.12,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe('Main St Renovation');
      expect(parsed.data.management_fee_rate).toBe(0.12);
    }
  });

  it('defaults management_fee_rate to 0.12', () => {
    const parsed = projectCreateSchema.safeParse({
      customer_id: VALID_UUID,
      name: 'Test Project',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.management_fee_rate).toBe(0.12);
    }
  });

  it('rejects missing customer_id', () => {
    const parsed = projectCreateSchema.safeParse({
      customer_id: '',
      name: 'Test',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects missing name', () => {
    const parsed = projectCreateSchema.safeParse({
      customer_id: VALID_UUID,
      name: '',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.name?.[0]).toMatch(/required/i);
    }
  });

  it('rejects name longer than 200 characters', () => {
    const parsed = projectCreateSchema.safeParse({
      customer_id: VALID_UUID,
      name: 'x'.repeat(201),
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts empty optional fields', () => {
    const parsed = projectCreateSchema.safeParse({
      customer_id: VALID_UUID,
      name: 'Test',
      description: '',
      start_date: '',
      target_end_date: '',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid customer_id uuid', () => {
    const parsed = projectCreateSchema.safeParse({
      customer_id: 'not-a-uuid',
      name: 'Test',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects negative management_fee_rate', () => {
    const parsed = projectCreateSchema.safeParse({
      customer_id: VALID_UUID,
      name: 'Test',
      management_fee_rate: -0.1,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects management_fee_rate over 100%', () => {
    const parsed = projectCreateSchema.safeParse({
      customer_id: VALID_UUID,
      name: 'Test',
      management_fee_rate: 1.5,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('projectUpdateSchema', () => {
  it('requires a UUID id', () => {
    const parsed = projectUpdateSchema.safeParse({
      id: 'not-a-uuid',
      customer_id: VALID_UUID,
      name: 'Test',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a valid update payload', () => {
    const parsed = projectUpdateSchema.safeParse({
      id: VALID_UUID,
      customer_id: OTHER_UUID,
      name: 'Updated Name',
      status: 'in_progress',
      percent_complete: 50,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts all four statuses', () => {
    for (const status of ['planning', 'in_progress', 'complete', 'cancelled'] as const) {
      const parsed = projectUpdateSchema.safeParse({
        id: VALID_UUID,
        customer_id: VALID_UUID,
        name: 'Test',
        status,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects percent_complete outside 0-100', () => {
    const over = projectUpdateSchema.safeParse({
      id: VALID_UUID,
      customer_id: VALID_UUID,
      name: 'Test',
      percent_complete: 101,
    });
    expect(over.success).toBe(false);

    const under = projectUpdateSchema.safeParse({
      id: VALID_UUID,
      customer_id: VALID_UUID,
      name: 'Test',
      percent_complete: -1,
    });
    expect(under.success).toBe(false);
  });
});

describe('projectStatusChangeSchema', () => {
  it('accepts a valid status change', () => {
    const parsed = projectStatusChangeSchema.safeParse({
      id: VALID_UUID,
      status: 'complete',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an invalid status', () => {
    const parsed = projectStatusChangeSchema.safeParse({
      id: VALID_UUID,
      status: 'done',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing id', () => {
    const parsed = projectStatusChangeSchema.safeParse({
      status: 'planning',
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
