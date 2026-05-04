/**
 * BR-5 — payment auto-detect matcher.
 *
 * Coverage: each scoring axis (amount / date / text), each candidate kind
 * (invoice / expense / bill), the inflow vs outflow gate, and the no-match
 * floor.
 */

import { describe, expect, it } from 'vitest';
import {
  type BankTxForMatching,
  findMatchCandidates,
  type MatchableBill,
  type MatchableExpense,
  type MatchableInvoice,
  scoreAmount,
  scoreDate,
  scoreText,
} from '@/lib/bank-recon/matcher';

const invoice = (overrides: Partial<MatchableInvoice> = {}): MatchableInvoice => ({
  id: 'inv-1',
  amount_cents: 184_27,
  sent_at: '2026-03-04',
  created_at: '2026-03-04T12:00:00Z',
  customer_name: 'ACME RENO LTD',
  ...overrides,
});

const expense = (overrides: Partial<MatchableExpense> = {}): MatchableExpense => ({
  id: 'exp-1',
  amount_cents: 184_27,
  expense_date: '2026-03-04',
  vendor: 'Home Depot',
  description: null,
  ...overrides,
});

const bill = (overrides: Partial<MatchableBill> = {}): MatchableBill => ({
  id: 'bill-1',
  amount_cents: 184_27,
  bill_date: '2026-03-04',
  vendor: 'Acme Plumbing',
  description: null,
  ...overrides,
});

const tx = (overrides: Partial<BankTxForMatching> = {}): BankTxForMatching => ({
  posted_at: '2026-03-04',
  amount_cents: -18427,
  description: 'HOME DEPOT #7042 YALETOWN',
  description_normalized: 'home depot 7042 yaletown',
  ...overrides,
});

describe('scoreAmount', () => {
  it('exact match scores 50', () => {
    expect(scoreAmount(18427, 18427)).toBe(50);
  });
  it('penny-off scores 50 (rounding tolerance)', () => {
    expect(scoreAmount(18428, 18427)).toBe(50);
  });
  it('within $1 scores 35', () => {
    expect(scoreAmount(18450, 18427)).toBe(35);
  });
  it('within 1% (but >$1) scores 20', () => {
    // $1010 vs $1000 — diff $10 > $1 (no 35 bucket) but within 1% → 20
    expect(scoreAmount(101_000, 100_000)).toBe(20);
  });
  it('beyond 1% scores 0', () => {
    expect(scoreAmount(120_000, 100_000)).toBe(0);
  });
  it('zero or negative candidate amount scores 0', () => {
    expect(scoreAmount(18427, 0)).toBe(0);
  });
});

describe('scoreDate', () => {
  it('same day scores 30', () => {
    expect(scoreDate('2026-03-04', '2026-03-04')).toBe(30);
  });
  it('±2 days scores 30', () => {
    expect(scoreDate('2026-03-04', '2026-03-06')).toBe(30);
  });
  it('±5 days scores 20', () => {
    expect(scoreDate('2026-03-04', '2026-03-09')).toBe(20);
  });
  it('±10 days scores 10', () => {
    expect(scoreDate('2026-03-04', '2026-03-14')).toBe(10);
  });
  it('beyond 10 days scores 0', () => {
    expect(scoreDate('2026-03-04', '2026-03-20')).toBe(0);
  });
  it('handles direction symmetrically', () => {
    expect(scoreDate('2026-03-09', '2026-03-04')).toBe(20);
  });
});

describe('scoreText', () => {
  it('vendor as substring of bank desc scores 20', () => {
    expect(scoreText('amzn mktp ca abc123 amazon ca', 'Amazon')).toBe(20);
  });
  it('reverse substring scores 15', () => {
    expect(scoreText('home depot', 'Home Depot Yaletown #7042')).toBe(15);
  });
  it('Jaccard token overlap scores partial', () => {
    const score = scoreText('payroll deposit acme reno', 'acme construction');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(15);
  });
  it('zero overlap scores 0', () => {
    expect(scoreText('starbucks 00214', 'Acme Plumbing')).toBe(0);
  });
});

describe('findMatchCandidates — outflow (debit)', () => {
  it('matches an exact expense with high confidence', () => {
    const result = findMatchCandidates(tx(), {
      invoices: [],
      expenses: [expense()],
      bills: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('expense');
    expect(result[0].confidence).toBe('high');
    expect(result[0].score).toBeGreaterThanOrEqual(85);
  });

  it('does NOT consider invoices for outflows', () => {
    const result = findMatchCandidates(tx(), {
      invoices: [invoice()],
      expenses: [],
      bills: [],
    });
    expect(result).toHaveLength(0);
  });

  it('returns top 3 ranked by score', () => {
    const result = findMatchCandidates(tx(), {
      invoices: [],
      expenses: [
        expense({ id: 'a', vendor: 'Random Co', amount_cents: 18500 }), // amount fuzzy
        expense({ id: 'b', vendor: 'Home Depot' }), // exact
        expense({ id: 'c', vendor: 'Other Place', amount_cents: 18400 }), // close
        expense({ id: 'd', vendor: 'Yet Another', amount_cents: 18450 }),
      ],
      bills: [],
    });
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('b'); // exact + name match wins
  });
});

describe('findMatchCandidates — inflow (credit)', () => {
  it('matches an exact invoice with high confidence', () => {
    const result = findMatchCandidates(
      tx({ amount_cents: 520000, description_normalized: 'payroll deposit acme reno ltd' }),
      {
        invoices: [invoice({ amount_cents: 520000, customer_name: 'ACME RENO LTD' })],
        expenses: [],
        bills: [],
      },
    );
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('invoice');
    expect(result[0].confidence).toBe('high');
  });

  it('does NOT consider expenses or bills for inflows', () => {
    const result = findMatchCandidates(
      tx({ amount_cents: 520000, description_normalized: 'deposit' }),
      {
        invoices: [],
        expenses: [expense({ amount_cents: 520000 })],
        bills: [bill({ amount_cents: 520000 })],
      },
    );
    expect(result).toHaveLength(0);
  });

  it('falls back to invoice.created_at when sent_at is null', () => {
    const result = findMatchCandidates(
      tx({ amount_cents: 184_27, description_normalized: 'acme' }),
      {
        invoices: [invoice({ sent_at: null, created_at: '2026-03-04T12:00:00Z' })],
        expenses: [],
        bills: [],
      },
    );
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeGreaterThanOrEqual(60);
  });
});

describe('findMatchCandidates — bills', () => {
  it('matches an unpaid bill on outflow', () => {
    const result = findMatchCandidates(tx({ description_normalized: 'acme plumbing inv 4421' }), {
      invoices: [],
      expenses: [],
      bills: [bill()],
    });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('bill');
    expect(result[0].score).toBeGreaterThanOrEqual(85);
  });
});

describe('findMatchCandidates — no-match floor', () => {
  it('drops candidates below score 30', () => {
    const result = findMatchCandidates(
      tx({
        amount_cents: -18427,
        posted_at: '2026-03-04',
        description_normalized: 'totally unrelated string',
      }),
      {
        invoices: [],
        expenses: [
          expense({
            amount_cents: 18000, // beyond 1% — amount score 0
            expense_date: '2026-03-04',
            vendor: 'Random',
          }),
        ],
        bills: [],
      },
    );
    expect(result).toHaveLength(0);
  });

  it('returns empty when pool is empty', () => {
    const result = findMatchCandidates(tx(), {
      invoices: [],
      expenses: [],
      bills: [],
    });
    expect(result).toHaveLength(0);
  });
});

describe('findMatchCandidates — confidence buckets', () => {
  it('amount + date alone (no text) lands in medium', () => {
    const result = findMatchCandidates(tx({ description_normalized: 'unrelated' }), {
      invoices: [],
      expenses: [expense({ vendor: 'Different Vendor' })],
      bills: [],
    });
    expect(result[0]?.confidence).toBe('medium');
    expect(result[0]?.score).toBeGreaterThanOrEqual(60);
    expect(result[0]?.score).toBeLessThan(85);
  });

  it('weak match (1% amount + 5d date + no text) lands in low', () => {
    const result = findMatchCandidates(
      tx({
        amount_cents: -18500, // 1% off
        posted_at: '2026-03-09', // 5d off
        description_normalized: 'unrelated',
      }),
      {
        invoices: [],
        expenses: [expense({ amount_cents: 18427, vendor: 'Different' })],
        bills: [],
      },
    );
    expect(result[0]?.confidence).toBe('low');
    expect(result[0]?.score).toBeGreaterThanOrEqual(30);
    expect(result[0]?.score).toBeLessThan(60);
  });
});
