/**
 * Unit tests for the From-header normaliser used by the inbound email
 * sender resolver. The DB-backed RPC half is verified in integration.
 */

import { describe, expect, it } from 'vitest';
import { normaliseEmail } from '@/lib/inbound-email/sender-resolver';

describe('normaliseEmail', () => {
  it('strips display name', () => {
    expect(normaliseEmail('Jonathan B <jonathan@heyhenry.io>')).toBe('jonathan@heyhenry.io');
  });

  it('lowercases mixed-case addresses', () => {
    expect(normaliseEmail('Jonathan@HeyHenry.IO')).toBe('jonathan@heyhenry.io');
  });

  it('trims surrounding whitespace', () => {
    expect(normaliseEmail('  jvd@example.com  ')).toBe('jvd@example.com');
  });

  it('handles display name with quoted parts', () => {
    expect(normaliseEmail('"JVD" <jvd@example.com>')).toBe('jvd@example.com');
  });

  it('returns the bare address when there is no display name', () => {
    expect(normaliseEmail('jvd@example.com')).toBe('jvd@example.com');
  });
});
