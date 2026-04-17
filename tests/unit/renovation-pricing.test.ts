/**
 * Unit tests for renovation pricing functions.
 *
 * 100% coverage of all pure functions. Edge cases: zero buckets, zero rate,
 * large numbers, rounding.
 */

import { describe, expect, it } from 'vitest';
import {
  calculateBucketTotal,
  calculateManagementFee,
  calculateRenovationTotal,
} from '@/lib/pricing/renovation-quote';

describe('calculateBucketTotal', () => {
  it('sums all bucket estimates', () => {
    const buckets = [
      { estimate_cents: 500000 },
      { estimate_cents: 300000 },
      { estimate_cents: 200000 },
    ];
    expect(calculateBucketTotal(buckets)).toBe(1000000);
  });

  it('returns 0 for empty array', () => {
    expect(calculateBucketTotal([])).toBe(0);
  });

  it('handles a single bucket', () => {
    expect(calculateBucketTotal([{ estimate_cents: 750000 }])).toBe(750000);
  });

  it('handles large numbers', () => {
    const buckets = Array.from({ length: 30 }, () => ({ estimate_cents: 1000000 }));
    expect(calculateBucketTotal(buckets)).toBe(30000000); // $300,000
  });

  it('handles zero-value buckets', () => {
    const buckets = [{ estimate_cents: 500000 }, { estimate_cents: 0 }, { estimate_cents: 300000 }];
    expect(calculateBucketTotal(buckets)).toBe(800000);
  });
});

describe('calculateManagementFee', () => {
  it('calculates 12% fee', () => {
    expect(calculateManagementFee(1000000, 0.12)).toBe(120000);
  });

  it('calculates 0% fee', () => {
    expect(calculateManagementFee(1000000, 0)).toBe(0);
  });

  it('calculates 100% fee', () => {
    expect(calculateManagementFee(500000, 1.0)).toBe(500000);
  });

  it('rounds to nearest cent', () => {
    // 333333 * 0.12 = 39999.96 → 40000
    expect(calculateManagementFee(333333, 0.12)).toBe(40000);
  });

  it('rounds correctly for awkward amounts', () => {
    // 123456 * 0.12 = 14814.72 → 14815
    expect(calculateManagementFee(123456, 0.12)).toBe(14815);
  });

  it('handles zero subtotal', () => {
    expect(calculateManagementFee(0, 0.12)).toBe(0);
  });
});

describe('calculateRenovationTotal', () => {
  it('calculates full total: subtotal + fee + GST', () => {
    const buckets = [
      { estimate_cents: 500000 }, // $5,000
      { estimate_cents: 300000 }, // $3,000
    ];
    const result = calculateRenovationTotal(buckets, 0.12, 0.05);

    expect(result.subtotal_cents).toBe(800000); // $8,000
    expect(result.fee_cents).toBe(96000); // $960 (12% of $8,000)
    // GST on $8,960 = $448
    expect(result.gst_cents).toBe(44800);
    expect(result.total_cents).toBe(800000 + 96000 + 44800); // $9,408
  });

  it('handles empty buckets', () => {
    const result = calculateRenovationTotal([], 0.12, 0.05);
    expect(result.subtotal_cents).toBe(0);
    expect(result.fee_cents).toBe(0);
    expect(result.gst_cents).toBe(0);
    expect(result.total_cents).toBe(0);
  });

  it('handles zero fee rate', () => {
    const buckets = [{ estimate_cents: 1000000 }];
    const result = calculateRenovationTotal(buckets, 0, 0.05);
    expect(result.fee_cents).toBe(0);
    expect(result.gst_cents).toBe(50000); // 5% of $10,000
    expect(result.total_cents).toBe(1050000);
  });

  it('handles zero GST rate', () => {
    const buckets = [{ estimate_cents: 1000000 }];
    const result = calculateRenovationTotal(buckets, 0.12, 0);
    expect(result.subtotal_cents).toBe(1000000);
    expect(result.fee_cents).toBe(120000);
    expect(result.gst_cents).toBe(0);
    expect(result.total_cents).toBe(1120000);
  });

  it('rounds GST correctly for awkward amounts', () => {
    const buckets = [{ estimate_cents: 123456 }];
    const result = calculateRenovationTotal(buckets, 0.12, 0.05);
    // subtotal = 123456
    // fee = 14815 (rounded)
    // before tax = 138271
    // GST = 138271 * 0.05 = 6913.55 → 6914
    expect(result.subtotal_cents).toBe(123456);
    expect(result.fee_cents).toBe(14815);
    expect(result.gst_cents).toBe(6914);
    expect(result.total_cents).toBe(123456 + 14815 + 6914);
  });

  it('handles Jon-style real renovation numbers', () => {
    // Typical renovation: $50k interior + $20k exterior
    const buckets = [
      { estimate_cents: 5000000 }, // $50,000
      { estimate_cents: 2000000 }, // $20,000
    ];
    const result = calculateRenovationTotal(buckets, 0.12, 0.05);
    expect(result.subtotal_cents).toBe(7000000); // $70,000
    expect(result.fee_cents).toBe(840000); // $8,400
    // GST on $78,400 = $3,920
    expect(result.gst_cents).toBe(392000);
    expect(result.total_cents).toBe(8232000); // $82,320
  });
});
