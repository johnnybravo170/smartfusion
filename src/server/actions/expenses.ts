'use server';

/**
 * Server actions for expense logging.
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { safeMirrorExpense, safeUnmirrorCost } from '@/lib/db/project-costs-shim';
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
  budget_category_id: z.string().uuid().optional().or(z.literal('')),
  cost_line_id: z.string().uuid().optional().or(z.literal('')),
  // Non-zero instead of strictly positive — credits/returns log as negative
  // amounts (owner-side only; the worker form still enforces positive).
  amount_cents: z.coerce
    .number()
    .int()
    .refine((n) => n !== 0, { message: 'Amount must not be zero.' }),
  // OCR-derived breakdown. Both optional: legacy/manual entries fall back
  // to amount_cents for the cost-plus markup base.
  pre_tax_amount_cents: z.coerce.number().int().nonnegative().optional(),
  tax_cents: z.coerce.number().int().nonnegative().optional(),
  vendor: z.string().trim().max(200).optional().or(z.literal('')),
  vendor_gst_number: z.string().trim().max(40).optional().or(z.literal('')),
  description: z.string().trim().max(2000).optional().or(z.literal('')),
  receipt_url: z.string().url().optional().or(z.literal('')),
  expense_date: z.string().min(1, { message: 'Date is required.' }),
  // Which payment source funded the expense — drives reimbursement
  // pills and (eventually) QB sync routing. Empty = let the insert fall
  // back to the tenant default.
  payment_source_id: z.string().uuid().optional().or(z.literal('')),
  // Last 4 of the card snapshot, written verbatim for audit even if the
  // labeled source is later renamed/archived.
  card_last4: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .or(z.literal('')),
});

/**
 * List active-ish projects with their budget categories for the Log Expense
 * dialog. Tenant-scoped via RLS — returns every project the caller's
 * session can see, with each project's categories nested.
 */
export async function listProjectsWithCategoriesForExpenseAction(): Promise<
  | {
      ok: true;
      projects: Array<{
        id: string;
        name: string;
        /** Drives the auto-split tax chip in the Log Expense dialog. */
        is_cost_plus: boolean;
        categories: Array<{ id: string; name: string }>;
      }>;
    }
  | { ok: false; error: string }
> {
  const supabase = await createClient();
  const { data: projects, error: projErr } = await supabase
    .from('projects')
    .select('id, name, is_cost_plus')
    .is('deleted_at', null)
    .in('lifecycle_stage', ['planning', 'awaiting_approval', 'active'])
    .order('created_at', { ascending: false })
    .limit(200);
  if (projErr) return { ok: false, error: projErr.message };
  const projectIds = (projects ?? []).map((p) => p.id as string);
  if (projectIds.length === 0) return { ok: true, projects: [] };

  const { data: categories, error: bErr } = await supabase
    .from('project_budget_categories')
    .select('id, name, project_id, display_order')
    .in('project_id', projectIds)
    .order('display_order', { ascending: true });
  if (bErr) return { ok: false, error: bErr.message };

  const categoriesByProject = new Map<string, Array<{ id: string; name: string }>>();
  for (const b of categories ?? []) {
    const pid = b.project_id as string;
    const arr = categoriesByProject.get(pid) ?? [];
    arr.push({ id: b.id as string, name: b.name as string });
    categoriesByProject.set(pid, arr);
  }

  return {
    ok: true,
    projects: (projects ?? []).map((p) => ({
      id: p.id as string,
      name: p.name as string,
      is_cost_plus: (p.is_cost_plus as boolean | null) !== false, // default-true
      categories: categoriesByProject.get(p.id as string) ?? [],
    })),
  };
}

/**
 * Flat list of expense category picker options (tree flattened with
 * "Parent › Child" labels) for the Log Expense overhead mode.
 */
export async function listExpenseCategoryOptionsAction(): Promise<
  | {
      ok: true;
      options: Array<{ id: string; label: string; isParentHeader: boolean }>;
    }
  | { ok: false; error: string }
> {
  const [{ listExpenseCategories, buildCategoryTree, buildPickerOptions }] = await Promise.all([
    import('@/lib/db/queries/expense-categories'),
  ]);
  try {
    const rows = await listExpenseCategories();
    const tree = buildCategoryTree(rows);
    const options = buildPickerOptions(tree).map((o) => ({
      id: o.id,
      label: o.label,
      isParentHeader: o.isParentHeader,
    }));
    return { ok: true, options };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to load categories.' };
  }
}

export async function logExpenseAction(input: {
  project_id?: string;
  job_id?: string;
  budget_category_id?: string;
  amount_cents: number;
  pre_tax_amount_cents?: number;
  tax_cents?: number;
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
      budget_category_id: parsed.data.budget_category_id || null,
      cost_line_id: parsed.data.cost_line_id || null,
      amount_cents: parsed.data.amount_cents,
      pre_tax_amount_cents: parsed.data.pre_tax_amount_cents ?? null,
      // tax_cents has DEFAULT 0 NOT NULL; only override when OCR gave us a value.
      ...(parsed.data.tax_cents !== undefined ? { tax_cents: parsed.data.tax_cents } : {}),
      vendor: parsed.data.vendor?.trim() || null,
      vendor_gst_number: parsed.data.vendor_gst_number?.trim() || null,
      description: parsed.data.description?.trim() || null,
      receipt_url: parsed.data.receipt_url || null,
      expense_date: parsed.data.expense_date,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to log expense.' };
  }

  await safeMirrorExpense(supabase, data.id);

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
  const rawPreTax = formData.get('pre_tax_amount_cents');
  const rawTaxCents = formData.get('tax_cents');
  const input = {
    project_id: String(formData.get('project_id') ?? ''),
    budget_category_id: String(formData.get('budget_category_id') ?? ''),
    cost_line_id: String(formData.get('cost_line_id') ?? ''),
    amount_cents: Number(formData.get('amount_cents') ?? 0),
    // Only forward the OCR breakdown if the form actually sent it; absent
    // means "no breakdown" which is different from 0.
    pre_tax_amount_cents: rawPreTax != null ? Number(rawPreTax) : undefined,
    tax_cents: rawTaxCents != null ? Number(rawTaxCents) : undefined,
    vendor: String(formData.get('vendor') ?? ''),
    vendor_gst_number: String(formData.get('vendor_gst_number') ?? ''),
    description: String(formData.get('description') ?? ''),
    expense_date: String(formData.get('expense_date') ?? ''),
    payment_source_id: String(formData.get('payment_source_id') ?? ''),
    card_last4: String(formData.get('card_last4') ?? ''),
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

  // Fall back to the tenant default source when the form didn't pick
  // one — matches the overhead path's behavior so the row is never
  // silently un-attributed.
  const { getDefaultPaymentSourceId } = await import('@/lib/db/queries/payment-sources');
  const paymentSourceId =
    parsed.data.payment_source_id?.trim() || (await getDefaultPaymentSourceId());

  const { data, error } = await admin
    .from('expenses')
    .insert({
      tenant_id: tenant.id,
      user_id: user.id,
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

  revalidatePath(`/projects/${parsed.data.project_id}`);
  return { ok: true, id: data.id };
}

const updateExpenseSchema = z.object({
  id: z.string().uuid(),
  // All fields are individually optional — the caller supplies only the ones
  // they want to change. Undefined = leave as-is.
  expense_date: z.string().min(1).optional(),
  amount_cents: z.coerce
    .number()
    .int()
    .refine((n) => n !== 0, { message: 'Amount must not be zero.' })
    .optional(),
  vendor: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  budget_category_id: z.string().uuid().nullable().optional(),
  cost_line_id: z.string().uuid().nullable().optional(),
});

export async function updateExpenseAction(input: {
  id: string;
  expense_date?: string;
  amount_cents?: number;
  vendor?: string | null;
  description?: string | null;
  budget_category_id?: string | null;
  cost_line_id?: string | null;
}): Promise<ExpenseActionResult> {
  const parsed = updateExpenseSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { id, ...rest } = parsed.data;

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  // Build the update object with only the fields that were provided.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (rest.expense_date !== undefined) patch.expense_date = rest.expense_date;
  if (rest.amount_cents !== undefined) patch.amount_cents = rest.amount_cents;
  if (rest.vendor !== undefined) patch.vendor = rest.vendor?.trim() || null;
  if (rest.description !== undefined) patch.description = rest.description?.trim() || null;
  if (rest.budget_category_id !== undefined)
    patch.budget_category_id = rest.budget_category_id || null;
  if (rest.cost_line_id !== undefined) patch.cost_line_id = rest.cost_line_id || null;

  const supabase = await createClient();
  // RLS scopes this to the caller's tenant; no manual tenant_id filter needed
  // but we add one anyway as a belt-and-suspenders guard.
  const { data, error } = await supabase
    .from('expenses')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .select('id, project_id, job_id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to update expense.' };
  }

  await safeMirrorExpense(supabase, data.id);

  if (data.project_id) revalidatePath(`/projects/${data.project_id}`);
  if (data.job_id) revalidatePath(`/jobs/${data.job_id}`);
  return { ok: true, id: data.id };
}

export async function deleteExpenseAction(id: string): Promise<ExpenseActionResult> {
  if (!id) return { ok: false, error: 'Missing expense id.' };

  const supabase = await createClient();
  const { error } = await supabase.from('expenses').delete().eq('id', id);

  if (error) {
    return { ok: false, error: error.message };
  }

  await safeUnmirrorCost(supabase, id);

  return { ok: true, id };
}
