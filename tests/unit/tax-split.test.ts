/**
 * Unit tests for the GST/HST inclusive→breakdown splitter used by the
 * expense form auto-split chip.
 */

import { describe, expect, it } from 'vitest';
import { splitTotalByRate } from '@/lib/expenses/tax-split';

describe('splitTotalByRate', () => {
  it('splits $113 at 13% HST cleanly', () => {
    expect(splitTotalByRate(11300, 0.13)).toEqual({
      preTaxCents: 10000,
      taxCents: 1300,
    });
  });

  it('splits $1.13 at 13% HST', () => {
    expect(splitTotalByRate(113, 0.13)).toEqual({
      preTaxCents: 100,
      taxCents: 13,
    });
  });

  it('splits $5.00 at 5% GST', () => {
    expect(splitTotalByRate(500, 0.05)).toEqual({
      preTaxCents: 476,
      taxCents: 24,
    });
  });

  it('handles 12% combined GST+PST (BC)', () => {
    expect(splitTotalByRate(11200, 0.12)).toEqual({
      preTaxCents: 10000,
      taxCents: 1200,
    });
  });

  it('preserves total exactly under rounding drift', () => {
    // 13% on $33.33 — naive rounding can drop or add a cent. The
    // splitter must always preserve preTax + tax = total exactly.
    const { preTaxCents, taxCents } = splitTotalByRate(3333, 0.13);
    expect(preTaxCents + taxCents).toBe(3333);
  });

  it('preserves total across many awkward inputs', () => {
    // Property-style sweep — the invariant is non-negotiable.
    for (let total = 1; total < 100_000; total += 137) {
      for (const rate of [0.05, 0.12, 0.13, 0.15]) {
        const { preTaxCents, taxCents } = splitTotalByRate(total, rate);
        expect(preTaxCents + taxCents).toBe(total);
      }
    }
  });

  it('returns zeros for non-positive totals', () => {
    expect(splitTotalByRate(0, 0.13)).toEqual({ preTaxCents: 0, taxCents: 0 });
    expect(splitTotalByRate(-100, 0.13)).toEqual({ preTaxCents: 0, taxCents: 0 });
  });

  it('passes total through unchanged when rate is zero', () => {
    expect(splitTotalByRate(11300, 0)).toEqual({
      preTaxCents: 11300,
      taxCents: 0,
    });
  });

  it('handles non-finite totals safely', () => {
    expect(splitTotalByRate(Number.NaN, 0.13)).toEqual({ preTaxCents: 0, taxCents: 0 });
    expect(splitTotalByRate(Number.POSITIVE_INFINITY, 0.13)).toEqual({
      preTaxCents: 0,
      taxCents: 0,
    });
  });
});
