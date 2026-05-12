import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.QBO_CLIENT_ID ??= 'test';
  process.env.QBO_CLIENT_SECRET ??= 'test';
  process.env.QBO_REDIRECT_URI ??= 'http://localhost:3000/api/qbo/callback';
  process.env.QBO_STATE_SECRET ??= 'unit-test-secret-padded-to-32-chars-min';
});

import { mapQboBillLines, mapQboBillToHeader } from '@/lib/qbo/import/bills';
import { mapQboEstimateToRow } from '@/lib/qbo/import/estimates';
import { extractInvoiceApplications, mapPaymentMethod } from '@/lib/qbo/import/payments';
import { mapQboPurchaseToRow } from '@/lib/qbo/import/purchases';
import { mapQboVendorToRow } from '@/lib/qbo/import/vendors';
import type { QboBill, QboEstimate, QboPayment, QboPurchase, QboVendor } from '@/lib/qbo/types';

describe('mapQboVendorToRow', () => {
  function vendor(overrides: Partial<QboVendor> = {}): QboVendor {
    return { Id: '1', SyncToken: '0', DisplayName: 'V', ...overrides };
  }

  it('prefers CompanyName over DisplayName', () => {
    const row = mapQboVendorToRow(vendor({ DisplayName: 'John Smith', CompanyName: 'Home Depot' }));
    expect(row.name).toBe('Home Depot');
  });

  it('falls back to DisplayName when CompanyName is missing', () => {
    const row = mapQboVendorToRow(vendor({ DisplayName: 'Sole Trader' }));
    expect(row.name).toBe('Sole Trader');
  });

  it('maps address + phone + email cleanly', () => {
    const row = mapQboVendorToRow(
      vendor({
        DisplayName: 'Sub Co',
        PrimaryEmailAddr: { Address: 'biz@example.com' },
        PrimaryPhone: { FreeFormNumber: '604-555-0000' },
        BillAddr: { Line1: '1 Main', City: 'Surrey', CountrySubDivisionCode: 'BC' },
      }),
    );
    expect(row.email).toBe('biz@example.com');
    expect(row.phone).toBe('604-555-0000');
    expect(row.address_line1).toBe('1 Main');
    expect(row.province).toBe('BC');
  });
});

describe('mapQboEstimateToRow status', () => {
  function est(overrides: Partial<QboEstimate> = {}): QboEstimate {
    return { Id: '1', SyncToken: '0', CustomerRef: { value: 'c' }, ...overrides };
  }

  it('maps Accepted to accepted with accepted_at set', () => {
    const { row } = mapQboEstimateToRow(est({ TxnStatus: 'Accepted', TxnDate: '2024-01-15' }));
    expect(row.status).toBe('accepted');
    expect(row.accepted_at).not.toBeNull();
  });

  it('maps Rejected to rejected', () => {
    const { row } = mapQboEstimateToRow(est({ TxnStatus: 'Rejected' }));
    expect(row.status).toBe('rejected');
    expect(row.accepted_at).toBeNull();
  });

  it('maps Closed to expired', () => {
    const { row } = mapQboEstimateToRow(est({ TxnStatus: 'Closed' }));
    expect(row.status).toBe('expired');
  });

  it('defaults Pending and missing status to sent', () => {
    expect(mapQboEstimateToRow(est({ TxnStatus: 'Pending' })).row.status).toBe('sent');
    expect(mapQboEstimateToRow(est()).row.status).toBe('sent');
  });
});

describe('mapPaymentMethod', () => {
  it('maps Cash exactly', () => {
    expect(mapPaymentMethod('Cash')).toBe('cash');
  });
  it('maps Check + Cheque to cheque', () => {
    expect(mapPaymentMethod('Check')).toBe('cheque');
    expect(mapPaymentMethod('Cheque')).toBe('cheque');
  });
  it('maps Credit Card variants to credit_card', () => {
    expect(mapPaymentMethod('Credit Card')).toBe('credit_card');
    expect(mapPaymentMethod('CC')).toBe('credit_card');
    expect(mapPaymentMethod('Credit')).toBe('credit_card');
  });
  it('routes Stripe / Square to stripe', () => {
    expect(mapPaymentMethod('Stripe')).toBe('stripe');
    expect(mapPaymentMethod('Square Online')).toBe('stripe');
  });
  it('routes EFT to e-transfer', () => {
    expect(mapPaymentMethod('E-Transfer')).toBe('e-transfer');
    expect(mapPaymentMethod('Interac eTransfer')).toBe('e-transfer');
    expect(mapPaymentMethod('EFT')).toBe('e-transfer');
  });
  it('falls back to other for unknowns', () => {
    expect(mapPaymentMethod('Barter')).toBe('other');
    expect(mapPaymentMethod(null)).toBe('other');
    expect(mapPaymentMethod(undefined)).toBe('other');
  });
});

describe('extractInvoiceApplications', () => {
  it('returns one application per invoice LinkedTxn', () => {
    const payment: QboPayment = {
      Id: 'p1',
      SyncToken: '0',
      CustomerRef: { value: 'c1' },
      Line: [
        {
          Amount: 100,
          LinkedTxn: [{ TxnId: 'inv1', TxnType: 'Invoice' }],
        },
        {
          Amount: 50,
          LinkedTxn: [{ TxnId: 'inv2', TxnType: 'Invoice' }],
        },
      ],
    };
    const apps = extractInvoiceApplications(payment);
    expect(apps).toEqual([
      { qbo_invoice_id: 'inv1', amount_cents: 10000 },
      { qbo_invoice_id: 'inv2', amount_cents: 5000 },
    ]);
  });

  it('ignores non-Invoice LinkedTxn (e.g. CreditMemo)', () => {
    const payment: QboPayment = {
      Id: 'p1',
      SyncToken: '0',
      CustomerRef: { value: 'c1' },
      Line: [
        {
          Amount: 100,
          LinkedTxn: [
            { TxnId: 'cm1', TxnType: 'CreditMemo' },
            { TxnId: 'inv1', TxnType: 'Invoice' },
          ],
        },
      ],
    };
    const apps = extractInvoiceApplications(payment);
    expect(apps).toHaveLength(1);
    expect(apps[0].qbo_invoice_id).toBe('inv1');
  });

  it('returns empty for unapplied payments', () => {
    const payment: QboPayment = {
      Id: 'p1',
      SyncToken: '0',
      CustomerRef: { value: 'c1' },
      Line: [],
    };
    expect(extractInvoiceApplications(payment)).toEqual([]);
  });
});

describe('mapQboBillToHeader status', () => {
  function bill(overrides: Partial<QboBill> = {}): QboBill {
    return {
      Id: '1',
      SyncToken: '0',
      VendorRef: { value: 'v1' },
      TxnDate: '2024-03-01',
      ...overrides,
    };
  }

  it('marks balance=0 as paid', () => {
    const { row } = mapQboBillToHeader(bill({ TotalAmt: 100, Balance: 0 }));
    expect(row.status).toBe('paid');
  });
  it('marks balance=total as open', () => {
    const { row } = mapQboBillToHeader(bill({ TotalAmt: 100, Balance: 100 }));
    expect(row.status).toBe('open');
  });
  it('marks partial when balance is between 0 and total', () => {
    const { row } = mapQboBillToHeader(bill({ TotalAmt: 100, Balance: 30 }));
    expect(row.status).toBe('partial');
  });
  it('frozen money math: subtotal = total - tax', () => {
    const { row } = mapQboBillToHeader(
      bill({ TotalAmt: 110, TxnTaxDetail: { TotalTax: 10 }, Balance: 110 }),
    );
    expect(row.total_cents).toBe(11000);
    expect(row.tax_cents).toBe(1000);
    expect(row.subtotal_cents).toBe(10000);
  });
});

describe('mapQboBillLines', () => {
  it('handles account-based lines', () => {
    const lines = mapQboBillLines([
      {
        Id: 'L1',
        Amount: 200,
        Description: 'Materials',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'a1', name: 'Cost of Goods Sold' },
          ClassRef: { value: 'cls1' },
          CustomerRef: { value: 'cust1' },
        },
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      detail_type: 'account',
      amount_cents: 20000,
      description: 'Materials',
      qbo_account_id: 'a1',
      qbo_account_name: 'Cost of Goods Sold',
      qbo_class_id: 'cls1',
      qbo_customer_ref: 'cust1',
    });
  });

  it('handles item-based lines', () => {
    const lines = mapQboBillLines([
      {
        Id: 'L1',
        Amount: 50,
        ItemBasedExpenseLineDetail: { ItemRef: { value: 'i1', name: 'Filter' } },
      },
    ]);
    expect(lines[0].detail_type).toBe('item');
    expect(lines[0].qbo_item_id).toBe('i1');
    expect(lines[0].qbo_account_id).toBeNull();
  });

  it('handles missing detail (control rows)', () => {
    const lines = mapQboBillLines([{ Id: 'L1', Amount: 0 }]);
    expect(lines[0].detail_type).toBeNull();
  });

  it('preserves position', () => {
    const lines = mapQboBillLines([
      { Id: 'L1', Amount: 10, AccountBasedExpenseLineDetail: {} },
      { Id: 'L2', Amount: 20, AccountBasedExpenseLineDetail: {} },
    ]);
    expect(lines[0].position).toBe(0);
    expect(lines[1].position).toBe(1);
  });
});

describe('mapQboPurchaseToRow', () => {
  function purchase(overrides: Partial<QboPurchase> = {}): QboPurchase {
    return { Id: '1', SyncToken: '0', TxnDate: '2024-05-01', ...overrides };
  }

  it('maps a typical credit-card purchase', () => {
    const row = mapQboPurchaseToRow(
      purchase({
        TotalAmt: 87.45,
        EntityRef: { value: 'v1', name: 'Home Depot' },
        Line: [{ Description: 'Lumber + nails', Amount: 87.45 }],
        PrivateNote: 'project Jenkins',
      }),
    );
    expect(row).not.toBeNull();
    expect(row?.amount_cents).toBe(8745);
    expect(row?.vendor).toBe('Home Depot');
    expect(row?.description).toContain('Lumber + nails');
    expect(row?.description).toContain('project Jenkins');
  });

  it('skips zero-amount purchases', () => {
    expect(mapQboPurchaseToRow(purchase({ TotalAmt: 0 }))).toBeNull();
  });

  it('skips negative-amount purchases (refunds)', () => {
    expect(mapQboPurchaseToRow(purchase({ TotalAmt: -25 }))).toBeNull();
  });

  it('falls back to AccountRef name when EntityRef is missing', () => {
    const row = mapQboPurchaseToRow(
      purchase({
        TotalAmt: 50,
        AccountRef: { value: 'a1', name: 'TD VISA' },
      }),
    );
    expect(row?.vendor).toBe('TD VISA');
  });
});
