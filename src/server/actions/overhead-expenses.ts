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
import { gateway, isAiError } from '@/lib/ai-gateway';
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
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }
  | {
      ok: false;
      duplicate: {
        existing_id: string;
        vendor: string;
        amount_cents: number;
        expense_date: string;
      };
    };

/**
 * Block the mutation if the tenant has closed books through a date on
 * or after the expense_date. Returns an error result ready to return
 * from the action, or null to proceed. `mutationDate` is the date the
 * operator is trying to touch — for updates we check the OLD date
 * (the one already committed to the books) AND the new date (so you
 * can't backdate a newly-entered expense into a closed period).
 */
async function blockIfBooksClosed(
  admin: ReturnType<typeof createAdminClient>,
  tenantId: string,
  mutationDate: string,
  alsoCheckDate?: string | null,
): Promise<OverheadExpenseResult | null> {
  const { data: t } = await admin
    .from('tenants')
    .select('books_closed_through')
    .eq('id', tenantId)
    .single();
  const closedThrough = (t?.books_closed_through as string | null) ?? null;
  if (!closedThrough) return null;
  const conflicts: string[] = [];
  if (mutationDate <= closedThrough) conflicts.push(mutationDate);
  if (alsoCheckDate && alsoCheckDate !== mutationDate && alsoCheckDate <= closedThrough) {
    conflicts.push(alsoCheckDate);
  }
  if (conflicts.length === 0) return null;
  return {
    ok: false,
    error: `Books are closed through ${closedThrough}. This date (${conflicts[0]}) is locked — unlock books in the bookkeeper settings to edit.`,
  };
}

/**
 * Look for a probable duplicate overhead expense. Matches on tenant +
 * vendor (case-insensitive, trimmed) + exact amount_cents + expense_date
 * within ±3 days. Returns the oldest existing match or null.
 *
 * Vendor is required for the check — without it, the match would be too
 * fuzzy (two unrelated $87.42 expenses on the same day are plausible).
 * Operators who routinely skip the vendor field aren't targeted by this
 * guard, but that's probably the right tradeoff.
 */
async function findProbableDuplicate(
  admin: ReturnType<typeof createAdminClient>,
  tenantId: string,
  opts: { vendor: string | null; amountCents: number; expenseDate: string; excludeId?: string },
): Promise<{ id: string; vendor: string; amount_cents: number; expense_date: string } | null> {
  const vendor = opts.vendor?.trim();
  if (!vendor) return null;

  const date = new Date(opts.expenseDate);
  const lo = new Date(date.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const hi = new Date(date.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let query = admin
    .from('expenses')
    .select('id, vendor, amount_cents, expense_date')
    .eq('tenant_id', tenantId)
    .is('project_id', null)
    .eq('amount_cents', opts.amountCents)
    .gte('expense_date', lo)
    .lte('expense_date', hi)
    // Case-insensitive vendor match. ilike exact-match (no wildcards).
    .ilike('vendor', vendor);
  if (opts.excludeId) query = query.neq('id', opts.excludeId);

  const { data } = await query.order('created_at', { ascending: true }).limit(1);
  const row = data?.[0];
  if (!row) return null;
  return {
    id: row.id as string,
    vendor: (row.vendor as string) ?? vendor,
    amount_cents: row.amount_cents as number,
    expense_date: row.expense_date as string,
  };
}

const overheadSchema = z.object({
  category_id: z.string().uuid('Pick a category.'),
  amount_cents: z.coerce
    .number()
    .int()
    .refine((n) => n !== 0, 'Amount must not be zero.'),
  tax_cents: z.coerce.number().int().min(0).default(0),
  vendor: z.string().trim().max(200).optional().or(z.literal('')),
  vendor_gst_number: z.string().trim().max(40).optional().or(z.literal('')),
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
    vendor_gst_number: formData.get('vendor_gst_number') ?? '',
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

  // Books-closed guard runs first — no other validation matters if the
  // operator isn't allowed to touch this period.
  const closedBlock = await blockIfBooksClosed(admin, tenant.id, parsed.data.expense_date);
  if (closedBlock) return closedBlock;

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

  // Probable duplicate check. `force=1` on FormData = user already saw
  // the warning and said "save anyway".
  const force = formData.get('force') === '1';
  if (!force) {
    const dup = await findProbableDuplicate(admin, tenant.id, {
      vendor: parsed.data.vendor || null,
      amountCents: parsed.data.amount_cents,
      expenseDate: parsed.data.expense_date,
    });
    if (dup) {
      return {
        ok: false,
        duplicate: {
          existing_id: dup.id,
          vendor: dup.vendor,
          amount_cents: dup.amount_cents,
          expense_date: dup.expense_date,
        },
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
      budget_category_id: null,
      job_id: null,
      category_id: parsed.data.category_id,
      amount_cents: parsed.data.amount_cents,
      tax_cents: parsed.data.tax_cents,
      vendor: parsed.data.vendor?.trim() || null,
      vendor_gst_number: parsed.data.vendor_gst_number?.trim() || null,
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
        /** Vendor GST/HST business number extracted from the receipt if visible. */
        vendorGstNumber: string | null;
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

  // Pull tenant rate context to give the model a sanity-check hint and
  // to compute tax ourselves if the model returns null for it.
  const { canadianTax } = await import('@/lib/providers/tax/canadian');
  const taxCtx = await canadianTax.getContext(tenant.id).catch(() => null);
  const rateHint = taxCtx
    ? `Tenant province: ${taxCtx.provinceCode ?? 'unset'}. Expected tax: ${taxCtx.summaryLabel} (combined ${(taxCtx.totalRate * 100).toFixed(3)}%).`
    : 'Tax rates unknown.';

  // Vendor intelligence: feed the model the top N vendor → category
  // mappings we've seen for this tenant. Ambiguous receipts land in
  // the right category instead of the AI's default guess.
  const { getTopVendorHints } = await import('@/lib/db/queries/vendor-intelligence');
  const vendorHints = await getTopVendorHints(tenant.id, 12).catch(() => []);
  const vendorHintBlock =
    vendorHints.length > 0
      ? `\n\nVendor history (use as a tiebreaker when the receipt matches one of these vendors):\n${vendorHints
          .map(
            (h) =>
              `- ${h.vendor} → ${h.category_id} (${h.category_label}) — ${h.hits} past entries`,
          )
          .join('\n')}`
      : '';

  const SYSTEM_PROMPT = `You extract structured fields from receipts for a Canadian contractor. Return ONLY JSON matching the schema. Use null when you cannot read with confidence.

Field rules:
- expense_date: YYYY-MM-DD. The transaction date, not the print time.
- amount_cents: INTEGER cents. The receipt grand total (what was charged), tax included.
- tax_cents: INTEGER cents. The GST/HST portion of the total. READ CAREFULLY — Canadian receipts show this many ways:
    * "GST 5% $1.23" or "HST 13% $4.56" — take the dollar amount.
    * "GST included $1.23" / "GST INCL $1.23" / "GST incl." — take the dollar amount even though the word "included" is present.
    * "GST/HST $2.34" — take the dollar amount.
    * If only a rate is shown without a dollar figure (e.g. "GST 5% included in price"), compute: tax_cents = round(total - total / (1 + rate)). Use the tenant's expected rate above.
    * If a separate PST/QST line exists, DO NOT include it in tax_cents — we track GST/HST separately for Input Tax Credits. (PST is not recoverable.)
    * If no tax line is shown at all, return null (not 0). Null tells the app to leave it blank; 0 means "definitely no tax".
- Sanity check: tax_cents should be roughly 4-15% of amount_cents for a valid Canadian receipt. If the number you compute is way outside that range, return null.
- vendor: merchant name as printed at the top.
- description: one-line summary of what was bought ("regular gas", "2x4s and drywall screws", "coffee").
- vendor_gst_number: the vendor's GST/HST business number (BN) if printed on the receipt. Canadian format is 9 digits + "RT" + 4 digits. If only the 9-digit root is shown, return those 9 digits. Return null if not visible.
- suggested_category_id: pick a selectable (non-parent) id from the list, or null if nothing fits well.`;

  const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      amount_cents: { type: ['integer', 'null'] },
      tax_cents: { type: ['integer', 'null'] },
      vendor: { type: ['string', 'null'] },
      vendor_gst_number: { type: ['string', 'null'] },
      expense_date: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      suggested_category_id: { type: ['string', 'null'] },
    },
    required: [
      'amount_cents',
      'tax_cents',
      'vendor',
      'vendor_gst_number',
      'expense_date',
      'description',
      'suggested_category_id',
    ],
  };

  type ParsedOverheadReceipt = {
    amount_cents: number | null;
    tax_cents: number | null;
    vendor: string | null;
    vendor_gst_number: string | null;
    expense_date: string | null;
    description: string | null;
    suggested_category_id: string | null;
  };

  let parsed: ParsedOverheadReceipt;
  try {
    const userPrompt = `Extract the fields from this Canadian contractor receipt.\n\n${rateHint}\n\nAvailable categories (pick the most appropriate id, or null if nothing fits):\n${catLines}${vendorHintBlock}`;
    const res = await gateway().runStructured<ParsedOverheadReceipt>({
      kind: 'structured',
      task: 'overhead_expense_extract',
      tenant_id: tenant.id,
      model_override: EXTRACT_MODEL,
      prompt: `${SYSTEM_PROMPT}\n\n${userPrompt}`,
      schema: SCHEMA,
      file: { mime, base64: b64, filename: file.name || undefined },
    });
    parsed = res.data;
  } catch (err) {
    if (isAiError(err)) {
      if (err.kind === 'quota')
        return { ok: false, error: 'Receipt scanning temporarily unavailable across providers.' };
      if (err.kind === 'overload' || err.kind === 'rate_limit')
        return { ok: false, error: 'Receipt scanning is busy right now. Try again in a moment.' };
    }
    return { ok: false, error: 'Could not read the receipt. Try again.' };
  }

  // Validate the suggested id is real and selectable.
  const picked =
    parsed.suggested_category_id &&
    catOptions.find((c) => c.id === parsed.suggested_category_id && c.selectable)
      ? parsed.suggested_category_id
      : null;

  // Safety-net tax computation: if the model returned null tax but we
  // have a total and a known tenant rate, compute it from the rate.
  // This handles fuel/food receipts where GST is shown as "GST incl."
  // without a dollar amount — the model sometimes gives up on those.
  // Flagged downstream as an estimate, not a read value.
  let taxCents = parsed.tax_cents;
  if (
    (taxCents === null || taxCents === 0) &&
    parsed.amount_cents != null &&
    parsed.amount_cents > 0 &&
    taxCtx &&
    taxCtx.gstRate > 0
  ) {
    // Only use the GST component (not PST/QST) — matches our tax_cents
    // semantics everywhere else in the app.
    const gstOnly = taxCtx.gstRate;
    const computed = Math.round(parsed.amount_cents - parsed.amount_cents / (1 + gstOnly));
    // Sanity bound: 2%-20% of total.
    if (computed > 0 && computed < parsed.amount_cents * 0.2) {
      taxCents = computed;
    }
  }

  return {
    ok: true,
    fields: {
      amountCents: parsed.amount_cents,
      taxCents,
      vendor: parsed.vendor?.trim() || null,
      vendorGstNumber: parsed.vendor_gst_number?.trim() || null,
      expenseDate: parsed.expense_date,
      description: parsed.description?.trim() || null,
      suggestedCategoryId: picked,
    },
  };
}

/**
 * Edit an existing overhead expense. Same FormData shape as the log
 * action, plus an `id`. The receipt is optional — if the user attached
 * a new file we replace the existing one; otherwise the existing path
 * stays. If the user explicitly cleared the attachment (sends
 * `remove_receipt=1`) we delete the storage object too.
 */
export async function updateOverheadExpenseAction(
  formData: FormData,
): Promise<OverheadExpenseResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const id = formData.get('id');
  if (typeof id !== 'string' || !id) return { ok: false, error: 'Missing expense id.' };

  const parsed = overheadSchema.safeParse({
    category_id: formData.get('category_id'),
    amount_cents: formData.get('amount_cents'),
    tax_cents: formData.get('tax_cents') ?? 0,
    vendor: formData.get('vendor') ?? '',
    vendor_gst_number: formData.get('vendor_gst_number') ?? '',
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

  // Confirm the expense belongs to this tenant and is an overhead row
  // (we don't want to let someone edit a project expense through this
  // action — that has its own update path and preserves project context).
  const { data: existing, error: existingErr } = await admin
    .from('expenses')
    .select('id, tenant_id, project_id, receipt_storage_path, expense_date')
    .eq('id', id)
    .single();
  if (existingErr || !existing) return { ok: false, error: 'Expense not found.' };
  if (existing.tenant_id !== tenant.id) return { ok: false, error: 'Not found.' };
  if (existing.project_id !== null) {
    return { ok: false, error: 'This is a project expense — edit it from the project page.' };
  }

  // Books-closed guard: both the old date and the new date must be out
  // of the locked period. Otherwise the operator can backdate a current
  // expense into a closed quarter, or modify an already-filed expense.
  const closedBlock = await blockIfBooksClosed(
    admin,
    tenant.id,
    parsed.data.expense_date,
    existing.expense_date as string,
  );
  if (closedBlock) return closedBlock;

  // Guard: block logging to a parent with children (same rule as create).
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

  // Probable duplicate check (same rule as create), excluding the row
  // we're editing. Skip when force=1.
  const force = formData.get('force') === '1';
  if (!force) {
    const dup = await findProbableDuplicate(admin, tenant.id, {
      vendor: parsed.data.vendor || null,
      amountCents: parsed.data.amount_cents,
      expenseDate: parsed.data.expense_date,
      excludeId: id,
    });
    if (dup) {
      return {
        ok: false,
        duplicate: {
          existing_id: dup.id,
          vendor: dup.vendor,
          amount_cents: dup.amount_cents,
          expense_date: dup.expense_date,
        },
      };
    }
  }

  // Receipt handling: three cases.
  //   1. New file uploaded → replace (upload new, delete old).
  //   2. remove_receipt=1 → delete existing, store null.
  //   3. Otherwise → leave existing path alone.
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };

  let receiptStoragePath: string | null | undefined; // undefined = don't touch
  const newReceipt = formData.get('receipt');
  const removeReceipt = formData.get('remove_receipt') === '1';

  if (newReceipt instanceof File && newReceipt.size > 0) {
    if (newReceipt.size > MAX_BYTES) return { ok: false, error: 'Receipt is larger than 10MB.' };
    const ext = extFromContentType(newReceipt.type);
    const path = `${tenant.id}/${user.id}/${randomUUID()}.${ext}`;
    const { error } = await admin.storage.from(RECEIPTS_BUCKET).upload(path, newReceipt, {
      contentType: newReceipt.type || 'image/jpeg',
      upsert: false,
    });
    if (error) return { ok: false, error: `Receipt upload failed: ${error.message}` };
    receiptStoragePath = path;
  } else if (removeReceipt) {
    receiptStoragePath = null;
  }

  const patch: Record<string, unknown> = {
    category_id: parsed.data.category_id,
    amount_cents: parsed.data.amount_cents,
    tax_cents: parsed.data.tax_cents,
    vendor: parsed.data.vendor?.trim() || null,
    description: parsed.data.description?.trim() || null,
    expense_date: parsed.data.expense_date,
    updated_at: new Date().toISOString(),
  };
  if (receiptStoragePath !== undefined) {
    patch.receipt_storage_path = receiptStoragePath;
  }

  const { error: updErr } = await admin.from('expenses').update(patch).eq('id', id);
  if (updErr) return { ok: false, error: updErr.message };

  // Clean up the old receipt file if we replaced or removed it. Best-
  // effort — if the delete fails we still return success; orphaned files
  // can be swept later.
  if (receiptStoragePath !== undefined && existing.receipt_storage_path) {
    if (receiptStoragePath !== existing.receipt_storage_path) {
      await admin.storage
        .from(RECEIPTS_BUCKET)
        .remove([existing.receipt_storage_path as string])
        .catch(() => {});
    }
  }

  revalidatePath('/expenses');
  return { ok: true, id };
}

/**
 * Bulk recategorize a set of overhead expenses. Any id that doesn't
 * belong to the caller's tenant or is inside a books-closed period
 * is silently skipped — returns the actual updated count.
 */
export async function bulkRecategorizeExpensesAction(input: {
  ids: string[];
  category_id: string;
}): Promise<{ ok: true; updated: number } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  if (!Array.isArray(input.ids) || input.ids.length === 0) {
    return { ok: false, error: 'Nothing selected.' };
  }
  if (typeof input.category_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.category_id)) {
    return { ok: false, error: 'Invalid category.' };
  }

  const admin = createAdminClient();

  // Validate the target category belongs to the tenant and isn't a
  // parent with children (same rule as single-row updates).
  const { data: cat } = await admin
    .from('expense_categories')
    .select('id, parent_id')
    .eq('id', input.category_id)
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
        error: 'That category has sub-accounts. Pick a sub-account instead.',
      };
    }
  }

  const { data: rows } = await admin
    .from('expenses')
    .select('id, expense_date')
    .in('id', input.ids)
    .eq('tenant_id', tenant.id);

  const { data: t } = await admin
    .from('tenants')
    .select('books_closed_through')
    .eq('id', tenant.id)
    .single();
  const closedThrough = (t?.books_closed_through as string | null) ?? null;

  const allowedIds = (rows ?? [])
    .filter((r) => !closedThrough || (r.expense_date as string) > closedThrough)
    .map((r) => r.id as string);

  if (allowedIds.length === 0) {
    return {
      ok: false,
      error: closedThrough
        ? `All selected rows are in a locked period (books closed through ${closedThrough}).`
        : 'No eligible rows found.',
    };
  }

  const { error } = await admin
    .from('expenses')
    .update({ category_id: input.category_id, updated_at: new Date().toISOString() })
    .in('id', allowedIds);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/expenses');
  revalidatePath('/bk/expenses');
  return { ok: true, updated: allowedIds.length };
}

/**
 * Bulk delete overhead expenses. Project-linked expenses are silently
 * excluded (they have their own edit flow). Books-closed rows skip too.
 * Receipt files are removed best-effort.
 */
export async function bulkDeleteExpensesAction(input: {
  ids: string[];
}): Promise<{ ok: true; deleted: number } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  if (!Array.isArray(input.ids) || input.ids.length === 0) {
    return { ok: false, error: 'Nothing selected.' };
  }

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from('expenses')
    .select('id, project_id, expense_date, receipt_storage_path')
    .in('id', input.ids)
    .eq('tenant_id', tenant.id);

  const { data: t } = await admin
    .from('tenants')
    .select('books_closed_through')
    .eq('id', tenant.id)
    .single();
  const closedThrough = (t?.books_closed_through as string | null) ?? null;

  const eligible = (rows ?? []).filter((r) => {
    if (r.project_id) return false;
    if (closedThrough && (r.expense_date as string) <= closedThrough) return false;
    return true;
  });

  if (eligible.length === 0) {
    return { ok: false, error: 'No eligible rows (project rows + locked periods skip).' };
  }

  const idsToDelete = eligible.map((r) => r.id as string);
  const receiptPaths = eligible
    .map((r) => r.receipt_storage_path as string | null)
    .filter((p): p is string => !!p);

  const { error } = await admin.from('expenses').delete().in('id', idsToDelete);
  if (error) return { ok: false, error: error.message };

  if (receiptPaths.length > 0) {
    await admin.storage
      .from(RECEIPTS_BUCKET)
      .remove(receiptPaths)
      .catch(() => {});
  }

  revalidatePath('/expenses');
  revalidatePath('/bk/expenses');
  return { ok: true, deleted: idsToDelete.length };
}

export async function deleteOverheadExpenseAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const admin = createAdminClient();
  // Fetch receipt path + date so we can clean storage and enforce books-close.
  const { data } = await admin
    .from('expenses')
    .select('receipt_storage_path, tenant_id, expense_date')
    .eq('id', id)
    .single();
  if (!data || data.tenant_id !== tenant.id) return { ok: false, error: 'Not found.' };

  const closedBlock = await blockIfBooksClosed(admin, tenant.id, data.expense_date as string);
  if (closedBlock) {
    const msg = 'error' in closedBlock ? closedBlock.error : 'Books are closed for this period.';
    return { ok: false, error: msg };
  }

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
