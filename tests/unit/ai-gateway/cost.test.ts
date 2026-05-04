import { describe, expect, it } from 'vitest';
import {
  computeCostMicros,
  lookupRates,
  type ModelRates,
  usdPerMillionToMicros,
} from '@/lib/ai-gateway/providers/cost';

describe('usdPerMillionToMicros', () => {
  it('$0.15/M → 15 micros/token', () => {
    expect(usdPerMillionToMicros(0.15)).toBe(15);
  });
  it('$2.50/M → 250 micros/token', () => {
    expect(usdPerMillionToMicros(2.5)).toBe(250);
  });
  it('$15/M → 1500 micros/token', () => {
    expect(usdPerMillionToMicros(15)).toBe(1500);
  });
});

describe('computeCostMicros', () => {
  const rates: ModelRates = { input_micros_per_token: 15, output_micros_per_token: 60 };

  it('multiplies input + output rates', () => {
    expect(computeCostMicros(1000, 500, rates)).toBe(BigInt(1000 * 15 + 500 * 60));
  });

  it('handles zero tokens', () => {
    expect(computeCostMicros(0, 0, rates)).toBe(BigInt(0));
  });

  it('preserves precision for huge call counts', () => {
    // 10M input tokens * 15 micros = 150M micros = 1.5 cents
    expect(computeCostMicros(10_000_000, 0, rates)).toBe(BigInt(150_000_000));
  });
});

describe('lookupRates', () => {
  const table: Record<string, ModelRates> = {
    'gpt-4o-mini': { input_micros_per_token: 15, output_micros_per_token: 60 },
    'gpt-4o': { input_micros_per_token: 250, output_micros_per_token: 1000 },
    '*': { input_micros_per_token: 100, output_micros_per_token: 400 },
  };

  it('exact match wins', () => {
    expect(lookupRates(table, 'gpt-4o')).toBe(table['gpt-4o']);
  });

  it('prefix match falls through versioned model ids', () => {
    expect(lookupRates(table, 'gpt-4o-mini-2024-07-18')).toBe(table['gpt-4o-mini']);
  });

  it('falls back to wildcard when no prefix matches', () => {
    expect(lookupRates(table, 'completely-unknown-model')).toBe(table['*']);
  });

  it('returns zero rates if neither match nor wildcard', () => {
    const noWildcard = { 'gpt-4o': table['gpt-4o'] };
    expect(lookupRates(noWildcard, 'mystery')).toEqual({
      input_micros_per_token: 0,
      output_micros_per_token: 0,
    });
  });
});
