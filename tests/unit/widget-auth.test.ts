import { describe, expect, it } from 'vitest';

import { extractBearerToken, generateWidgetToken, isOriginAllowed } from '@/lib/widget/auth';

describe('generateWidgetToken', () => {
  it('produces the wgt_<base64url> shape', () => {
    const token = generateWidgetToken();
    expect(token).toMatch(/^wgt_[A-Za-z0-9_-]+$/);
    // 18 random bytes → 24 base64url chars
    expect(token.length).toBe(4 + 24);
  });

  it('returns distinct tokens on repeated calls', () => {
    const tokens = new Set([generateWidgetToken(), generateWidgetToken(), generateWidgetToken()]);
    expect(tokens.size).toBe(3);
  });
});

describe('extractBearerToken', () => {
  it('parses a valid Bearer header', () => {
    expect(extractBearerToken('Bearer wgt_abc123')).toBe('wgt_abc123');
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer wgt_xyz')).toBe('wgt_xyz');
    expect(extractBearerToken('BEARER wgt_xyz')).toBe('wgt_xyz');
  });

  it('rejects non-Bearer schemes', () => {
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('Token wgt_x')).toBeNull();
  });

  it('returns null for missing / empty headers', () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
  });

  it('rejects malformed bearer headers', () => {
    expect(extractBearerToken('Bearer')).toBeNull();
    // Two values after Bearer — only single-token shape passes.
    expect(extractBearerToken('Bearer wgt_a wgt_b')).toBeNull();
  });
});

describe('isOriginAllowed', () => {
  it('allows any origin when allow-list is empty (V1 default)', () => {
    expect(isOriginAllowed('https://connectcontracting.ca', [])).toBe(true);
    expect(isOriginAllowed(null, [])).toBe(true);
  });

  it('requires origin to match the allow-list when non-empty', () => {
    const list = ['https://connectcontracting.ca'];
    expect(isOriginAllowed('https://connectcontracting.ca', list)).toBe(true);
    expect(isOriginAllowed('https://other.com', list)).toBe(false);
  });

  it('rejects missing origin when allow-list is non-empty', () => {
    expect(isOriginAllowed(null, ['https://connectcontracting.ca'])).toBe(false);
  });

  it('normalises trailing slashes and case', () => {
    const list = ['https://Connectcontracting.CA/'];
    expect(isOriginAllowed('https://connectcontracting.ca', list)).toBe(true);
    expect(isOriginAllowed('https://CONNECTCONTRACTING.ca/', list)).toBe(true);
  });
});
