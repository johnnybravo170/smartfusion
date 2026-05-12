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
      description: 'Management Fee (12%)',
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
    expect(items[1].description).toBe('Management Fee (12%)');
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
    expect(descriptions[3]).toBe('Management Fee (12%)');

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
    expect(items[5].description).toBe('Management Fee (12%)');

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

  it('sections/categories silently fall back to detailed when byCategoryCents is empty', () => {
    // No byCategoryCents on the breakdown → fall back to detailed shape.
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

// ─── Cost-plus Detailed: per-cost-line (budget scope items) ────────────────

describe('buildCustomerViewLineItems — cost-plus detailed (per cost line)', () => {
  // Cost lines under categories. Cost-plus aggregates actual spend
  // (time_entries + project_costs) by cost_line_id; the helper renders one
  // row per line with its actual amount, NOT the planned line_price_cents.
  const LINE_TILE_PACKAGE = {
    id: 'line-tile-package',
    label: 'Tile package',
    qty: 1,
    unit_price_cents: 735000,
    line_price_cents: 735000,
    notes: 'Marble-look porcelain, 12×24',
    budget_category_id: 'cat-ensuite',
  };
  const LINE_TILE_INSTALL = {
    id: 'line-tile-install',
    label: 'Tile install + waterproofing',
    qty: 1,
    unit_price_cents: 625000,
    line_price_cents: 625000,
    notes: null,
    budget_category_id: 'cat-ensuite',
  };
  const LINE_TUB = {
    id: 'line-tub',
    label: 'Freestanding tub + filler',
    qty: 1,
    unit_price_cents: 340000,
    line_price_cents: 340000,
    notes: null,
    budget_category_id: 'cat-ensuite',
  };
  const LINE_UNTOUCHED = {
    id: 'line-untouched',
    label: 'Planned but no spend yet',
    qty: 1,
    unit_price_cents: 100000,
    line_price_cents: 100000,
    notes: null,
    budget_category_id: 'cat-ensuite',
  };

  // Actual cost-plus spend by cost_line_id (sums to labour + materials).
  // line-tile-package $5,000, line-tile-install $4,800, line-tub $3,400, '' (other) $200
  const ACTUAL_BY_LINE = {
    'line-tile-package': 500000,
    'line-tile-install': 480000,
    'line-tub': 340000,
    '': 20000, // untagged spend → "Other work"
    // line-untouched intentionally absent
  };
  const CP_LABOUR_PLUS_MATERIALS = Object.values(ACTUAL_BY_LINE).reduce((s, v) => s + v, 0);
  const CP_MGMT = Math.round(CP_LABOUR_PLUS_MATERIALS * 0.18);
  const CP_GRAND = CP_LABOUR_PLUS_MATERIALS + CP_MGMT;

  const COST_PLUS_LINES = baseArgs({
    isCostPlus: true,
    costLines: [LINE_TILE_PACKAGE, LINE_TILE_INSTALL, LINE_TUB, LINE_UNTOUCHED],
    categories: [],
    sections: [],
    mgmtRate: 0.18,
    costPlusBreakdown: {
      labourCents: 600000,
      materialsCents: CP_LABOUR_PLUS_MATERIALS - 600000,
      mgmtFeeCents: CP_MGMT,
      byCostLineCents: ACTUAL_BY_LINE,
    },
  });

  it('detailed mode shows one row per priced cost line in costLines order, with actual spend', () => {
    const { preview } = buildCustomerViewLineItems({ ...COST_PLUS_LINES, mode: 'detailed' });
    expect(preview[0]).toMatchObject({
      title: 'Tile package',
      body_md: 'Marble-look porcelain, 12×24',
      total_cents: 500000,
    });
    expect(preview[1]).toMatchObject({
      title: 'Tile install + waterproofing',
      total_cents: 480000,
    });
    expect(preview[2]).toMatchObject({ title: 'Freestanding tub + filler', total_cents: 340000 });
    expect(preview[3]).toMatchObject({ title: 'Other work', total_cents: 20000 });
    expect(preview[4]).toMatchObject({ kind: 'mgmt_fee' });
  });

  it('hides cost lines with no actual spend (planned but untouched)', () => {
    const { preview } = buildCustomerViewLineItems({ ...COST_PLUS_LINES, mode: 'detailed' });
    expect(preview.find((r) => r.title === 'Planned but no spend yet')).toBeUndefined();
  });

  it('subtotal sums to labour + materials + mgmt fee (invariance)', () => {
    const total = sumTotals(
      buildCustomerViewLineItems({ ...COST_PLUS_LINES, mode: 'detailed' }).items,
    );
    expect(total).toBe(CP_GRAND);
  });

  it('falls back to lumped Labour / Materials when byCostLineCents is empty', () => {
    const { preview } = buildCustomerViewLineItems({
      ...COST_PLUS_LINES,
      mode: 'detailed',
      costPlusBreakdown: {
        labourCents: 600000,
        materialsCents: CP_LABOUR_PLUS_MATERIALS - 600000,
        mgmtFeeCents: CP_MGMT,
        byCostLineCents: {},
      },
    });
    expect(preview.map((r) => r.title)).toEqual([
      'Labour',
      'Materials & Expenses',
      'Management Fee (18%)',
    ]);
  });
});

// ─── Cost-plus sections / categories ────────────────────────────────────────

describe('buildCustomerViewLineItems — cost-plus per-category modes', () => {
  // Same labour+materials total as the lumped breakdown, but split across
  // categories: Plumbing $300k, Tile $150k, Cabinets $200k, uncategorized $80k.
  // Mgmt fee at 12% = round((300+150+200+80)k × 0.12) = 87600.
  const CP_LABOUR_PLUS_MATERIALS = 300000 + 150000 + 200000 + 80000;
  const CP_MGMT = Math.round(CP_LABOUR_PLUS_MATERIALS * 0.12);
  const CP_GRAND = CP_LABOUR_PLUS_MATERIALS + CP_MGMT;

  const COST_PLUS_BY_CAT = baseArgs({
    isCostPlus: true,
    costLines: [],
    costPlusBreakdown: {
      labourCents: 300000 + 150000, // doesn't matter for sections/categories — only the map is used
      materialsCents: 200000 + 80000,
      mgmtFeeCents: CP_MGMT,
      byCategoryCents: {
        'cat-plumbing': 300000,
        'cat-tile': 150000,
        'cat-cabinets': 200000,
        '': 80000, // uncategorized
      },
    },
    asOfDate: '2026-05-12',
  });

  it('categories mode produces one row per priced category + Other + mgmt fee', () => {
    const { preview } = buildCustomerViewLineItems({ ...COST_PLUS_BY_CAT, mode: 'categories' });
    expect(preview[0]).toMatchObject({ title: 'Plumbing', total_cents: 300000 });
    expect(preview[1]).toMatchObject({ title: 'Tile', total_cents: 150000 });
    expect(preview[2]).toMatchObject({ title: 'Cabinets', total_cents: 200000 });
    expect(preview[3]).toMatchObject({ title: 'Other work', total_cents: 80000 });
    expect(preview[4]).toMatchObject({ kind: 'mgmt_fee' });
    expect(
      sumTotals(buildCustomerViewLineItems({ ...COST_PLUS_BY_CAT, mode: 'categories' }).items),
    ).toBe(CP_GRAND);
  });

  it('sections mode groups categories by their customer_section_id + mgmt fee', () => {
    const { preview } = buildCustomerViewLineItems({ ...COST_PLUS_BY_CAT, mode: 'sections' });
    // Bathroom = Plumbing 300k + Tile 150k = 450k
    expect(preview[0]).toMatchObject({ title: 'Bathroom', total_cents: 450000 });
    // Kitchen = Cabinets 200k
    expect(preview[1]).toMatchObject({ title: 'Kitchen', total_cents: 200000 });
    // Other = uncategorized 80k
    expect(preview[2]).toMatchObject({ title: 'Other work', total_cents: 80000 });
    // Mgmt fee row last
    expect(preview[3]).toMatchObject({ kind: 'mgmt_fee' });
    expect(
      sumTotals(buildCustomerViewLineItems({ ...COST_PLUS_BY_CAT, mode: 'sections' }).items),
    ).toBe(CP_GRAND);
  });

  it('subtotal stays invariant across all four cost-plus modes when byCategoryCents is set', () => {
    const modes = ['lump_sum', 'sections', 'categories', 'detailed'] as const;
    for (const mode of modes) {
      const total = sumTotals(buildCustomerViewLineItems({ ...COST_PLUS_BY_CAT, mode }).items);
      expect(total).toBe(CP_GRAND);
    }
  });
});

// ─── Preview meta (UI-facing rich rows) ─────────────────────────────────────

describe('buildCustomerViewLineItems — preview meta', () => {
  it('returns parallel preview rows of equal length to items, totals matching', () => {
    const modes = ['lump_sum', 'sections', 'categories', 'detailed'] as const;
    for (const mode of modes) {
      const { items, preview } = buildCustomerViewLineItems(baseArgs({ mode }));
      expect(preview).toHaveLength(items.length);
      for (let i = 0; i < items.length; i++) {
        expect(preview[i].total_cents).toBe(items[i].total_cents);
      }
    }
  });

  it('detailed mode: title is the cost line label, body_md is the notes', () => {
    const { preview } = buildCustomerViewLineItems(baseArgs({ mode: 'detailed' }));
    expect(preview[0]).toMatchObject({
      title: 'Plumbing rough-in',
      body_md: '3 fixtures',
      kind: 'work',
    });
    expect(preview[1]).toMatchObject({ title: 'Bathroom fixtures', body_md: null });
  });

  it('categories mode: title is the category name, body_md is description_md', () => {
    const { preview } = buildCustomerViewLineItems(baseArgs({ mode: 'categories' }));
    expect(preview[0]).toMatchObject({ title: 'Plumbing', body_md: 'Rough-in + fixtures' });
    expect(preview[1]).toMatchObject({ title: 'Tile', body_md: null });
  });

  it('sections mode: title is the section name, body_md is description_md', () => {
    const { preview } = buildCustomerViewLineItems(baseArgs({ mode: 'sections' }));
    expect(preview[0]).toMatchObject({ title: 'Bathroom', body_md: 'Main floor bath reno' });
    expect(preview[1]).toMatchObject({ title: 'Kitchen', body_md: null });
  });

  it('mgmt-fee rows are tagged kind=mgmt_fee', () => {
    const { preview } = buildCustomerViewLineItems(baseArgs({ mode: 'detailed' }));
    const mgmt = preview.find((r) => r.kind === 'mgmt_fee');
    expect(mgmt?.title).toMatch(/Management Fee/);
  });

  it('prior-credit rows are tagged kind=prior_credit with negative total', () => {
    const { preview } = buildCustomerViewLineItems(
      baseArgs({ mode: 'lump_sum', priorBilledCents: 100000 }),
    );
    const prior = preview.find((r) => r.kind === 'prior_credit');
    expect(prior?.total_cents).toBe(-100000);
  });
});

// ─── Available modes ────────────────────────────────────────────────────────

describe('availableModesFor', () => {
  it('returns all four modes for fixed-price', () => {
    expect(availableModesFor(false)).toEqual(['lump_sum', 'sections', 'categories', 'detailed']);
  });

  it('returns all four modes for cost-plus too (helper handles empty-data fallback)', () => {
    expect(availableModesFor(true)).toEqual(['lump_sum', 'sections', 'categories', 'detailed']);
  });
});
