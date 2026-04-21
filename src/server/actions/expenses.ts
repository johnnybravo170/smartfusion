'use server';

/**
 * Server actions for expense logging.
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const RECEIPTS_BUCKET = 'receipts';
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

function extFromContentType(contentType: string): string {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/heic' || contentType === 'image/heif') return 'heic';
  if (contentType === 'application/pdf') return 'pdf';
  return 'jpg';
}

export type ExpenseActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

const expenseSchema = z.object({
  project_id: z.string().uuid().optional().or(z.literal('')),
  job_id: z.string().uuid().optional().or(z.literal('')),
  bucket_id: z.string().uuid().optional().or(z.literal('')),
  amount_cents: z.coerce.number().int().positive({ message: 'Amount must be greater than 0.' }),
  vendor: z.string().trim().max(200).optional().or(z.literal('')),
  description: z.string().trim().max(2000).optional().or(z.literal('')),
  receipt_url: z.string().url().optional().or(z.literal('')),
  expense_date: z.string().min(1, { message: 'Date is required.' }),
});

export async function logExpenseAction(input: {
  project_id?: string;
  job_id?: string;
  bucket_id?: string;
  amount_cents: number;
  vendor?: string;
  description?: string;
  receipt_url?: string;
  expense_date: string;
}): Promise<ExpenseActionResult> {
  const parsed = expenseSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const projectId = parsed.data.project_id || null;
  const jobId = parsed.data.job_id || null;
  if (!projectId && !jobId) {
    return { ok: false, error: 'A project or job is required.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('expenses')
    .insert({
      tenant_id: tenant.id,
      user_id: user.id,
      project_id: projectId,
      job_id: jobId,
      bucket_id: parsed.data.bucket_id || null,
      amount_cents: parsed.data.amount_cents,
      vendor: parsed.data.vendor?.trim() || null,
      description: parsed.data.description?.trim() || null,
      receipt_url: parsed.data.receipt_url || null,
      expense_date: parsed.data.expense_date,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to log expense.' };
  }

  if (projectId) revalidatePath(`/projects/${projectId}`);
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  return { ok: true, id: data.id };
}

/**
 * FormData-based variant that supports uploading a receipt image/PDF.
 * Used by the owner-side time-expense tab.
 */
export async function logExpenseWithReceiptAction(
  formData: FormData,
): Promise<ExpenseActionResult> {
  const input = {
    project_id: String(formData.get('project_id') ?? ''),
    bucket_id: String(formData.get('bucket_id') ?? ''),
    amount_cents: Number(formData.get('amount_cents') ?? 0),
    vendor: String(formData.get('vendor') ?? ''),
    description: String(formData.get('description') ?? ''),
    expense_date: String(formData.get('expense_date') ?? ''),
  };

  const parsed = expenseSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  if (!parsed.data.project_id) {
    return { ok: false, error: 'A project is required.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };

  const admin = createAdminClient();

  let receiptStoragePath: string | null = null;
  const receipt = formData.get('receipt');
  if (receipt && receipt instanceof File && receipt.size > 0) {
    if (receipt.size > MAX_RECEIPT_BYTES) {
      return { ok: false, error: 'Receipt is larger than 10MB.' };
    }
    const ext = extFromContentType(receipt.type);
    const path = `${tenant.id}/${user.id}/${randomUUID()}.${ext}`;
    const { error: upErr } = await admin.storage
      .from(RECEIPTS_BUCKET)
      .upload(path, receipt, { contentType: receipt.type || 'image/jpeg', upsert: false });
    if (upErr) return { ok: false, error: `Receipt upload failed: ${upErr.message}` };
    receiptStoragePath = path;
  }

  const { data, error } = await admin
    .from('expenses')
    .insert({
      tenant_id: tenant.id,
      user_id: user.id,
      project_id: parsed.data.project_id,
      bucket_id: parsed.data.bucket_id || null,
      amount_cents: parsed.data.amount_cents,
      vendor: parsed.data.vendor?.trim() || null,
      description: parsed.data.description?.trim() || null,
      receipt_storage_path: receiptStoragePath,
      expense_date: parsed.data.expense_date,
    })
    .select('id')
    .single();

  if (error || !data) {
    if (receiptStoragePath) {
      await admin.storage.from(RECEIPTS_BUCKET).remove([receiptStoragePath]);
    }
    return { ok: false, error: error?.message ?? 'Failed to log expense.' };
  }

  revalidatePath(`/projects/${parsed.data.project_id}`);
  return { ok: true, id: data.id };
}

export async function deleteExpenseAction(id: string): Promise<ExpenseActionResult> {
  if (!id) return { ok: false, error: 'Missing expense id.' };

  const supabase = await createClient();
  const { error } = await supabase.from('expenses').delete().eq('id', id);

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true, id };
}
