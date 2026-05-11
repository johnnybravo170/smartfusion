import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// Set deterministic env BEFORE importing the module under test — env is
// read at first call via getQboEnv().
beforeAll(() => {
  process.env.QBO_CLIENT_ID = 'test_client_id';
  process.env.QBO_CLIENT_SECRET = 'test_client_secret';
  process.env.QBO_REDIRECT_URI = 'http://localhost:3000/api/qbo/callback';
  process.env.QBO_STATE_SECRET = `unit-test-hmac-secret-${'x'.repeat(40)}`;
});

import { signState, verifyState } from '@/lib/qbo/oauth';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

describe('signState + verifyState', () => {
  it('round-trips a valid state', () => {
    const state = signState(TENANT_ID);
    const parsed = verifyState(state);
    expect(parsed).not.toBeNull();
    expect(parsed?.tenantId).toBe(TENANT_ID);
    expect(parsed?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('mints a fresh nonce per call', () => {
    const a = signState(TENANT_ID);
    const b = signState(TENANT_ID);
    expect(a).not.toBe(b);
  });

  it('rejects tampered payload', () => {
    const state = signState(TENANT_ID);
    const [body, sig] = state.split('.');
    const flipped = `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyState(`${flipped}.${sig}`)).toBeNull();
  });

  it('rejects tampered signature', () => {
    const state = signState(TENANT_ID);
    const [body, sig] = state.split('.');
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyState(`${body}.${flipped}`)).toBeNull();
  });

  it('rejects malformed state (missing separator)', () => {
    expect(verifyState('no-dot-here')).toBeNull();
    expect(verifyState('')).toBeNull();
  });

  it('rejects expired state', () => {
    const realDateNow = Date.now;
    try {
      const state = signState(TENANT_ID);
      // Jump 1 hour forward — well past the 10 min TTL.
      Date.now = () => realDateNow() + 60 * 60 * 1000;
      expect(verifyState(state)).toBeNull();
    } finally {
      Date.now = realDateNow;
    }
  });
});

afterEach(() => {
  // nothing — env is set once for the whole file
});
