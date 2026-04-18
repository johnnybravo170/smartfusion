/**
 * Unit tests for the change order Zod validators.
 */

import { describe, expect, it } from 'vitest';
import { changeOrderApprovalSchema, changeOrderCreateSchema } from '@/lib/validators/change-order';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';
const BUCKET_UUID = '22222222-3333-4444-8555-666666666666';

describe('changeOrderCreateSchema', () => {
  it('accepts a fully populated change order', () => {
    const parsed = changeOrderCreateSchema.safeParse({
      project_id: VALID_UUID,
      title: 'Add pot lights to kitchen',
      description: 'Customer wants 6 pot lights installed in the kitchen ceiling.',
      reason: 'Requested during walkthrough',
      cost_impact_cents: 125000,
      timeline_impact_days: 3,
      affected_buckets: [BUCKET_UUID],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.title).toBe('Add pot lights to kitchen');
      expect(parsed.data.cost_impact_cents).toBe(125000);
      expect(parsed.data.timeline_impact_days).toBe(3);
      expect(parsed.data.affected_buckets).toEqual([BUCKET_UUID]);
    }
  });

  it('accepts negative cost impact (credits)', () => {
    const parsed = changeOrderCreateSchema.safeParse({
      project_id: VALID_UUID,
      title: 'Remove backsplash upgrade',
      description: 'Customer decided against upgraded backsplash.',
      cost_impact_cents: -50000,
      timeline_impact_days: -2,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cost_impact_cents).toBe(-50000);
      expect(parsed.data.timeline_impact_days).toBe(-2);
    }
  });

  it('defaults affected_buckets to empty array', () => {
    const parsed = changeOrderCreateSchema.safeParse({
      project_id: VALID_UUID,
      title: 'Test',
      description: 'Test description',
      cost_impact_cents: 0,
      timeline_impact_days: 0,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.affected_buckets).toEqual([]);
    }
  });

  it('rejects missing title', () => {
    const parsed = changeOrderCreateSchema.safeParse({
      project_id: VALID_UUID,
      title: '',
      description: 'Test',
      cost_impact_cents: 0,
      timeline_impact_days: 0,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.title?.[0]).toMatch(/required/i);
    }
  });

  it('rejects missing description', () => {
    const parsed = changeOrderCreateSchema.safeParse({
      project_id: VALID_UUID,
      title: 'Test',
      description: '',
      cost_impact_cents: 0,
      timeline_impact_days: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects invalid project_id', () => {
    const parsed = changeOrderCreateSchema.safeParse({
      project_id: 'not-a-uuid',
      title: 'Test',
      description: 'Test',
      cost_impact_cents: 0,
      timeline_impact_days: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects title over 200 characters', () => {
    const parsed = changeOrderCreateSchema.safeParse({
      project_id: VALID_UUID,
      title: 'x'.repeat(201),
      description: 'Test',
      cost_impact_cents: 0,
      timeline_impact_days: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('coerces string numbers for cost and timeline', () => {
    const parsed = changeOrderCreateSchema.safeParse({
      project_id: VALID_UUID,
      title: 'Test',
      description: 'Test description',
      cost_impact_cents: '50000',
      timeline_impact_days: '5',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cost_impact_cents).toBe(50000);
      expect(parsed.data.timeline_impact_days).toBe(5);
    }
  });

  it('accepts optional empty reason', () => {
    const parsed = changeOrderCreateSchema.safeParse({
      project_id: VALID_UUID,
      title: 'Test',
      description: 'Test description',
      cost_impact_cents: 0,
      timeline_impact_days: 0,
      reason: '',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('changeOrderApprovalSchema', () => {
  it('accepts a valid name', () => {
    const parsed = changeOrderApprovalSchema.safeParse({
      approved_by_name: 'John Smith',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.approved_by_name).toBe('John Smith');
    }
  });

  it('trims whitespace', () => {
    const parsed = changeOrderApprovalSchema.safeParse({
      approved_by_name: '  Jane Doe  ',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.approved_by_name).toBe('Jane Doe');
    }
  });

  it('rejects empty name', () => {
    const parsed = changeOrderApprovalSchema.safeParse({
      approved_by_name: '',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.approved_by_name?.[0]).toMatch(/name/i);
    }
  });

  it('rejects whitespace-only name', () => {
    const parsed = changeOrderApprovalSchema.safeParse({
      approved_by_name: '   ',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects name over 200 characters', () => {
    const parsed = changeOrderApprovalSchema.safeParse({
      approved_by_name: 'x'.repeat(201),
    });
    expect(parsed.success).toBe(false);
  });
});
