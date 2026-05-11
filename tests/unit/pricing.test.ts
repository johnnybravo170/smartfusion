/**
 * Unit tests for the pricing calculator.
 *
 * 100% coverage of all pure functions. Edge cases: min charge, zero sqft,
 * tax rounding, empty arrays, large numbers, fractional sqft.
 */

import { describe, expect, it } from 'vitest';
import {
  type CatalogEntry,
  calculateQuoteTotal,
  calculateSurfacePrice,
  formatCurrency,
  type SurfaceInput,
} from '@/lib/pricing/calculator';

const DRIVEWAY: CatalogEntry = {
  pricing_model: 'per_unit',
  unit_price_cents: 15, // $0.15/sqft
  min_charge_cents: 5000, // $50 minimum
  unit_label: 'sqft',
};

const SIDING: CatalogEntry = {
  pricing_model: 'per_unit',
  unit_price_cents: 25,
  min_charge_cents: 7500,
  unit_label: 'sqft',
};

describe('calculateSurfacePrice', () => {
  it('computes normal price when above minimum', () => {
    const surface: SurfaceInput = { surface_type: 'driveway', sqft: 500 };
    // 500 * 15 = 7500 cents ($75), above $50 min
    expect(calculateSurfacePrice(surface, DRIVEWAY)).toBe(7500);
  });

  it('uses minimum charge when computed price is below', () => {
    const surface: SurfaceInput = { surface_type: 'driveway', sqft: 100 };
    // 100 * 15 = 1500 cents ($15), below $50 min → $50
    expect(calculateSurfacePrice(surface, DRIVEWAY)).toBe(5000);
  });

  it('returns min charge when sqft is zero', () => {
    const surface: SurfaceInput = { surface_type: 'driveway', sqft: 0 };
    // 0 * 15 = 0, below min → $50
    expect(calculateSurfacePrice(surface, DRIVEWAY)).toBe(5000);
  });

  it('handles fractional sqft with proper rounding', () => {
    const surface: SurfaceInput = { surface_type: 'driveway', sqft: 333.33 };
    // 333.33 * 15 = 4999.95 → rounds to 5000
    expect(calculateSurfacePrice(surface, DRIVEWAY)).toBe(5000);
  });

  it('handles very large areas', () => {
    const surface: SurfaceInput = { surface_type: 'driveway', sqft: 10000 };
    // 10000 * 15 = 150000 cents ($1500)
    expect(calculateSurfacePrice(surface, DRIVEWAY)).toBe(150000);
  });

  it('returns exact min when computed equals min', () => {
    const surface: SurfaceInput = { surface_type: 'siding', sqft: 300 };
    // 300 * 25 = 7500 = min charge exactly
    expect(calculateSurfacePrice(surface, SIDING)).toBe(7500);
  });

  it('rounds computed price to nearest cent', () => {
    const catalog: CatalogEntry = {
      pricing_model: 'per_unit',
      unit_price_cents: 13, // $0.13/sqft
      min_charge_cents: 0,
      unit_label: 'sqft',
    };
    const surface: SurfaceInput = { surface_type: 'test', sqft: 7.7 };
    // 7.7 * 13 = 100.1 → rounds to 100
    expect(calculateSurfacePrice(surface, catalog)).toBe(100);
  });

  it('throws when given a non-per_unit pricing_model', () => {
    const flat: CatalogEntry = {
      pricing_model: 'fixed',
      unit_price_cents: 5000,
      min_charge_cents: null,
    };
    expect(() => calculateSurfacePrice({ surface_type: 'test', sqft: 100 }, flat)).toThrow(
      /pricing_model='per_unit'/,
    );
  });

  it('treats null unit_price/min_charge as zero', () => {
    const empty: CatalogEntry = {
      pricing_model: 'per_unit',
      unit_price_cents: null,
      min_charge_cents: null,
    };
    expect(calculateSurfacePrice({ surface_type: 'test', sqft: 100 }, empty)).toBe(0);
  });
});

describe('calculateQuoteTotal', () => {
  it('sums a single surface with tax', () => {
    const result = calculateQuoteTotal([{ price_cents: 10000 }], 0.05);
    expect(result).toEqual({
      subtotal_cents: 10000,
      tax_cents: 500,
      total_cents: 10500,
    });
  });

  it('sums multiple surfaces with tax', () => {
    const surfaces = [{ price_cents: 7500 }, { price_cents: 12000 }, { price_cents: 5000 }];
    const result = calculateQuoteTotal(surfaces, 0.05);
    expect(result.subtotal_cents).toBe(24500);
    expect(result.tax_cents).toBe(1225);
    expect(result.total_cents).toBe(25725);
  });

  it('handles empty surfaces array', () => {
    const result = calculateQuoteTotal([], 0.05);
    expect(result).toEqual({
      subtotal_cents: 0,
      tax_cents: 0,
      total_cents: 0,
    });
  });

  it('rounds tax to nearest cent', () => {
    // 999 * 0.05 = 49.95 → rounds to 50
    const result = calculateQuoteTotal([{ price_cents: 999 }], 0.05);
    expect(result.tax_cents).toBe(50);
    expect(result.total_cents).toBe(1049);
  });

  it('handles zero tax rate', () => {
    const result = calculateQuoteTotal([{ price_cents: 10000 }], 0);
    expect(result).toEqual({
      subtotal_cents: 10000,
      tax_cents: 0,
      total_cents: 10000,
    });
  });

  it('handles large totals', () => {
    const surfaces = Array.from({ length: 20 }, () => ({ price_cents: 50000 }));
    const result = calculateQuoteTotal(surfaces, 0.05);
    expect(result.subtotal_cents).toBe(1000000); // $10,000
    expect(result.tax_cents).toBe(50000); // $500 GST
    expect(result.total_cents).toBe(1050000); // $10,500
  });

  it('rounds tax correctly for awkward subtotals', () => {
    // 1234 * 0.05 = 61.7 → rounds to 62
    const result = calculateQuoteTotal([{ price_cents: 1234 }], 0.05);
    expect(result.tax_cents).toBe(62);
    expect(result.total_cents).toBe(1296);
  });
});

describe('formatCurrency', () => {
  it('formats a positive amount', () => {
    const result = formatCurrency(12345);
    expect(result).toMatch(/\$123\.45/);
  });

  it('formats zero', () => {
    const result = formatCurrency(0);
    expect(result).toMatch(/\$0\.00/);
  });

  it('formats a large amount with thousands separator', () => {
    const result = formatCurrency(1234567);
    // en-CA uses comma for thousands
    expect(result).toMatch(/12,345\.67/);
  });

  it('formats exact dollar amounts (no leftover cents)', () => {
    const result = formatCurrency(10000);
    expect(result).toMatch(/\$100\.00/);
  });

  it('preserves cents precision', () => {
    const result = formatCurrency(1);
    expect(result).toMatch(/\$0\.01/);
  });
});
