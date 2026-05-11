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

const NETWORK_LITERALS: PaymentSourceNetwork[] = [
  'visa',
  'mastercard',
  'amex',
  'interac',
  'discover',
  'other',
];

/**
 * Coerce a free-form network string from OCR ("Visa", "DEBIT", "MC") to
 * the canonical enum or null. Used by every receipt OCR path that pulls
 * card info — overhead form, bulk import, and the single-receipt flows
 * driven by quick-log / worker form.
 */
export function normalizePaymentNetwork(v: string | null): PaymentSourceNetwork | null {
  if (!v) return null;
  const lc = v.toLowerCase().trim();
  return (NETWORK_LITERALS as string[]).includes(lc) ? (lc as PaymentSourceNetwork) : null;
}

/**
 * Pull the last 4 digits from a free-form card line. Models return many
 * shapes ("****1234", "VISA 1234", "...1234", "Card # XXXXXXXXXXXX1234")
 * — we want only the trailing 4 digits as a string. Null when fewer than
 * 4 digits exist anywhere in the input.
 */
export function extractCardLast4(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

export type PaymentSourceResolution = 'matched_card' | 'unknown_card' | 'fallback_default' | 'none';

/**
 * Decide which payment source an OCR'd receipt belongs to, given the
 * tenant's catalog and any last-4 digits the model could read off the
 * receipt:
 *  - `matched_card`     → last4 matches an active source; use its id.
 *  - `unknown_card`     → last4 was read but doesn't match any source;
 *                         caller surfaces a "Label this card?" prompt.
 *  - `fallback_default` → no card visible (cash, e-transfer, paper);
 *                         use the tenant default source.
 *  - `none`             → no default configured (rare — tenant seed
 *                         should always provide one).
 */
export function resolvePaymentSource(
  cardLast4: string | null,
  sources: { id: string; last4: string | null; is_default: boolean; archived_at?: string | null }[],
): { paymentSourceId: string | null; resolution: PaymentSourceResolution } {
  if (cardLast4) {
    const matched = sources.find((s) => s.last4 === cardLast4 && !s.archived_at);
    if (matched) return { paymentSourceId: matched.id, resolution: 'matched_card' };
    return { paymentSourceId: null, resolution: 'unknown_card' };
  }
  const def = sources.find((s) => s.is_default);
  if (def) return { paymentSourceId: def.id, resolution: 'fallback_default' };
  return { paymentSourceId: null, resolution: 'none' };
}
