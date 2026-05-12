/**
 * Unit tests for the cost-basis rollup that feeds the cost-plus invoice
 * and the drift banner on the draft-invoice page.
 *
 * The math here is intentionally trivial — what matters is the field
 * semantics: which column drives which aggregate, and how `bills`
 * (which store amount_cents pre-GST per migration 0083) differ from
 * `expenses` (which store amount_cents gross with pre_tax_amount_cents
 * as the contractor's real cost). Mis-wiring those is the kind of
 * mistake the drift banner exists to catch — so this test pins down
 * the contract.
 */

import { describe, expect, it } from 'vitest';
import { splitProjectCostRows, summarizeCostBasisRows } from '@/lib/db/queries/project-cost-basis';

describe('summarizeCostBasisRows', () => {
  it('returns all zeros for an empty project', () => {
    const r = summarizeCostBasisRows({ timeEntries: [], expenseRows: [], billRows: [] });
    expect(r.labourCents).toBe(0);
    expect(r.expensesPreTaxCents).toBe(0);
    expect(r.expensesGrossCents).toBe(0);
    expect(r.billsCents).toBe(0);
    expect(r.invoiceCostBasisCents).toBe(0);
  });

  it('sums labour as hours × hourly_rate_cents with null-rate as zero', () => {
    const r = summarizeCostBasisRows({
      timeEntries: [
        { hours: 1.5, hourly_rate_cents: 7500 }, // $112.50
        { hours: 0.25, hourly_rate_cents: 8000 }, // $20.00
        { hours: 2, hourly_rate_cents: null }, // null rate → $0
      ],
      expenseRows: [],
      billRows: [],
    });
    expect(r.labourCents).toBe(13250);
  });

  it('expensesPreTaxCents prefers pre_tax_amount_cents, falls back to amount_cents', () => {
    const r = summarizeCostBasisRows({
      timeEntries: [],
      expenseRows: [
        { amount_cents: 11300, pre_tax_amount_cents: 10000 }, // OCR'd receipt
        { amount_cents: 5000, pre_tax_amount_cents: null }, // legacy / no breakdown
        { amount_cents: 2260, pre_tax_amount_cents: 2000 },
      ],
      billRows: [],
    });
    expect(r.expensesPreTaxCents).toBe(17000); // 10000 + 5000 + 2000
    expect(r.expensesGrossCents).toBe(18560); // 11300 + 5000 + 2260
  });

  it('bills sum amount_cents only — gst_cents stays out of the cost basis', () => {
    // amount_cents on a bill is pre-GST (migration 0083). The GST is
    // tracked separately on gst_cents and reclaimed as an ITC, so it
    // is NOT part of the contractor's real cost.
    const r = summarizeCostBasisRows({
      timeEntries: [],
      expenseRows: [],
      billRows: [
        { amount_cents: 8000000, gst_cents: 1040000 }, // $80k sub @ 13% HST
        { amount_cents: 500000, gst_cents: 25000 }, // $5k sub @ 5% GST
      ],
    });
    expect(r.billsCents).toBe(8500000); // 8M + 500k — gst NOT added
  });

  it('invoiceCostBasisCents equals labour + expensesPreTax + bills', () => {
    const r = summarizeCostBasisRows({
      timeEntries: [{ hours: 10, hourly_rate_cents: 7500 }], // $750
      expenseRows: [{ amount_cents: 11300, pre_tax_amount_cents: 10000 }], // $100 pre-tax
      billRows: [{ amount_cents: 50000, gst_cents: 6500 }], // $500 pre-GST
    });
    // 75000 (labour) + 10000 (expense pre-tax) + 50000 (bill pre-GST) = 135000
    expect(r.invoiceCostBasisCents).toBe(135000);
    // Sanity: gross-flavor total is higher by the tax portion of expenses
    // (but NOT by bill GST — bills are stored pre-GST). $1.13 - $1.00 = $0.13.
    expect(r.expensesGrossCents - r.expensesPreTaxCents).toBe(1300);
  });

  it('mixes labour + expenses + bills + legacy rows correctly', () => {
    // The realistic renovation case: a few timecards, some clean OCR'd
    // receipts, a legacy receipt without a pre-tax breakdown, and a
    // subcontractor invoice arriving via project_bills.
    const r = summarizeCostBasisRows({
      timeEntries: [
        { hours: 8, hourly_rate_cents: 8500 }, // $680
        { hours: 4.5, hourly_rate_cents: 7000 }, // $315
      ],
      expenseRows: [
        { amount_cents: 11300, pre_tax_amount_cents: 10000 }, // Home Depot receipt
        { amount_cents: 4500, pre_tax_amount_cents: null }, // pre-migration row
      ],
      billRows: [
        { amount_cents: 250000, gst_cents: 32500 }, // electrician sub
      ],
    });
    expect(r.labourCents).toBe(99500); // 68000 + 31500
    expect(r.expensesPreTaxCents).toBe(14500); // 10000 + 4500 (fallback)
    expect(r.expensesGrossCents).toBe(15800); // 11300 + 4500
    expect(r.billsCents).toBe(250000);
    expect(r.invoiceCostBasisCents).toBe(364000); // 99500 + 14500 + 250000
  });

  it('rounds labour per-row (matches computeCostPlusBreakdown)', () => {
    // Round-once-per-row is the contract — the breakdown does the same
    // so the drift banner won't fire on the rounding gap between
    // round(Σ) and Σ(round). Pin this in so a refactor can't change it.
    const r = summarizeCostBasisRows({
      timeEntries: [
        { hours: 0.333, hourly_rate_cents: 333 }, // 110.889 → 111
        { hours: 0.333, hourly_rate_cents: 333 }, // 110.889 → 111
        { hours: 0.333, hourly_rate_cents: 333 }, // 110.889 → 111
      ],
      expenseRows: [],
      billRows: [],
    });
    expect(r.labourCents).toBe(333); // 3 × 111, not round(3 × 110.889) = 333
  });

  it('passes the raw rows through so callers can re-feed computeCostPlusBreakdown', () => {
    const time = [{ hours: 1, hourly_rate_cents: 7500 }];
    const expenses = [{ amount_cents: 11300, pre_tax_amount_cents: 10000 }];
    const bills = [{ amount_cents: 50000, gst_cents: 6500 }];
    const r = summarizeCostBasisRows({
      timeEntries: time,
      expenseRows: expenses,
      billRows: bills,
    });
    expect(r.timeEntries).toEqual(time);
    expect(r.expenseRows).toEqual(expenses);
    expect(r.billRows).toEqual(bills);
  });
});

describe('splitProjectCostRows', () => {
  it('routes receipts to expenseRows with gross + nullable pre-tax preserved', () => {
    const { expenseRows, billRows } = splitProjectCostRows([
      {
        source_type: 'receipt',
        amount_cents: 11300,
        pre_tax_amount_cents: 10000,
        gst_cents: 1300,
      },
      {
        source_type: 'receipt',
        amount_cents: 5000,
        pre_tax_amount_cents: null, // legacy / no OCR breakdown
        gst_cents: 0,
      },
    ]);
    expect(billRows).toEqual([]);
    expect(expenseRows).toEqual([
      { amount_cents: 11300, pre_tax_amount_cents: 10000 },
      { amount_cents: 5000, pre_tax_amount_cents: null },
    ]);
  });

  it('routes vendor bills to billRows with pre-GST amount + gst preserved', () => {
    const { expenseRows, billRows } = splitProjectCostRows([
      {
        source_type: 'vendor_bill',
        amount_cents: 90400, // gross (pre-GST + GST)
        pre_tax_amount_cents: 80000, // legacy bills.amount_cents
        gst_cents: 10400,
      },
    ]);
    expect(expenseRows).toEqual([]);
    expect(billRows).toEqual([{ amount_cents: 80000, gst_cents: 10400 }]);
  });

  it('falls back to gross amount_cents for bills predating migration 0083', () => {
    const { billRows } = splitProjectCostRows([
      {
        source_type: 'vendor_bill',
        amount_cents: 50000,
        pre_tax_amount_cents: null,
        gst_cents: 0,
      },
    ]);
    expect(billRows).toEqual([{ amount_cents: 50000, gst_cents: 0 }]);
  });

  it('handles mixed streams in input order', () => {
    const { expenseRows, billRows } = splitProjectCostRows([
      {
        source_type: 'receipt',
        amount_cents: 1000,
        pre_tax_amount_cents: 952,
        gst_cents: 48,
      },
      {
        source_type: 'vendor_bill',
        amount_cents: 5650,
        pre_tax_amount_cents: 5000,
        gst_cents: 650,
      },
      {
        source_type: 'receipt',
        amount_cents: 2000,
        pre_tax_amount_cents: 1905,
        gst_cents: 95,
      },
    ]);
    expect(expenseRows).toHaveLength(2);
    expect(billRows).toHaveLength(1);
    expect(expenseRows[0]?.amount_cents).toBe(1000);
    expect(expenseRows[1]?.amount_cents).toBe(2000);
    expect(billRows[0]?.amount_cents).toBe(5000);
  });
});
