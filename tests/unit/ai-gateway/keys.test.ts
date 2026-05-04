/**
 * Multi-key env parsing + round-robin selection.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { parseKeyEnv, pickKey, resetCountersForTests } from '@/lib/ai-gateway/providers/keys';

afterEach(() => {
  resetCountersForTests();
});

describe('parseKeyEnv', () => {
  it('parses single key without label', () => {
    const keys = parseKeyEnv(undefined, 'sk-abc');
    expect(keys).toEqual([{ secret: 'sk-abc', label: 'default-0' }]);
  });

  it('parses multiple keys with labels', () => {
    const keys = parseKeyEnv('sk-1:personal,sk-2:heyhenry-prod', undefined);
    expect(keys).toEqual([
      { secret: 'sk-1', label: 'personal' },
      { secret: 'sk-2', label: 'heyhenry-prod' },
    ]);
  });

  it('mixes labeled and unlabeled', () => {
    const keys = parseKeyEnv('sk-1,sk-2:tagged', undefined);
    expect(keys).toEqual([
      { secret: 'sk-1', label: 'default-0' },
      { secret: 'sk-2', label: 'tagged' },
    ]);
  });

  it('falls back to singular env when plural is empty', () => {
    expect(parseKeyEnv(undefined, 'sk-fallback')).toEqual([
      { secret: 'sk-fallback', label: 'default-0' },
    ]);
    expect(parseKeyEnv('', 'sk-fallback')).toEqual([{ secret: 'sk-fallback', label: 'default-0' }]);
  });

  it('tolerates whitespace + trailing commas', () => {
    const keys = parseKeyEnv('  sk-1:a , sk-2:b ,', undefined);
    expect(keys).toEqual([
      { secret: 'sk-1', label: 'a' },
      { secret: 'sk-2', label: 'b' },
    ]);
  });

  it('returns empty when nothing configured', () => {
    expect(parseKeyEnv(undefined, undefined)).toEqual([]);
    expect(parseKeyEnv('', '')).toEqual([]);
  });
});

describe('pickKey', () => {
  const a = { secret: 'a', label: 'a' };
  const b = { secret: 'b', label: 'b' };
  const c = { secret: 'c', label: 'c' };

  it('returns undefined for empty pool', () => {
    expect(pickKey('test', [])).toBeUndefined();
  });

  it('round-robins through the pool', () => {
    expect(pickKey('rr', [a, b, c])).toBe(a);
    expect(pickKey('rr', [a, b, c])).toBe(b);
    expect(pickKey('rr', [a, b, c])).toBe(c);
    expect(pickKey('rr', [a, b, c])).toBe(a);
  });

  it('isolates counters per scope', () => {
    expect(pickKey('s1', [a, b])).toBe(a);
    expect(pickKey('s2', [a, b])).toBe(a);
    expect(pickKey('s1', [a, b])).toBe(b);
    expect(pickKey('s2', [a, b])).toBe(b);
  });
});
