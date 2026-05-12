'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireWorker } from '@/lib/auth/helpers';
import { safeMirrorExpense, safeUnmirrorCost } from '@/lib/db/project-costs-shim';
import { getDefaultPaymentSourceId } from '@/lib/db/queries/payment-sources';
import { isWorkerAssignedToProject } from '@/lib/db/queries/project-assignments';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';
import { createAdminClient } from '@/lib/supabase/admin';

export type WorkerExpenseResult = { ok: true; id: string } | { ok: false; error: string };

const schema = z.object({
  project_id: z.string().uuid({ message: 'Pick a project.' }),
  budget_category_id: z.string().uuid().optional().or(z.literal('')),
  cost_line_id: z.string().uuid().optional().or(z.literal('')),
  amount_cents: z.coerce.number().int().positive(),
  // OCR-derived breakdown. Both optional. When set, used as the markup
  // base on cost-plus client invoices (ITC-aware).
  pre_tax_amount_cents: z.coerce.number().int().nonnegative().optional(),
  tax_cents: z.coerce.number().int().nonnegative().optional(),
  vendor: z.string().trim().max(200).optional().or(z.literal('')),
  vendor_gst_number: z.string().trim().max(40).optional().or(z.literal('')),
  description: z.string().trim().max(2000).optional().or(z.literal('')),
  expense_date: z.string().min(1),
  // Payment source funding the expense. Empty = fall back to tenant
  // default in the insert so the row is never silently un-attributed.
  payment_source_id: z.string().uuid().optional().or(z.literal('')),
  // Last 4 of the card snapshot, written verbatim for audit even if the
  // labeled source is later renamed/archived.
  card_last4: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .or(z.literal('')),
});

const RECEIPTS_BUCKET = 'receipts';
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

function extFromContentType(contentType: string): string {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/heic' || contentType === 'image/heif') return 'heic';
  if (contentType === 'application/pdf') return 'pdf';
  return 'jpg';
}

export async function logWorkerExpenseAction(formData: FormData): Promise<WorkerExpenseResult> {
  const rawPreTax = formData.get('pre_tax_amount_cents');
  const rawTaxCents = formData.get('tax_cents');
  const input = {
    project_id: String(formData.get('project_id') ?? ''),
    budget_category_id: String(formData.get('budget_category_id') ?? ''),
    cost_line_id: String(formData.get('cost_line_id') ?? ''),
    amount_cents: Number(formData.get('amount_cents') ?? 0),
    // Only forward the OCR breakdown if the form sent it. Absent ≠ 0.
    pre_tax_amount_cents: rawPreTax != null ? Number(rawPreTax) : undefined,
    tax_cents: rawTaxCents != null ? Number(rawTaxCents) : undefined,
    vendor: String(formData.get('vendor') ?? ''),
    vendor_gst_number: String(formData.get('vendor_gst_number') ?? ''),
    description: String(formData.get('description') ?? ''),
    expense_date: String(formData.get('expense_date') ?? ''),
    payment_source_id: String(formData.get('payment_source_id') ?? ''),
    card_last4: String(formData.get('card_last4') ?? ''),
  };
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? 'Invalid input.' };
  }

  const { user, tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);

  const admin = createAdminClient();

  // Capability check: profile override, else tenant default.
  const { data: tenantRow } = await admin
    .from('tenants')
    .select('workers_can_log_expenses')
    .eq('id', tenant.id)
    .maybeSingle();
  const canLog = profile.can_log_expenses ?? tenantRow?.workers_can_log_expenses ?? true;
  if (!canLog) return { ok: false, error: 'Expense logging is disabled for your account.' };

  const assigned = await isWorkerAssignedToProject(tenant.id, profile.id, parsed.data.project_id);
  if (!assigned) return { ok: false, error: 'You are not assigned to this project.' };

  let receiptStoragePath: string | null = null;
  const receipt = formData.get('receipt');
  if (receipt && receipt instanceof File && receipt.size > 0) {
    if (receipt.size > MAX_RECEIPT_BYTES) {
      return { ok: false, error: 'Receipt is larger than 10MB.' };
    }
    const ext = extFromContentType(receipt.type);
    const path = `${tenant.id}/${profile.id}/${randomUUID()}.${ext}`;
    const { error: upErr } = await admin.storage
      .from(RECEIPTS_BUCKET)
      .upload(path, receipt, { contentType: receipt.type || 'image/jpeg', upsert: false });
    if (upErr) return { ok: false, error: `Receipt upload failed: ${upErr.message}` };
    receiptStoragePath = path;
  }

  // Fall back to the tenant default source when the form didn't pick one.
  const paymentSourceId =
    parsed.data.payment_source_id?.trim() || (await getDefaultPaymentSourceId());

  const { data, error } = await admin
    .from('expenses')
    .insert({
      tenant_id: tenant.id,
      user_id: user.id,
      worker_profile_id: profile.id,
      project_id: parsed.data.project_id,
      budget_category_id: parsed.data.budget_category_id || null,
      cost_line_id: parsed.data.cost_line_id || null,
      amount_cents: parsed.data.amount_cents,
      pre_tax_amount_cents: parsed.data.pre_tax_amount_cents ?? null,
      ...(parsed.data.tax_cents !== undefined ? { tax_cents: parsed.data.tax_cents } : {}),
      vendor: parsed.data.vendor?.trim() || null,
      vendor_gst_number: parsed.data.vendor_gst_number?.trim() || null,
      description: parsed.data.description?.trim() || null,
      receipt_storage_path: receiptStoragePath,
      expense_date: parsed.data.expense_date,
      payment_source_id: paymentSourceId,
      card_last4: parsed.data.card_last4?.trim() || null,
    })
    .select('id')
    .single();

  if (error || !data) {
    if (receiptStoragePath) {
      await admin.storage.from(RECEIPTS_BUCKET).remove([receiptStoragePath]);
    }
    return { ok: false, error: error?.message ?? 'Failed to log expense.' };
  }

  await safeMirrorExpense(admin, data.id);

  revalidatePath('/w/expenses');
  revalidatePath('/w');
  revalidatePath(`/projects/${parsed.data.project_id}`);
  return { ok: true, id: data.id };
}

export async function deleteWorkerExpenseAction(id: string): Promise<WorkerExpenseResult> {
  if (!id) return { ok: false, error: 'Missing id.' };
  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);

  const admin = createAdminClient();
  const { data: row } = await admin
    .from('expenses')
    .select('id, worker_profile_id, project_id, receipt_storage_path, created_at')
    .eq('id', id)
    .maybeSingle();

  if (!row || row.worker_profile_id !== profile.id) {
    return { ok: false, error: 'Expense not found.' };
  }

  const ageMs = Date.now() - new Date(row.created_at as string).getTime();
  if (ageMs > 24 * 60 * 60 * 1000) {
    return { ok: false, error: 'Expenses can only be deleted within 24 hours.' };
  }

  const { error } = await admin.from('expenses').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };

  await safeUnmirrorCost(admin, id);

  if (row.receipt_storage_path) {
    await admin.storage.from(RECEIPTS_BUCKET).remove([row.receipt_storage_path as string]);
  }

  revalidatePath('/w/expenses');
  if (row.project_id) revalidatePath(`/projects/${row.project_id as string}`);
  return { ok: true, id };
}
