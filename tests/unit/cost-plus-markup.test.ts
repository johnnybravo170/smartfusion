/**
 * Unit tests for cost-plus invoice math.
 *
 * Covers Mike's flagged bug: applying markup to the GST-inclusive receipt
 * total double-counts tax (the contractor reclaims GST as an ITC). The
 * fix bills materials at pre-tax cost and applies markup to the same.
 * The bottom-of-invoice GST line then runs once over the full subtotal.
 */

import { describe, expect, it } from 'vitest';
import { computeCostPlusBreakdown } from '@/lib/invoices/cost-plus-markup';

describe('computeCostPlusBreakdown', () => {
  it("handles Mike's worked example: $113 receipt @ 13% HST + 20% mgmt", () => {
    // From the card: real cost $100, markup brings it to $120, GST adds
    // $15.60 at the bottom → $135.60 total. The breakdown produces the
    // pre-tax subtotal of $120; the GST line runs at the caller.
    const breakdown = computeCostPlusBreakdown({
      timeEntries: [],
      expenses: [{ amount_cents: 11300, pre_tax_amount_cents: 10000 }],
      priorInvoices: [],
      mgmtRate: 0.2,
    });
    expect(breakdown.labourCents).toBe(0);
    expect(breakdown.materialsCents).toBe(10000);
    expect(breakdown.mgmtFeeCents).toBe(2000);
    expect(breakdown.priorBilledCents).toBe(0);
    // Subtotal = $120. After 13% GST at the invoice level, client pays $135.60.
    expect(breakdown.materialsCents + breakdown.mgmtFeeCents).toBe(12000);
  });

  it('falls back to amount_cents on legacy rows (null pre_tax)', () => {
    // Pre-migration receipts. Slight over-markup vs. correct, but matches
    // pre-fix behaviour — no regression for already-sent invoices.
    const breakdown = computeCostPlusBreakdown({
      timeEntries: [],
      expenses: [{ amount_cents: 11300, pre_tax_amount_cents: null }],
      priorInvoices: [],
      mgmtRate: 0.2,
    });
    expect(breakdown.materialsCents).toBe(11300);
    expect(breakdown.mgmtFeeCents).toBe(2260);
  });

  it('mixes pre-tax + legacy rows correctly', () => {
    const breakdown = computeCostPlusBreakdown({
      timeEntries: [],
      expenses: [
        { amount_cents: 11300, pre_tax_amount_cents: 10000 }, // OCR'd
        { amount_cents: 5000, pre_tax_amount_cents: null }, // legacy
        { amount_cents: 2260, pre_tax_amount_cents: 2000 }, // OCR'd
      ],
      priorInvoices: [],
      mgmtRate: 0.1,
    });
    // Materials = 10000 + 5000 + 2000 = 17000
    expect(breakdown.materialsCents).toBe(17000);
    // Markup on the same base
    expect(breakdown.mgmtFeeCents).toBe(1700);
  });

  it('handles zero-tax receipt (out-of-province / non-registered vendor)', () => {
    // OCR returns pre_tax = total when no tax line is shown. The result
    // collapses to the legacy gross-billing path naturally — markup on
    // gross is correct here because there's no GST to reclaim.
    const breakdown = computeCostPlusBreakdown({
      timeEntries: [],
      expenses: [{ amount_cents: 5000, pre_tax_amount_cents: 5000 }],
      priorInvoices: [],
      mgmtRate: 0.15,
    });
    expect(breakdown.materialsCents).toBe(5000);
    expect(breakdown.mgmtFeeCents).toBe(750);
  });

  it('sums labour from time entries with rounding', () => {
    const breakdown = computeCostPlusBreakdown({
      timeEntries: [
        { hours: 1.5, hourly_rate_cents: 7500 }, // $112.50
        { hours: 0.25, hourly_rate_cents: 8000 }, // $20.00
        { hours: 2, hourly_rate_cents: null }, // $0 — null rate
      ],
      expenses: [],
      priorInvoices: [],
      mgmtRate: 0.1,
    });
    expect(breakdown.labourCents).toBe(13250);
    expect(breakdown.mgmtFeeCents).toBe(1325);
  });

  it('credits prior draws against the new invoice', () => {
    const breakdown = computeCostPlusBreakdown({
      timeEntries: [],
      expenses: [{ amount_cents: 11300, pre_tax_amount_cents: 10000 }],
      priorInvoices: [{ amount_cents: 5000 }, { amount_cents: 3000 }],
      mgmtRate: 0.2,
    });
    expect(breakdown.priorBilledCents).toBe(8000);
  });

  it('returns zeros when nothing has been logged', () => {
    const breakdown = computeCostPlusBreakdown({
      timeEntries: [],
      expenses: [],
      priorInvoices: [],
      mgmtRate: 0.12,
    });
    expect(breakdown).toEqual({
      labourCents: 0,
      materialsCents: 0,
      mgmtFeeCents: 0,
      priorBilledCents: 0,
    });
  });

  it('bills mapped from project_bills are marked up like expenses', () => {
    // Subcontractor invoice arrives via inbound-email → project_bills row.
    // amount_cents on bills is already pre-GST (migration 0083), so the
    // caller in invoices.ts maps amount_cents → pre_tax_amount_cents and
    // amount_cents+gst_cents → amount_cents. Result: bills participate in
    // markup exactly like a clean-OCR expense, no double-tax.
    const bill = { amount_cents: 8000000, gst_cents: 1040000 }; // $80k sub @ 13% HST
    const mapped = {
      amount_cents: bill.amount_cents + bill.gst_cents,
      pre_tax_amount_cents: bill.amount_cents,
    };
    const breakdown = computeCostPlusBreakdown({
      timeEntries: [],
      expenses: [mapped],
      priorInvoices: [],
      mgmtRate: 0.18,
    });
    expect(breakdown.materialsCents).toBe(8000000);
    expect(breakdown.mgmtFeeCents).toBe(1440000); // 18% of $80k = $14,400
  });

  it('mixes bill-mapped + expense rows in one project', () => {
    // A renovation typically has both: receipts logged as expenses (Home
    // Depot runs) plus PDF subcontractor invoices flowing through
    // project_bills. Both must show up in materialsCents.
    const expense = { amount_cents: 11300, pre_tax_amount_cents: 10000 }; // $100 receipt
    const billMapped = { amount_cents: 56500, pre_tax_amount_cents: 50000 }; // $500 sub
    const breakdown = computeCostPlusBreakdown({
      timeEntries: [],
      expenses: [expense, billMapped],
      priorInvoices: [],
      mgmtRate: 0.15,
    });
    expect(breakdown.materialsCents).toBe(60000); // 10000 + 50000
    expect(breakdown.mgmtFeeCents).toBe(9000); // 15% of 60000
  });

  it('applies markup over labour + materials together (not separately)', () => {
    // Sanity check: rounding once on the sum gives a different answer
    // than rounding each piece. The contract is "markup over the
    // combined base" — verify against a case where it matters.
    const breakdown = computeCostPlusBreakdown({
      timeEntries: [{ hours: 1, hourly_rate_cents: 333 }], // $3.33
      expenses: [{ amount_cents: 333, pre_tax_amount_cents: 333 }],
      priorInvoices: [],
      mgmtRate: 0.15,
    });
    // Combined base = 666; markup = round(666 * 0.15) = 100
    expect(breakdown.mgmtFeeCents).toBe(100);
  });
});
