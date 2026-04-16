/**
 * Unit tests for the worklog note Zod validators.
 *
 * Only `note`-type entries can be created / updated from the app, so the
 * schemas don't expose `entry_type`. System + milestone entries are written
 * by other tracks (e.g. job status changes).
 */

import { describe, expect, it } from 'vitest';
import {
  emptyToNull,
  worklogNoteCreateSchema,
  worklogNoteUpdateSchema,
} from '@/lib/validators/worklog';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';

describe('worklogNoteCreateSchema', () => {
  it('accepts a minimal note with title only', () => {
    const parsed = worklogNoteCreateSchema.safeParse({ title: 'Customer visit' });
    expect(parsed.success).toBe(true);
  });

  it('accepts a fully populated note', () => {
    const parsed = worklogNoteCreateSchema.safeParse({
      title: 'Customer visit notes',
      body: 'Talked about deck wash. Needs quote next week.',
      related_type: 'customer',
      related_id: VALID_UUID,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.related_type).toBe('customer');
    }
  });

  it('rejects an empty title', () => {
    const parsed = worklogNoteCreateSchema.safeParse({ title: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a whitespace-only title', () => {
    const parsed = worklogNoteCreateSchema.safeParse({ title: '   ' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a title longer than 200 characters', () => {
    const parsed = worklogNoteCreateSchema.safeParse({ title: 'a'.repeat(201) });
    expect(parsed.success).toBe(false);
  });

  it('rejects a body longer than 5000 characters', () => {
    const parsed = worklogNoteCreateSchema.safeParse({
      title: 'Long',
      body: 'b'.repeat(5001),
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts empty body', () => {
    const parsed = worklogNoteCreateSchema.safeParse({ title: 'Title', body: '' });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown related_type', () => {
    const parsed = worklogNoteCreateSchema.safeParse({
      title: 'Note',
      related_type: 'vendor',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a malformed related_id', () => {
    const parsed = worklogNoteCreateSchema.safeParse({
      title: 'Note',
      related_type: 'job',
      related_id: 'not-a-uuid',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts all four related_type values', () => {
    for (const related_type of ['customer', 'quote', 'job', 'invoice'] as const) {
      const parsed = worklogNoteCreateSchema.safeParse({
        title: 'x',
        related_type,
        related_id: VALID_UUID,
      });
      expect(parsed.success).toBe(true);
    }
  });
});

describe('worklogNoteUpdateSchema', () => {
  it('requires a UUID id', () => {
    const parsed = worklogNoteUpdateSchema.safeParse({
      id: 'not-a-uuid',
      title: 'x',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a valid update payload', () => {
    const parsed = worklogNoteUpdateSchema.safeParse({
      id: VALID_UUID,
      title: 'Updated note',
      body: 'Edited content.',
    });
    expect(parsed.success).toBe(true);
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
