/**
 * Unit tests for the field-mapping half of the cost-unification dual-write
 * shim. The IO side (read source row + upsert) is covered indirectly by
 * the prod-side backfill assertions; here we lock down the row → row
 * translation since the rest of the rollout depends on it being correct.
 */

import { describe, expect, it } from 'vitest';
import { billRowToProjectCost, expenseRowToProjectCost } from '@/lib/db/project-costs-shim';

const baseExpense = {
  id: '00000000-0000-0000-0000-000000000001',
  tenant_id: 't1',
  user_id: 'u1',
  project_id: 'p1',
  budget_category_id: 'bc1',
  cost_line_id: 'cl1',
  category_id: null,
  job_id: null,
  amount_cents: 11300,
  pre_tax_amount_cents: 10000,
  tax_cents: 1300,
  vendor: 'Home Depot',
  vendor_gst_number: '123456789',
  description: 'Lumber',
  receipt_url: null,
  receipt_storage_path: 'tenants/t1/receipt.pdf',
  expense_date: '2026-05-10',
  created_at: '2026-05-10T15:00:00Z',
  updated_at: '2026-05-10T15:00:00Z',
  worker_profile_id: null,
  worker_invoice_id: null,
  recurring_rule_id: null,
  import_batch_id: null,
  payment_source_id: 'ps1',
  card_last4: '1234',
  qbo_purchase_id: null,
  qbo_sync_token: null,
  qbo_sync_status: null,
  qbo_synced_at: null,
};

const baseBill = {
  id: '00000000-0000-0000-0000-000000000002',
  tenant_id: 't1',
  project_id: 'p1',
  vendor: 'Mike Roofing Ltd',
  bill_date: '2026-05-08',
  description: 'Sub-bill — roof replacement',
  amount_cents: 80000, // pre-GST
  status: 'pending' as 'pending' | 'approved' | 'paid',
  receipt_url: null,
  cost_code: 'SUB-002',
  created_at: '2026-05-08T10:00:00Z',
  updated_at: '2026-05-08T10:00:00Z',
  inbound_email_id: 'eml1',
  budget_category_id: 'bc2',
  gst_cents: 10400,
  attachment_storage_path: 'tenants/t1/bill.pdf',
  vendor_gst_number: '987654321',
  cost_line_id: null,
};

describe('expenseRowToProjectCost', () => {
  it('marks receipts paid at creation time', () => {
    const cost = expenseRowToProjectCost(baseExpense);
    expect(cost.source_type).toBe('receipt');
    expect(cost.payment_status).toBe('paid');
    expect(cost.paid_at).toBe(baseExpense.created_at);
  });

  it('passes gross amount through (expenses are already gross)', () => {
    const cost = expenseRowToProjectCost(baseExpense);
    expect(cost.amount_cents).toBe(11300);
    expect(cost.pre_tax_amount_cents).toBe(10000);
    expect(cost.gst_cents).toBe(1300);
  });

  it('renames expense_date → cost_date and receipt_storage_path → attachment_storage_path', () => {
    const cost = expenseRowToProjectCost(baseExpense);
    expect(cost.cost_date).toBe('2026-05-10');
    expect(cost.attachment_storage_path).toBe('tenants/t1/receipt.pdf');
  });

  it('preserves the id (so source + mirror stay in lockstep)', () => {
    const cost = expenseRowToProjectCost(baseExpense);
    expect(cost.id).toBe(baseExpense.id);
  });

  it('keeps pre_tax_amount_cents null for legacy receipts without breakdown', () => {
    const legacy = { ...baseExpense, pre_tax_amount_cents: null };
    const cost = expenseRowToProjectCost(legacy);
    expect(cost.pre_tax_amount_cents).toBeNull();
    expect(cost.amount_cents).toBe(11300);
  });

  it('allows negative amounts (credits / supplier refunds)', () => {
    const credit = { ...baseExpense, amount_cents: -5000 };
    const cost = expenseRowToProjectCost(credit);
    expect(cost.amount_cents).toBe(-5000);
  });
});

describe('billRowToProjectCost', () => {
  it('grosses up amount_cents (project_bills source is pre-GST)', () => {
    const cost = billRowToProjectCost(baseBill);
    // 80000 pre-GST + 10400 GST = 90400 gross
    expect(cost.amount_cents).toBe(90400);
    expect(cost.pre_tax_amount_cents).toBe(80000);
    expect(cost.gst_cents).toBe(10400);
  });

  it("maps status 'pending'+'approved' to payment_status='unpaid'", () => {
    expect(billRowToProjectCost({ ...baseBill, status: 'pending' }).payment_status).toBe('unpaid');
    expect(billRowToProjectCost({ ...baseBill, status: 'approved' }).payment_status).toBe('unpaid');
  });

  it("maps status 'paid' to payment_status='paid' and stamps paid_at from updated_at", () => {
    const paid = billRowToProjectCost({ ...baseBill, status: 'paid' });
    expect(paid.payment_status).toBe('paid');
    expect(paid.paid_at).toBe(baseBill.updated_at);
  });

  it('leaves paid_at null on unpaid bills', () => {
    expect(billRowToProjectCost(baseBill).paid_at).toBeNull();
  });

  it('renames bill_date → cost_date and routes cost_code into external_ref', () => {
    const cost = billRowToProjectCost(baseBill);
    expect(cost.cost_date).toBe('2026-05-08');
    expect(cost.external_ref).toBe('SUB-002');
  });

  it('preserves inbound_email_id provenance', () => {
    expect(billRowToProjectCost(baseBill).inbound_email_id).toBe('eml1');
  });

  it('forces user_id null (bills have no entrant)', () => {
    expect(billRowToProjectCost(baseBill).user_id).toBeNull();
  });

  it('preserves the id', () => {
    expect(billRowToProjectCost(baseBill).id).toBe(baseBill.id);
  });

  it('handles bills with gst_cents=0 (pre-0083 legacy rows)', () => {
    const noGst = { ...baseBill, gst_cents: 0 };
    const cost = billRowToProjectCost(noGst);
    expect(cost.amount_cents).toBe(80000);
    expect(cost.pre_tax_amount_cents).toBe(80000);
    expect(cost.gst_cents).toBe(0);
  });
});
