/**
 * Tests for the customer-view line-items helper that drives the invoice
 * preview screen. The big guarantee under test: switching view modes never
 * changes the customer's subtotal — only the shape of the breakdown.
 */

import { describe, expect, it } from 'vitest';
import {
  availableModesFor,
  type BuildCustomerViewArgs,
  buildCustomerViewLineItems,
} from '@/lib/invoices/customer-view-line-items';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const SECTION_BATH = { id: 'sec-bath', name: 'Bathroom', description_md: 'Main floor bath reno' };
const SECTION_KITCHEN = {
  id: 'sec-kitchen',
  name: 'Kitchen',
  description_md: null,
};

const CAT_PLUMBING = {
  id: 'cat-plumbing',
  name: 'Plumbing',
  description_md: 'Rough-in + fixtures',
  customer_section_id: 'sec-bath',
};
const CAT_TILE = {
  id: 'cat-tile',
  name: 'Tile',
  description_md: null,
  customer_section_id: 'sec-bath',
};
const CAT_CABINETS = {
  id: 'cat-cabinets',
  name: 'Cabinets',
  description_md: null,
  customer_section_id: 'sec-kitchen',
};
const CAT_UNCATEGORIZED_NO_SECTION = {
  id: 'cat-extras',
  name: 'Extras',
  description_md: null,
  customer_section_id: null,
};

const LINE_PLUMBING_ROUGHIN = {
  label: 'Plumbing rough-in',
  qty: 1,
  unit_price_cents: 250000,
  line_price_cents: 250000,
  notes: '3 fixtures',
  budget_category_id: 'cat-plumbing',
};
const LINE_PLUMBING_FIXTURES = {
  label: 'Bathroom fixtures',
  qty: 1,
  unit_price_cents: 150000,
  line_price_cents: 150000,
  notes: null,
  budget_category_id: 'cat-plumbing',
};
const LINE_TILE = {
  label: 'Tile install',
  qty: 1,
  unit_price_cents: 320000,
  line_price_cents: 320000,
  notes: 'porcelain, 60 sq ft',
  budget_category_id: 'cat-tile',
};
const LINE_CABINETS = {
  label: 'Cabinet install',
  qty: 1,
  unit_price_cents: 450000,
  line_price_cents: 450000,
  notes: null,
  budget_category_id: 'cat-cabinets',
};
const LINE_EXTRAS_NO_CAT = {
  label: 'Trim work',
  qty: 1,
  unit_price_cents: 80000,
  line_price_cents: 80000,
  notes: null,
  budget_category_id: null,
};
const LINE_EXTRAS_UNSECTIONED = {
  label: 'Hauling',
  qty: 1,
  unit_price_cents: 30000,
  line_price_cents: 30000,
  notes: null,
  budget_category_id: 'cat-extras',
};

function baseArgs(overrides: Partial<BuildCustomerViewArgs> = {}): BuildCustomerViewArgs {
  return {
    mode: 'detailed',
    mgmtFeeInline: false,
    projectName: 'Smith Reno',
    customerSummaryMd: null,
    costLines: [
      LINE_PLUMBING_ROUGHIN,
      LINE_PLUMBING_FIXTURES,
      LINE_TILE,
      LINE_CABINETS,
      LINE_EXTRAS_NO_CAT,
      LINE_EXTRAS_UNSECTIONED,
    ],
    categories: [CAT_PLUMBING, CAT_TILE, CAT_CABINETS, CAT_UNCATEGORIZED_NO_SECTION],
    sections: [SECTION_BATH, SECTION_KITCHEN],
    priorBilledCents: 0,
    mgmtRate: 0.12,
    isCostPlus: false,
    ...overrides,
  };
}

const TOTAL_COST_LINES = 250000 + 150000 + 320000 + 450000 + 80000 + 30000;
const MGMT_FEE = Math.round(TOTAL_COST_LINES * 0.12);
const GRAND_SUBTOTAL = TOTAL_COST_LINES + MGMT_FEE;

function sumTotals(items: { total_cents: number }[]): number {
  return items.reduce((s, i) => s + i.total_cents, 0);
}

// ─── Fixed-price: per-mode shape ────────────────────────────────────────────

describe('buildCustomerViewLineItems — fixed-price detailed mode', () => {
  it('matches the existing inline-generator output byte-for-byte', () => {
    const { items } = buildCustomerViewLineItems(baseArgs({ mode: 'detailed' }));
    // 6 cost lines + 1 mgmt fee
    expect(items).toHaveLength(7);
    expect(items[0]).toEqual({
      description: 'Plumbing rough-in — 3 fixtures',
      quantity: 1,
      unit_price_cents: 250000,
      total_cents: 250000,
    });
    expect(items[1]).toEqual({
      description: 'Bathroom fixtures',
      quantity: 1,
      unit_price_cents: 150000,
      total_cents: 150000,
    });
    expect(items[6]).toEqual({
      description: 'Management fee (12%)',
      quantity: 1,
      unit_price_cents: MGMT_FEE,
      total_cents: MGMT_FEE,
    });
    expect(sumTotals(items)).toBe(GRAND_SUBTOTAL);
  });
});

describe('buildCustomerViewLineItems — fixed-price lump_sum mode', () => {
  it('collapses to one line plus separate mgmt fee when mgmtFeeInline=false', () => {
    const { items } = buildCustomerViewLineItems(
      baseArgs({ mode: 'lump_sum', mgmtFeeInline: false }),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      description: 'Project work — Smith Reno',
      quantity: 1,
      unit_price_cents: TOTAL_COST_LINES,
      total_cents: TOTAL_COST_LINES,
    });
    expect(items[1].description).toBe('Management fee (12%)');
    expect(sumTotals(items)).toBe(GRAND_SUBTOTAL);
  });

  it('bakes mgmt fee into the single line when mgmtFeeInline=true', () => {
    const { items } = buildCustomerViewLineItems(
      baseArgs({ mode: 'lump_sum', mgmtFeeInline: true }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].total_cents).toBe(GRAND_SUBTOTAL);
    expect(sumTotals(items)).toBe(GRAND_SUBTOTAL);
  });

  it('uses customer_summary_md as the headline description when present', () => {
    const { items } = buildCustomerViewLineItems(
      baseArgs({
        mode: 'lump_sum',
        mgmtFeeInline: true,
        customerSummaryMd: 'Complete bathroom + kitchen renovation per signed estimate',
      }),
    );
    expect(items[0].description).toBe('Complete bathroom + kitchen renovation per signed estimate');
  });

  it('falls back to project name when customer_summary_md is blank', () => {
    const { items } = buildCustomerViewLineItems(
      baseArgs({ mode: 'lump_sum', mgmtFeeInline: true, customerSummaryMd: '   ' }),
    );
    expect(items[0].description).toBe('Project work — Smith Reno');
  });
});

describe('buildCustomerViewLineItems — fixed-price sections mode', () => {
  it('groups cost lines by section and rolls unsectioned into Other work', () => {
    const { items } = buildCustomerViewLineItems(baseArgs({ mode: 'sections' }));

    // Expect Bathroom + Kitchen + Other work + mgmt fee
    const descriptions = items.map((i) => i.description);
    expect(descriptions[0]).toMatch(/^Bathroom/);
    expect(descriptions[1]).toBe('Kitchen');
    expect(descriptions[2]).toBe('Other work');
    expect(descriptions[3]).toBe('Management fee (12%)');

    // Bathroom: plumbing roughin + fixtures + tile = 250 + 150 + 320 = 720k
    expect(items[0].total_cents).toBe(250000 + 150000 + 320000);
    // Kitchen: just cabinets
    expect(items[1].total_cents).toBe(450000);
    // Other: uncategorized line (no budget_category_id) + line whose category has no section
    expect(items[2].total_cents).toBe(80000 + 30000);

    expect(sumTotals(items)).toBe(GRAND_SUBTOTAL);
  });

  it('embeds section description_md into the description', () => {
    const { items } = buildCustomerViewLineItems(baseArgs({ mode: 'sections' }));
    expect(items[0].description).toBe('Bathroom — Main floor bath reno');
  });

  it('skips empty sections', () => {
    const { items } = buildCustomerViewLineItems(
      baseArgs({
        mode: 'sections',
        sections: [
          SECTION_BATH,
          SECTION_KITCHEN,
          { id: 'sec-empty', name: 'Garage', description_md: null },
        ],
      }),
    );
    const garage = items.find((i) => i.description === 'Garage');
    expect(garage).toBeUndefined();
  });
});

describe('buildCustomerViewLineItems — fixed-price categories mode', () => {
  it('produces one line per priced category', () => {
    const { items } = buildCustomerViewLineItems(baseArgs({ mode: 'categories' }));

    // Plumbing + Tile + Cabinets + (unsectioned Extras category line: 30k) + Other (80k uncategorized) + mgmt
    // Plumbing description picks up description_md
    expect(items[0].description).toBe('Plumbing — Rough-in + fixtures');
    expect(items[0].total_cents).toBe(250000 + 150000);
    expect(items[1]).toMatchObject({ description: 'Tile', total_cents: 320000 });
    expect(items[2]).toMatchObject({ description: 'Cabinets', total_cents: 450000 });
    // Extras is a real category with a priced line — surfaces by name
    expect(items[3]).toMatchObject({ description: 'Extras', total_cents: 30000 });
    // 80k line has no budget_category_id → rolls into Other work
    expect(items[4]).toMatchObject({ description: 'Other work', total_cents: 80000 });
    expect(items[5].description).toBe('Management fee (12%)');

    expect(sumTotals(items)).toBe(GRAND_SUBTOTAL);
  });

  it('skips categories with no priced lines', () => {
    const { items } = buildCustomerViewLineItems(
      baseArgs({
        mode: 'categories',
        categories: [
          ...baseArgs().categories,
          {
            id: 'cat-unused',
            name: 'Unused',
            description_md: null,
            customer_section_id: null,
          },
        ],
      }),
    );
    expect(items.find((i) => i.description === 'Unused')).toBeUndefined();
  });
});

// ─── Subtotal invariance ────────────────────────────────────────────────────

describe('buildCustomerViewLineItems — subtotal invariance across modes', () => {
  it('every fixed-price mode sums to the same subtotal', () => {
    const modes = ['lump_sum', 'sections', 'categories', 'detailed'] as const;
    const totals = modes.map((mode) =>
      sumTotals(buildCustomerViewLineItems(baseArgs({ mode })).items),
    );
    for (const t of totals) {
      expect(t).toBe(GRAND_SUBTOTAL);
    }
  });

  it('mgmtFeeInline toggle does not change the total', () => {
    const a = sumTotals(
      buildCustomerViewLineItems(baseArgs({ mode: 'lump_sum', mgmtFeeInline: false })).items,
    );
    const b = sumTotals(
      buildCustomerViewLineItems(baseArgs({ mode: 'lump_sum', mgmtFeeInline: true })).items,
    );
    expect(a).toBe(b);
  });
});

// ─── Prior invoices credit ──────────────────────────────────────────────────

describe('buildCustomerViewLineItems — prior invoices credit', () => {
  it('appends a negative line in every mode when priorBilledCents > 0', () => {
    const PRIOR = 100000;
    const modes = ['lump_sum', 'sections', 'categories', 'detailed'] as const;
    for (const mode of modes) {
      const { items } = buildCustomerViewLineItems(baseArgs({ mode, priorBilledCents: PRIOR }));
      const lastItem = items[items.length - 1];
      expect(lastItem.description).toBe('Less: Prior Invoices');
      expect(lastItem.total_cents).toBe(-PRIOR);
      expect(sumTotals(items)).toBe(GRAND_SUBTOTAL - PRIOR);
    }
  });

  it('omits the prior-invoices line when priorBilledCents = 0', () => {
    const { items } = buildCustomerViewLineItems(
      baseArgs({ mode: 'detailed', priorBilledCents: 0 }),
    );
    expect(items.find((i) => i.description === 'Less: Prior Invoices')).toBeUndefined();
  });
});

// ─── Cost-plus ──────────────────────────────────────────────────────────────

describe('buildCustomerViewLineItems — cost-plus', () => {
  const COST_PLUS = baseArgs({
    isCostPlus: true,
    costLines: [],
    costPlusBreakdown: {
      labourCents: 450000,
      materialsCents: 280000,
      mgmtFeeCents: Math.round((450000 + 280000) * 0.12),
    },
    asOfDate: '2026-05-12',
  });
  const CP_TOTAL = 450000 + 280000 + Math.round((450000 + 280000) * 0.12);

  it('detailed mode produces Labour / Materials / Mgmt rows', () => {
    const { items } = buildCustomerViewLineItems({ ...COST_PLUS, mode: 'detailed' });
    expect(items.map((i) => i.description)).toEqual([
      'Labour',
      'Materials & Expenses',
      'Management Fee (12%)',
    ]);
    expect(sumTotals(items)).toBe(CP_TOTAL);
  });

  it('lump_sum mode collapses to one headline with period-through date when no summary', () => {
    const { items } = buildCustomerViewLineItems({
      ...COST_PLUS,
      mode: 'lump_sum',
      mgmtFeeInline: true,
    });
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe('Project work — period through 2026-05-12');
    expect(items[0].total_cents).toBe(CP_TOTAL);
  });

  it('lump_sum mode keeps mgmt as a separate line when mgmtFeeInline=false', () => {
    const { items } = buildCustomerViewLineItems({
      ...COST_PLUS,
      mode: 'lump_sum',
      mgmtFeeInline: false,
    });
    expect(items).toHaveLength(2);
    expect(items[1].description).toMatch(/^Management Fee/);
    expect(sumTotals(items)).toBe(CP_TOTAL);
  });

  it('sections/categories silently fall back to detailed for cost-plus', () => {
    const detailedTotal = sumTotals(
      buildCustomerViewLineItems({ ...COST_PLUS, mode: 'detailed' }).items,
    );
    const sectionsTotal = sumTotals(
      buildCustomerViewLineItems({ ...COST_PLUS, mode: 'sections' }).items,
    );
    const categoriesTotal = sumTotals(
      buildCustomerViewLineItems({ ...COST_PLUS, mode: 'categories' }).items,
    );
    expect(sectionsTotal).toBe(detailedTotal);
    expect(categoriesTotal).toBe(detailedTotal);
  });

  it('throws when costPlusBreakdown is missing', () => {
    expect(() =>
      buildCustomerViewLineItems({ ...COST_PLUS, costPlusBreakdown: undefined, mode: 'lump_sum' }),
    ).toThrow(/costPlusBreakdown is required/);
  });
});

// ─── Available modes ────────────────────────────────────────────────────────

describe('availableModesFor', () => {
  it('returns all four modes for fixed-price', () => {
    expect(availableModesFor(false)).toEqual(['lump_sum', 'sections', 'categories', 'detailed']);
  });

  it('returns only lump_sum + detailed for cost-plus', () => {
    expect(availableModesFor(true)).toEqual(['lump_sum', 'detailed']);
  });
});
