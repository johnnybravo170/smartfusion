import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.QBO_CLIENT_ID ??= 'test';
  process.env.QBO_CLIENT_SECRET ??= 'test';
  process.env.QBO_REDIRECT_URI ??= 'http://localhost:3000/api/qbo/callback';
  process.env.QBO_STATE_SECRET ??= 'unit-test-secret-padded-to-32-chars-min';
});

import { mapInvoiceLines, mapQboInvoiceToRow } from '@/lib/qbo/import/invoices';
import type { QboInvoice, QboInvoiceLine } from '@/lib/qbo/types';

function makeInvoice(overrides: Partial<QboInvoice> = {}): QboInvoice {
  return {
    Id: '100',
    SyncToken: '0',
    CustomerRef: { value: 'cust-1', name: 'Acme' },
    TotalAmt: 0,
    Balance: 0,
    ...overrides,
  };
}

describe('mapQboInvoiceToRow status', () => {
  it('marks zero-balance invoices as paid', () => {
    const { row } = mapQboInvoiceToRow(
      makeInvoice({ TotalAmt: 100, Balance: 0, TxnDate: '2024-06-15' }),
    );
    expect(row.status).toBe('paid');
    expect(row.paid_at).not.toBeNull();
  });

  it('marks open-balance invoices as sent', () => {
    const { row } = mapQboInvoiceToRow(
      makeInvoice({ TotalAmt: 100, Balance: 50, TxnDate: '2024-06-15' }),
    );
    expect(row.status).toBe('sent');
    expect(row.paid_at).toBeNull();
    expect(row.sent_at).not.toBeNull();
  });

  it('marks Void invoices as void regardless of balance', () => {
    const { row } = mapQboInvoiceToRow(makeInvoice({ TotalAmt: 100, Balance: 0, Void: true }));
    expect(row.status).toBe('void');
  });
});

describe('mapQboInvoiceToRow money math', () => {
  it('subtracts tax from total to compute amount_cents', () => {
    const { row } = mapQboInvoiceToRow(
      makeInvoice({ TotalAmt: 105, TxnTaxDetail: { TotalTax: 5 } }),
    );
    expect(row.amount_cents).toBe(10000); // $100 pre-tax
    expect(row.tax_cents).toBe(500);
  });

  it('handles invoices with zero tax', () => {
    const { row } = mapQboInvoiceToRow(makeInvoice({ TotalAmt: 250 }));
    expect(row.amount_cents).toBe(25000);
    expect(row.tax_cents).toBe(0);
  });

  it('clamps negative amount_cents to 0 (defensive)', () => {
    // Tax somehow exceeds total — shouldn't happen but don't crash.
    const { row } = mapQboInvoiceToRow(
      makeInvoice({ TotalAmt: 100, TxnTaxDetail: { TotalTax: 200 } }),
    );
    expect(row.amount_cents).toBe(0);
  });
});

describe('mapInvoiceLines', () => {
  function line(overrides: Partial<QboInvoiceLine> = {}): QboInvoiceLine {
    return {
      LineNum: 1,
      Description: 'Default',
      Amount: 100,
      SalesItemLineDetail: { Qty: 1, UnitPrice: 100, ItemRef: { value: 'i1', name: 'Item' } },
      ...overrides,
    };
  }

  it('maps a simple billable line', () => {
    const out = mapInvoiceLines([
      line({
        Description: 'Service A',
        Amount: 250,
        SalesItemLineDetail: { Qty: 1, UnitPrice: 250 },
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      description: 'Service A',
      quantity: 1,
      unit_price_cents: 25000,
      total_cents: 25000,
    });
  });

  it('skips subtotal / discount / group control rows', () => {
    const out = mapInvoiceLines([
      line({ Description: 'A', Amount: 100 }),
      // No SalesItemLineDetail → control row, skip
      { DetailType: 'SubTotalLineDetail', Amount: 100 } as QboInvoiceLine,
      { DetailType: 'DiscountLineDetail', Amount: -10 } as QboInvoiceLine,
      line({ Description: 'B', Amount: 50 }),
    ]);
    expect(out.map((o) => o.description)).toEqual(['A', 'B']);
  });

  it('falls back to ItemRef name when description is missing', () => {
    const out = mapInvoiceLines([
      line({
        Description: undefined,
        SalesItemLineDetail: {
          Qty: 1,
          UnitPrice: 50,
          ItemRef: { value: 'i', name: 'Furnace tune-up' },
        },
      }),
    ]);
    expect(out[0].description).toBe('Furnace tune-up');
  });

  it('derives unit_price from amount/qty when UnitPrice missing', () => {
    const out = mapInvoiceLines([line({ Amount: 150, SalesItemLineDetail: { Qty: 3 } })]);
    expect(out[0].unit_price_cents).toBe(5000); // 150/3 = 50
  });

  it('handles multi-quantity lines', () => {
    const out = mapInvoiceLines([
      line({ Amount: 90, SalesItemLineDetail: { Qty: 3, UnitPrice: 30 } }),
    ]);
    expect(out[0]).toEqual({
      description: 'Default',
      quantity: 3,
      unit_price_cents: 3000,
      total_cents: 9000,
    });
  });

  it('returns empty array for no lines', () => {
    expect(mapInvoiceLines([])).toEqual([]);
  });
});
