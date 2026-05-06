/**
 * Overhead expense queries — operating expenses not tied to any project.
 * Same `expenses` table as project expenses; filtered by `project_id IS NULL`.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const RECEIPT_URL_TTL_SECONDS = 60 * 60; // 1h — matches edit-page convention

export type OverheadExpenseRow = {
  id: string;
  expense_date: string;
  amount_cents: number;
  tax_cents: number;
  vendor: string | null;
  description: string | null;
  /** Null for overhead; populated when includeProjectExpenses is true. */
  project_id: string | null;
  receipt_storage_path: string | null;
  /** Signed URL for the receipt (1hr TTL), or null if no receipt attached. */
  receipt_signed_url: string | null;
  /** Mime type hint for the preview (image/* renders inline, pdf gets an icon). */
  receipt_mime_hint: 'image' | 'pdf' | null;
  category_id: string | null;
  category_name: string | null;
  parent_category_name: string | null;
  /** Snapshot of how this expense was paid for. Pulled from payment_sources
   *  via FK; null when the row is legacy or the source was hard-deleted. */
  payment_source: {
    id: string;
    label: string;
    last4: string | null;
    paid_by: 'business' | 'personal_reimbursable' | 'petty_cash';
    kind: 'debit' | 'credit' | 'cash' | 'etransfer' | 'cheque' | 'other';
  } | null;
  card_last4: string | null;
};

export async function listOverheadExpenses(opts?: {
  from?: string;
  to?: string;
  categoryId?: string;
  /** Include project-linked expenses too (bookkeeper view). */
  includeProjectExpenses?: boolean;
  /** Filter to only uncategorized rows (bookkeeper triage view). */
  uncategorizedOnly?: boolean;
}): Promise<OverheadExpenseRow[]> {
  const supabase = await createClient();

  let query = supabase
    .from('expenses')
    .select(
      'id, expense_date, amount_cents, tax_cents, vendor, description, receipt_storage_path, project_id, category_id, card_last4, categories:category_id (name, parent:parent_id (name)), payment_source:payment_source_id (id, label, last4, paid_by, kind)',
    )
    .order('expense_date', { ascending: false });

  if (!opts?.includeProjectExpenses) {
    query = query.is('project_id', null);
  }
  if (opts?.uncategorizedOnly) {
    query = query.is('category_id', null);
  }

  if (opts?.from) query = query.gte('expense_date', opts.from);
  if (opts?.to) query = query.lte('expense_date', opts.to);
  if (opts?.categoryId) query = query.eq('category_id', opts.categoryId);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list overhead expenses: ${error.message}`);

  // Batch-sign receipt URLs so the list can hover-preview without a
  // per-row round-trip. Admin client because the `receipts` bucket RLS
  // checks auth.uid() against a tenant_members lookup and storage RLS
  // is flaky from the list render path (same reason cost-line thumbs
  // use admin). One createSignedUrls call for all paths.
  const receiptPaths = (data ?? [])
    .map((r) => r.receipt_storage_path as string | null)
    .filter((p): p is string => !!p);

  const urlByPath = new Map<string, string>();
  if (receiptPaths.length > 0) {
    const admin = createAdminClient();
    const { data: signed } = await admin.storage
      .from('receipts')
      .createSignedUrls(receiptPaths, RECEIPT_URL_TTL_SECONDS);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) urlByPath.set(row.path, row.signedUrl);
    }
  }

  return (data ?? []).map((row) => {
    const catRaw = (row as Record<string, unknown>).categories as
      | { name?: string; parent?: { name?: string } | { name?: string }[] | null }
      | { name?: string; parent?: { name?: string } | { name?: string }[] | null }[]
      | null;
    const cat = Array.isArray(catRaw) ? catRaw[0] : catRaw;
    const parentRaw = cat?.parent;
    const parent = Array.isArray(parentRaw) ? parentRaw[0] : parentRaw;
    const receiptPath = (row.receipt_storage_path as string | null) ?? null;
    const isPdf = receiptPath?.toLowerCase().endsWith('.pdf') ?? false;

    type RawSource = {
      id?: string;
      label?: string;
      last4?: string | null;
      paid_by?: OverheadExpenseRow['payment_source'] extends infer T
        ? T extends { paid_by: infer P }
          ? P
          : never
        : never;
      kind?: OverheadExpenseRow['payment_source'] extends infer T
        ? T extends { kind: infer K }
          ? K
          : never
        : never;
    };
    const sourceRaw = (row as Record<string, unknown>).payment_source as
      | RawSource
      | RawSource[]
      | null
      | undefined;
    const source = Array.isArray(sourceRaw) ? sourceRaw[0] : sourceRaw;
    const paymentSource: OverheadExpenseRow['payment_source'] =
      source && source.id && source.label && source.paid_by && source.kind
        ? {
            id: source.id,
            label: source.label,
            last4: source.last4 ?? null,
            paid_by: source.paid_by,
            kind: source.kind,
          }
        : null;

    return {
      id: row.id as string,
      expense_date: row.expense_date as string,
      amount_cents: row.amount_cents as number,
      tax_cents: (row.tax_cents as number) ?? 0,
      vendor: (row.vendor as string | null) ?? null,
      description: (row.description as string | null) ?? null,
      project_id: (row.project_id as string | null) ?? null,
      receipt_storage_path: receiptPath,
      receipt_signed_url: receiptPath ? (urlByPath.get(receiptPath) ?? null) : null,
      receipt_mime_hint: receiptPath ? (isPdf ? 'pdf' : 'image') : null,
      category_id: (row.category_id as string | null) ?? null,
      category_name: (cat?.name as string | undefined) ?? null,
      parent_category_name: (parent?.name as string | undefined) ?? null,
      payment_source: paymentSource,
      card_last4: (row.card_last4 as string | null) ?? null,
    };
  });
}
