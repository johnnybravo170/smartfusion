'use server';

/**
 * Server actions for expense logging.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

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

export async function deleteExpenseAction(id: string): Promise<ExpenseActionResult> {
  if (!id) return { ok: false, error: 'Missing expense id.' };

  const supabase = await createClient();
  const { error } = await supabase.from('expenses').delete().eq('id', id);

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true, id };
}
