/**
 * Unit tests for the todo Zod validators.
 *
 * Covers title enforcement, UUID validation on related_id / id, the four
 * related_type enums, and the "empty string is allowed" contract for
 * optional fields.
 */

import { describe, expect, it } from 'vitest';
import {
  emptyToNull,
  todoCreateSchema,
  todoToggleSchema,
  todoUpdateSchema,
} from '@/lib/validators/todo';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';
const OTHER_UUID = '99999999-8888-4777-8666-555555555555';

describe('todoCreateSchema', () => {
  it('accepts a minimal todo with just a title', () => {
    const parsed = todoCreateSchema.safeParse({ title: 'Call Sarah' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.title).toBe('Call Sarah');
    }
  });

  it('accepts a fully populated todo', () => {
    const parsed = todoCreateSchema.safeParse({
      title: 'Follow up on deck quote',
      due_date: '2026-04-20',
      related_type: 'quote',
      related_id: VALID_UUID,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.related_type).toBe('quote');
      expect(parsed.data.related_id).toBe(VALID_UUID);
    }
  });

  it('rejects an empty title', () => {
    const parsed = todoCreateSchema.safeParse({ title: '' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.title?.[0]).toMatch(/required/i);
    }
  });

  it('rejects a whitespace-only title', () => {
    const parsed = todoCreateSchema.safeParse({ title: '   ' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a title longer than 200 characters', () => {
    const parsed = todoCreateSchema.safeParse({ title: 'x'.repeat(201) });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown related_type', () => {
    const parsed = todoCreateSchema.safeParse({
      title: 'Call Sarah',
      related_type: 'something_else',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an empty related_id alongside no related_type', () => {
    const parsed = todoCreateSchema.safeParse({
      title: 'Call Sarah',
      related_id: '',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a malformed related_id', () => {
    const parsed = todoCreateSchema.safeParse({
      title: 'Call Sarah',
      related_type: 'customer',
      related_id: 'not-a-uuid',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts all four related_type values', () => {
    for (const related_type of ['customer', 'quote', 'job', 'invoice'] as const) {
      const parsed = todoCreateSchema.safeParse({
        title: 'x',
        related_type,
        related_id: VALID_UUID,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('accepts empty due_date', () => {
    const parsed = todoCreateSchema.safeParse({ title: 'Call', due_date: '' });
    expect(parsed.success).toBe(true);
  });
});

describe('todoUpdateSchema', () => {
  it('requires a UUID id', () => {
    const parsed = todoUpdateSchema.safeParse({
      id: 'not-a-uuid',
      title: 'Call Sarah',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a valid update payload', () => {
    const parsed = todoUpdateSchema.safeParse({
      id: VALID_UUID,
      title: 'Call Sarah',
      related_type: 'customer',
      related_id: OTHER_UUID,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('todoToggleSchema', () => {
  it('accepts a valid toggle', () => {
    const parsed = todoToggleSchema.safeParse({ id: VALID_UUID, done: true });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-boolean done', () => {
    const parsed = todoToggleSchema.safeParse({ id: VALID_UUID, done: 'yes' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing id', () => {
    const parsed = todoToggleSchema.safeParse({ done: true });
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
