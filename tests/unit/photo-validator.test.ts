/**
 * Unit tests for the photo Zod validators.
 *
 * Covers tag enum enforcement, UUID validation on job_id/id, caption length
 * caps, and the empty-string-is-allowed contract that matches how the form
 * submits "no caption".
 */

import { describe, expect, it } from 'vitest';
import {
  emptyToNull,
  photoTags,
  photoUpdateSchema,
  photoUploadSchema,
} from '@/lib/validators/photo';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';
const OTHER_UUID = '99999999-8888-4777-8666-555555555555';

describe('photoUploadSchema', () => {
  it('accepts a fully populated upload', () => {
    const parsed = photoUploadSchema.safeParse({
      job_id: VALID_UUID,
      tag: 'before',
      caption: 'Front porch, wasps nest top-right',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tag).toBe('before');
      expect(parsed.data.job_id).toBe(VALID_UUID);
    }
  });

  it('defaults tag to other when omitted', () => {
    const parsed = photoUploadSchema.safeParse({ job_id: VALID_UUID });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tag).toBe('other');
    }
  });

  it('rejects a missing job_id', () => {
    const parsed = photoUploadSchema.safeParse({ tag: 'before' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a malformed job_id', () => {
    const parsed = photoUploadSchema.safeParse({
      job_id: 'not-a-uuid',
      tag: 'before',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown tag', () => {
    const parsed = photoUploadSchema.safeParse({
      job_id: VALID_UUID,
      tag: 'during',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts every tag in the enum', () => {
    for (const tag of photoTags) {
      const parsed = photoUploadSchema.safeParse({ job_id: VALID_UUID, tag });
      expect(parsed.success).toBe(true);
    }
  });

  it('accepts empty caption (no caption case)', () => {
    const parsed = photoUploadSchema.safeParse({
      job_id: VALID_UUID,
      tag: 'after',
      caption: '',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a caption over 500 chars', () => {
    const parsed = photoUploadSchema.safeParse({
      job_id: VALID_UUID,
      caption: 'x'.repeat(501),
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.caption?.[0]).toMatch(/at most 500/);
    }
  });
});

describe('photoUpdateSchema', () => {
  it('requires a UUID id', () => {
    const parsed = photoUpdateSchema.safeParse({
      id: 'not-a-uuid',
      tag: 'after',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a partial update (tag only)', () => {
    const parsed = photoUpdateSchema.safeParse({ id: VALID_UUID, tag: 'progress' });
    expect(parsed.success).toBe(true);
  });

  it('accepts a partial update (caption only)', () => {
    const parsed = photoUpdateSchema.safeParse({ id: VALID_UUID, caption: 'Rinse cycle' });
    expect(parsed.success).toBe(true);
  });

  it('accepts an id with neither optional field — the action treats it as a no-op', () => {
    const parsed = photoUpdateSchema.safeParse({ id: OTHER_UUID });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown tag on update', () => {
    const parsed = photoUpdateSchema.safeParse({ id: VALID_UUID, tag: 'sometime' });
    expect(parsed.success).toBe(false);
  });
});

describe('emptyToNull', () => {
  it('converts empty and whitespace to null', () => {
    expect(emptyToNull('')).toBeNull();
    expect(emptyToNull('   ')).toBeNull();
  });

  it('passes through trimmed values', () => {
    expect(emptyToNull('  hi  ')).toBe('hi');
  });

  it('passes through nullish', () => {
    expect(emptyToNull(null)).toBeNull();
    expect(emptyToNull(undefined)).toBeNull();
  });
});
