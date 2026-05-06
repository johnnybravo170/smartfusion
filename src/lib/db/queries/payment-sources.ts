/**
 * Payment-source queries — tenant-scoped via RLS.
 *
 * Sources are a small catalog (typically <10 rows per tenant) so we
 * don't bother with pagination or filtering at the DB layer. The
 * picker lists everything active.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';

export type PaymentSourceKind = 'debit' | 'credit' | 'cash' | 'etransfer' | 'cheque' | 'other';
export type PaymentSourcePaidBy = 'business' | 'personal_reimbursable' | 'petty_cash';
export type PaymentSourceNetwork =
  | 'visa'
  | 'mastercard'
  | 'amex'
  | 'interac'
  | 'discover'
  | 'other';

export type PaymentSourceRow = {
  id: string;
  tenant_id: string;
  label: string;
  last4: string | null;
  network: PaymentSourceNetwork | null;
  kind: PaymentSourceKind;
  paid_by: PaymentSourcePaidBy;
  default_account_code: string | null;
  is_default: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS =
  'id, tenant_id, label, last4, network, kind, paid_by, default_account_code, is_default, archived_at, created_at, updated_at';

async function listPaymentSourcesUncached(opts?: {
  includeArchived?: boolean;
}): Promise<PaymentSourceRow[]> {
  const supabase = await createClient();
  let query = supabase
    .from('payment_sources')
    .select(COLUMNS)
    .order('is_default', { ascending: false })
    .order('label', { ascending: true });
  if (!opts?.includeArchived) {
    query = query.is('archived_at', null);
  }
  const { data, error } = await query;
  if (error) throw new Error(`Failed to list payment sources: ${error.message}`);
  return (data ?? []) as PaymentSourceRow[];
}

export const listPaymentSources = cache(listPaymentSourcesUncached);

export async function getDefaultPaymentSourceId(): Promise<string | null> {
  const sources = await listPaymentSources();
  return sources.find((s) => s.is_default)?.id ?? null;
}

/** Lite shape for the wizard's per-row picker. */
export type PaymentSourceLite = {
  id: string;
  label: string;
  last4: string | null;
  kind: PaymentSourceKind;
  paid_by: PaymentSourcePaidBy;
  is_default: boolean;
};

export function toLite(rows: PaymentSourceRow[]): PaymentSourceLite[] {
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    last4: r.last4,
    kind: r.kind,
    paid_by: r.paid_by,
    is_default: r.is_default,
  }));
}

/**
 * Returns "personal_reimbursable" / "petty_cash" pills should be shown
 * in the UI. Pure derivation; kept here so callers don't reinvent the
 * tone mapping.
 */
export function paidByLabel(p: PaymentSourcePaidBy): string {
  if (p === 'business') return 'Business';
  if (p === 'personal_reimbursable') return 'Reimbursable';
  return 'Petty cash';
}
