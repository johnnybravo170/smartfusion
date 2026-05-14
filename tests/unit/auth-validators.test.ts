/**
 * Unit tests for the auth Zod validators.
 *
 * These are the last line of defense before we hit Supabase with junk
 * input — keep these tests strict.
 */

import { describe, expect, it } from 'vitest';
import { loginSchema, magicLinkSchema, signupSchema } from '@/lib/validators/auth';

describe('signupSchema', () => {
  it('accepts a valid signup payload', () => {
    const result = signupSchema.safeParse({
      email: 'will@example.com',
      password: 'correct-horse-9',
      firstName: 'Will',
      lastName: 'Smith',
      businessName: "Will's Painting Co",
      phone: '+1 604 555 1234',
      acceptedPolicies: true,
    });
    expect(result.success).toBe(true);
  });

  it('lowercases and trims the email', () => {
    const result = signupSchema.parse({
      email: '  Will@Example.COM  ',
      password: 'abc12345',
      firstName: 'Will',
      lastName: 'Smith',
      businessName: 'Acme',
      phone: '+1 604 555 1234',
      acceptedPolicies: true,
    });
    expect(result.email).toBe('will@example.com');
  });

  it('rejects a blank first name', () => {
    const result = signupSchema.safeParse({
      email: 'a@b.co',
      password: 'abc12345',
      firstName: '  ',
      lastName: 'Smith',
      businessName: 'Acme',
      phone: '+1 604 555 1234',
      acceptedPolicies: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing last name', () => {
    const result = signupSchema.safeParse({
      email: 'a@b.co',
      password: 'abc12345',
      firstName: 'Will',
      businessName: 'Acme',
      phone: '+1 604 555 1234',
      acceptedPolicies: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload that has not accepted policies', () => {
    const result = signupSchema.safeParse({
      email: 'a@b.co',
      password: 'abc12345',
      businessName: 'Acme',
      phone: '+1 604 555 1234',
      acceptedPolicies: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a password without a letter', () => {
    const result = signupSchema.safeParse({
      email: 'a@b.co',
      password: '12345678',
      businessName: 'Acme',
      phone: '+1 604 555 1234',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a password without a number', () => {
    const result = signupSchema.safeParse({
      email: 'a@b.co',
      password: 'abcdefgh',
      businessName: 'Acme',
      phone: '+1 604 555 1234',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a password shorter than 8 characters', () => {
    const result = signupSchema.safeParse({
      email: 'a@b.co',
      password: 'abc123',
      businessName: 'Acme',
      phone: '+1 604 555 1234',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a business name shorter than 2 characters', () => {
    const result = signupSchema.safeParse({
      email: 'a@b.co',
      password: 'abc12345',
      businessName: 'A',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a business name longer than 100 characters', () => {
    const result = signupSchema.safeParse({
      email: 'a@b.co',
      password: 'abc12345',
      businessName: 'A'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid email', () => {
    const result = signupSchema.safeParse({
      email: 'not-an-email',
      password: 'abc12345',
      businessName: 'Acme',
      phone: '+1 604 555 1234',
    });
    expect(result.success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('accepts a valid login payload', () => {
    const result = loginSchema.safeParse({
      email: 'will@example.com',
      password: 'whatever',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty password', () => {
    const result = loginSchema.safeParse({
      email: 'will@example.com',
      password: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid email', () => {
    const result = loginSchema.safeParse({
      email: 'not-an-email',
      password: 'x',
    });
    expect(result.success).toBe(false);
  });
});

describe('magicLinkSchema', () => {
  it('accepts a valid email', () => {
    const result = magicLinkSchema.safeParse({ email: 'will@example.com' });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid email', () => {
    const result = magicLinkSchema.safeParse({ email: 'nope' });
    expect(result.success).toBe(false);
  });
});
