'use server';

/**
 * Overhead expense actions — operating expenses not tied to a project.
 *
 * Design:
 *   - Uses the same `expenses` table as project expenses, with
 *     `project_id = null` and a required `category_id` pointing at a
 *     row in `expense_categories`.
 *   - Receipt uploads go to the existing `receipts` bucket so we don't
 *     have to add another RLS policy.
 *   - OCR uses the same gpt-4o-mini receipt-extraction pattern as the
 *     worker expense form (see extract-receipt.ts), extended with a
 *     tax field and a suggested-category pass.
 *
 * Kept separate from server/actions/expenses.ts because the project
 * path has ~a dozen callers and I don't want to perturb it.
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

const RECEIPTS_BUCKET = 'receipts';
const MAX_BYTES = 10 * 1024 * 1024;
const EXTRACT_MODEL = 'gpt-4o-mini';

function extFromContentType(ct: string): string {
  if (ct === 'image/png') return 'png';
  if (ct === 'image/webp') return 'webp';
  if (ct === 'image/heic' || ct === 'image/heif') return 'heic';
  if (ct === 'application/pdf') return 'pdf';
  return 'jpg';
}

export type OverheadExpenseResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

const overheadSchema = z.object({
  category_id: z.string().uuid('Pick a category.'),
  amount_cents: z.coerce
    .number()
    .int()
    .refine((n) => n !== 0, 'Amount must not be zero.'),
  tax_cents: z.coerce.number().int().min(0).default(0),
  vendor: z.string().trim().max(200).optional().or(z.literal('')),
  description: z.string().trim().max(2000).optional().or(z.literal('')),
  expense_date: z.string().min(1, 'Date is required.'),
});

/**
 * Create a new overhead expense. FormData-based so the same form can
 * upload a receipt in the same request.
 */
export async function logOverheadExpenseAction(formData: FormData): Promise<OverheadExpenseResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };

  const parsed = overheadSchema.safeParse({
    category_id: formData.get('category_id'),
    amount_cents: formData.get('amount_cents'),
    tax_cents: formData.get('tax_cents') ?? 0,
    vendor: formData.get('vendor') ?? '',
    description: formData.get('description') ?? '',
    expense_date: formData.get('expense_date'),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const admin = createAdminClient();

  // Guard: block logging to a parent category that has (un-archived) children.
  const { data: cat } = await admin
    .from('expense_categories')
    .select('id, parent_id')
    .eq('id', parsed.data.category_id)
    .eq('tenant_id', tenant.id)
    .single();
  if (!cat) return { ok: false, error: 'Category not found.' };
  if (cat.parent_id === null) {
    const { count } = await admin
      .from('expense_categories')
      .select('id', { count: 'exact', head: true })
      .eq('parent_id', cat.id)
      .is('archived_at', null);
    if ((count ?? 0) > 0) {
      return {
        ok: false,
        error: 'This category has sub-accounts. Pick one of the sub-accounts instead.',
      };
    }
  }

  // Upload receipt if provided.
  let receiptStoragePath: string | null = null;
  const receipt = formData.get('receipt');
  if (receipt instanceof File && receipt.size > 0) {
    if (receipt.size > MAX_BYTES) return { ok: false, error: 'Receipt is larger than 10MB.' };
    const ext = extFromContentType(receipt.type);
    const path = `${tenant.id}/${user.id}/${randomUUID()}.${ext}`;
    const { error } = await admin.storage
      .from(RECEIPTS_BUCKET)
      .upload(path, receipt, { contentType: receipt.type || 'image/jpeg', upsert: false });
    if (error) return { ok: false, error: `Receipt upload failed: ${error.message}` };
    receiptStoragePath = path;
  }

  const { data, error } = await admin
    .from('expenses')
    .insert({
      tenant_id: tenant.id,
      user_id: user.id,
      project_id: null,
      bucket_id: null,
      job_id: null,
      category_id: parsed.data.category_id,
      amount_cents: parsed.data.amount_cents,
      tax_cents: parsed.data.tax_cents,
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

  revalidatePath('/expenses');
  return { ok: true, id: data.id as string };
}

// ============================================================================
// Receipt OCR — extract fields + suggest a category
// ============================================================================

export type OverheadReceiptExtraction =
  | {
      ok: true;
      fields: {
        amountCents: number | null;
        taxCents: number | null;
        vendor: string | null;
        expenseDate: string | null;
        description: string | null;
        suggestedCategoryId: string | null;
      };
    }
  | { ok: false; error: string };

/**
 * Parse a receipt image/PDF. Takes the tenant's active categories so the
 * model can suggest one. Never overwrites fields the user already filled
 * — that's the caller's responsibility (the form merges only empty ones).
 */
export async function extractOverheadReceiptAction(
  formData: FormData,
): Promise<OverheadReceiptExtraction> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'Server missing OPENAI_API_KEY.' };

  const file = formData.get('receipt');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No receipt uploaded.' };
  }
  if (file.size > MAX_BYTES) return { ok: false, error: 'Receipt is larger than 10MB.' };

  const mime = file.type || 'image/jpeg';
  const isPdf = mime === 'application/pdf';
  const isImage = mime.startsWith('image/');
  if (!isPdf && !isImage) return { ok: false, error: `Unsupported file type: ${mime}` };

  // Pull the caller's categories so the model can pick one. Flatten parent
  // › child labels so matching "Vehicles › Truck 1" works.
  const admin = createAdminClient();
  const { data: rows } = await admin
    .from('expense_categories')
    .select('id, parent_id, name')
    .eq('tenant_id', tenant.id)
    .is('archived_at', null);

  const byId = new Map<string, { id: string; parent_id: string | null; name: string }>();
  for (const r of rows ?? []) byId.set(r.id as string, r as never);
  const catOptions: { id: string; label: string; selectable: boolean }[] = [];
  for (const r of rows ?? []) {
    const row = r as { id: string; parent_id: string | null; name: string };
    const hasChildren = (rows ?? []).some(
      (x) => (x as { parent_id: string | null }).parent_id === row.id,
    );
    // Non-selectable parents with children still go in the list with a
    // flag so the model doesn't pick them.
    const label = row.parent_id
      ? `${byId.get(row.parent_id)?.name ?? '?'} › ${row.name}`
      : row.name;
    catOptions.push({
      id: row.id,
      label,
      selectable: !hasChildren,
    });
  }

  const catLines = catOptions
    .map((c) => `${c.id} — ${c.label}${c.selectable ? '' : ' (parent — do not pick)'}`)
    .join('\n');

  const buf = Buffer.from(await file.arrayBuffer());
  const b64 = buf.toString('base64');

  const userContent: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: `Extract the fields from this receipt.\n\nAvailable categories (pick the most appropriate id, or null if nothing fits):\n${catLines}`,
    },
  ];
  if (isPdf) {
    userContent.push({
      type: 'file',
      file: {
        filename: file.name || 'receipt.pdf',
        file_data: `data:application/pdf;base64,${b64}`,
      },
    });
  } else {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${b64}` },
    });
  }

  const body = {
    model: EXTRACT_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You extract structured fields from receipts for a Canadian contractor. Return ONLY JSON matching the schema. Use null when unsure. Dates: YYYY-MM-DD. Amounts: total in cents (integer). Tax: the GST/HST/PST portion in cents (0 if not shown). Vendor: merchant name as printed. Description: one-line summary of what was bought. Suggest a category id from the list — only pick selectable (non-parent) ids, or null.',
      },
      { role: 'user', content: userContent },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'overhead_receipt',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            amount_cents: { type: ['integer', 'null'] },
            tax_cents: { type: ['integer', 'null'] },
            vendor: { type: ['string', 'null'] },
            expense_date: { type: ['string', 'null'] },
            description: { type: ['string', 'null'] },
            suggested_category_id: { type: ['string', 'null'] },
          },
          required: [
            'amount_cents',
            'tax_cents',
            'vendor',
            'expense_date',
            'description',
            'suggested_category_id',
          ],
        },
      },
    },
  };

  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { ok: false, error: `OpenAI ${res.status}: ${txt || res.statusText}` };
  }

  const payload = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) return { ok: false, error: 'OpenAI returned no content.' };

  let parsed: {
    amount_cents: number | null;
    tax_cents: number | null;
    vendor: string | null;
    expense_date: string | null;
    description: string | null;
    suggested_category_id: string | null;
  };
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: 'OpenAI returned non-JSON.' };
  }

  // Validate the suggested id is real and selectable.
  const picked =
    parsed.suggested_category_id &&
    catOptions.find((c) => c.id === parsed.suggested_category_id && c.selectable)
      ? parsed.suggested_category_id
      : null;

  return {
    ok: true,
    fields: {
      amountCents: parsed.amount_cents,
      taxCents: parsed.tax_cents,
      vendor: parsed.vendor?.trim() || null,
      expenseDate: parsed.expense_date,
      description: parsed.description?.trim() || null,
      suggestedCategoryId: picked,
    },
  };
}

export async function deleteOverheadExpenseAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const admin = createAdminClient();
  // Fetch receipt path so we can clean storage on delete.
  const { data } = await admin
    .from('expenses')
    .select('receipt_storage_path, tenant_id')
    .eq('id', id)
    .single();
  if (!data || data.tenant_id !== tenant.id) return { ok: false, error: 'Not found.' };

  const { error } = await admin.from('expenses').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };

  if (data.receipt_storage_path) {
    await admin.storage
      .from(RECEIPTS_BUCKET)
      .remove([data.receipt_storage_path as string])
      .catch(() => {});
  }
  revalidatePath('/expenses');
  return { ok: true };
}
