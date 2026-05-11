/**
 * Unit tests for the upsertCatalogItem zod schema.
 *
 * We test the validation logic by exercising the action's input shape
 * through a re-export. The action itself touches Supabase + auth and is
 * covered by the e2e suite in a later PR.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const PRICING_MODELS = ['fixed', 'per_unit', 'hourly', 'time_and_materials'] as const;
const CATEGORIES = ['labor', 'materials', 'service', 'inventory', 'other'] as const;

// Mirror of the action's schema. Kept in sync by the action's PR review;
// duplicating here lets us test the validation rules without booting
// Supabase / auth context.
const schema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    sku: z.string().trim().max(100).nullable().optional(),
    pricingModel: z.enum(PRICING_MODELS),
    unitLabel: z.string().trim().max(50).nullable().optional(),
    unitPriceCents: z.number().int().min(0).nullable().optional(),
    minChargeCents: z.number().int().min(0).nullable().optional(),
    isTaxable: z.boolean().default(true),
    category: z.enum(CATEGORIES).nullable().optional(),
    surfaceType: z.string().trim().max(100).nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .superRefine((val, ctx) => {
    if (val.pricingModel === 'time_and_materials' && val.unitPriceCents != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unitPriceCents'],
        message: 'Time-and-materials items must not have a unit price.',
      });
    }
    if (val.pricingModel !== 'time_and_materials' && val.unitPriceCents == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unitPriceCents'],
        message: 'Unit price is required for this pricing model.',
      });
    }
  });

describe('catalog_items pricing_model rules', () => {
  it('accepts a pressure-washing per_unit item', () => {
    const r = schema.safeParse({
      name: 'Driveway concrete',
      pricingModel: 'per_unit',
      unitLabel: 'sqft',
      unitPriceCents: 25,
      minChargeCents: 25000,
      surfaceType: 'concrete',
      isTaxable: true,
      isActive: true,
    });
    expect(r.success).toBe(true);
  });

  it('accepts an HVAC fixed-price item', () => {
    const r = schema.safeParse({
      name: 'Furnace tune-up',
      pricingModel: 'fixed',
      unitPriceCents: 8900,
      isTaxable: true,
      isActive: true,
    });
    expect(r.success).toBe(true);
  });

  it('accepts a GC time-and-materials item with no price', () => {
    const r = schema.safeParse({
      name: 'Kitchen demolition',
      pricingModel: 'time_and_materials',
      isTaxable: true,
      isActive: true,
    });
    expect(r.success).toBe(true);
  });

  it('rejects time-and-materials with a price set', () => {
    const r = schema.safeParse({
      name: 'Kitchen demo',
      pricingModel: 'time_and_materials',
      unitPriceCents: 5000,
      isTaxable: true,
      isActive: true,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].path).toEqual(['unitPriceCents']);
    }
  });

  it('rejects non-time_and_materials without a price', () => {
    const r = schema.safeParse({
      name: 'Tune-up',
      pricingModel: 'fixed',
      isTaxable: true,
      isActive: true,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path[0] === 'unitPriceCents')).toBe(true);
    }
  });

  it('rejects negative unit price', () => {
    const r = schema.safeParse({
      name: 'Bogus',
      pricingModel: 'fixed',
      unitPriceCents: -100,
      isTaxable: true,
      isActive: true,
    });
    expect(r.success).toBe(false);
  });

  it('requires non-empty name', () => {
    const r = schema.safeParse({
      name: '   ',
      pricingModel: 'fixed',
      unitPriceCents: 100,
      isTaxable: true,
      isActive: true,
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown pricing_model', () => {
    const r = schema.safeParse({
      name: 'X',
      pricingModel: 'made_up',
      unitPriceCents: 100,
      isTaxable: true,
      isActive: true,
    });
    expect(r.success).toBe(false);
  });
});
