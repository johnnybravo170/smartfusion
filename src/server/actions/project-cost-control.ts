'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import sharp from 'sharp';
import { z } from 'zod';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { uploadToStorage } from '@/lib/storage/photos';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const MAX_COST_LINE_PHOTO_BYTES = 10 * 1024 * 1024;

export type CostControlResult = { ok: true; id: string } | { ok: false; error: string };

// ─── Cost lines ───────────────────────────────────────────────────────────────

const costLineSchema = z.object({
  id: z.string().uuid().optional(),
  project_id: z.string().uuid(),
  budget_category_id: z.string().uuid().optional().or(z.literal('')),
  catalog_item_id: z.string().uuid().optional().or(z.literal('')),
  category: z.enum(['material', 'labour', 'sub', 'equipment', 'overhead']),
  label: z.string().trim().min(1, 'Label is required').max(300),
  qty: z.coerce.number().positive('Quantity must be positive'),
  unit: z.string().trim().min(1).max(50),
  unit_cost_cents: z.coerce.number().int().min(0),
  unit_price_cents: z.coerce.number().int().min(0),
  markup_pct: z.coerce.number().min(0).max(1000),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
  sort_order: z.coerce.number().int().optional().default(0),
});

function computeLineTotals(qty: number, unit_cost_cents: number, unit_price_cents: number) {
  return {
    line_cost_cents: Math.round(qty * unit_cost_cents),
    line_price_cents: Math.round(qty * unit_price_cents),
  };
}

export async function upsertCostLineAction(input: unknown): Promise<CostControlResult> {
  const parsed = costLineSchema.safeParse(input);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? 'Invalid input.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { id, budget_category_id, catalog_item_id, notes, ...fields } = parsed.data;
  const totals = computeLineTotals(fields.qty, fields.unit_cost_cents, fields.unit_price_cents);

  const row = {
    ...fields,
    ...totals,
    budget_category_id: budget_category_id || null,
    catalog_item_id: catalog_item_id || null,
    notes: notes || null,
    updated_at: new Date().toISOString(),
  };

  if (id) {
    const { error } = await supabase.from('project_cost_lines').update(row).eq('id', id);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/projects/${fields.project_id}`);
    return { ok: true, id };
  }

  const { data, error } = await supabase
    .from('project_cost_lines')
    .insert(row)
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to add line.' };
  revalidatePath(`/projects/${fields.project_id}`);
  return { ok: true, id: data.id as string };
}

export async function generateEstimateFromCategoriesAction(input: {
  project_id: string;
}): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  const { data: categories, error: bErr } = await supabase
    .from('project_budget_categories')
    .select('id, name, description, estimate_cents')
    .eq('project_id', input.project_id)
    .gt('estimate_cents', 0);
  if (bErr) return { ok: false, error: bErr.message };
  if (!categories || categories.length === 0) {
    return { ok: false, error: 'No categories have an estimate to generate from.' };
  }

  const { data: existingLines, error: lErr } = await supabase
    .from('project_cost_lines')
    .select('budget_category_id')
    .eq('project_id', input.project_id)
    .not('budget_category_id', 'is', null);
  if (lErr) return { ok: false, error: lErr.message };

  const usedCategoryIds = new Set(
    (existingLines ?? []).map((r) => (r as { budget_category_id: string }).budget_category_id),
  );
  const toSeed = categories.filter((b) => !usedCategoryIds.has((b as { id: string }).id)) as {
    id: string;
    name: string;
    description: string | null;
    estimate_cents: number;
  }[];

  if (toSeed.length === 0) {
    return { ok: false, error: 'All categories with estimates already have line items.' };
  }

  const rows = toSeed.map((b) => ({
    project_id: input.project_id,
    budget_category_id: b.id,
    category: 'material' as const,
    label: b.name,
    notes: b.description?.trim() || null,
    qty: 1,
    unit: 'lot',
    unit_cost_cents: b.estimate_cents,
    unit_price_cents: b.estimate_cents,
    line_cost_cents: b.estimate_cents,
    line_price_cents: b.estimate_cents,
    markup_pct: 0,
  }));

  const { error: insErr } = await supabase.from('project_cost_lines').insert(rows);
  if (insErr) return { ok: false, error: insErr.message };

  revalidatePath(`/projects/${input.project_id}`);
  return { ok: true, count: rows.length };
}

export async function deleteCostLineAction(
  id: string,
  projectId: string,
): Promise<CostControlResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();
  const { error } = await supabase.from('project_cost_lines').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id };
}

// ─── Purchase orders ──────────────────────────────────────────────────────────

const poSchema = z.object({
  project_id: z.string().uuid(),
  vendor: z.string().trim().min(1, 'Vendor is required').max(200),
  po_number: z.string().trim().max(100).optional().or(z.literal('')),
  issued_date: z.string().optional().or(z.literal('')),
  expected_date: z.string().optional().or(z.literal('')),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
  items: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(300),
        qty: z.coerce.number().positive(),
        unit: z.string().trim().min(1).max(50),
        unit_cost_cents: z.coerce.number().int().min(0),
        cost_line_id: z.string().uuid().optional().or(z.literal('')),
      }),
    )
    .min(1, 'At least one item is required'),
});

export async function createPurchaseOrderAction(input: unknown): Promise<CostControlResult> {
  const parsed = poSchema.safeParse(input);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? 'Invalid input.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { items, po_number, issued_date, expected_date, notes, ...poFields } = parsed.data;

  const itemRows = items.map((item) => ({
    ...item,
    line_total_cents: Math.round(item.qty * item.unit_cost_cents),
    cost_line_id: item.cost_line_id || null,
  }));
  const total_cents = itemRows.reduce((s, i) => s + i.line_total_cents, 0);

  const { data: po, error: poErr } = await supabase
    .from('purchase_orders')
    .insert({
      ...poFields,
      tenant_id: tenant.id,
      po_number: po_number || null,
      issued_date: issued_date || null,
      expected_date: expected_date || null,
      notes: notes || null,
      total_cents,
    })
    .select('id')
    .single();

  if (poErr || !po) return { ok: false, error: poErr?.message ?? 'Failed to create PO.' };

  const poItemRows = itemRows.map((item) => ({ ...item, po_id: po.id as string }));
  const { error: itemErr } = await supabase.from('purchase_order_items').insert(poItemRows);
  if (itemErr) return { ok: false, error: `PO created but items failed: ${itemErr.message}` };

  revalidatePath(`/projects/${poFields.project_id}`);
  return { ok: true, id: po.id as string };
}

export async function updatePurchaseOrderStatusAction(
  id: string,
  status: 'draft' | 'sent' | 'acknowledged' | 'received' | 'closed',
  projectId: string,
): Promise<CostControlResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();
  const { error } = await supabase
    .from('purchase_orders')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id };
}

// ─── Project bills ────────────────────────────────────────────────────────────

const BILL_ATTACHMENT_BUCKET = 'receipts';
const MAX_BILL_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Upsert a project bill.
 * Accepts FormData so it can optionally carry an attachment file.
 *
 * FormData fields:
 *   id?                      — existing bill UUID (for edits)
 *   project_id               — required
 *   vendor                   — required
 *   bill_date                — required YYYY-MM-DD
 *   description?
 *   amount_cents             — pre-GST subtotal, integer cents
 *   gst_cents                — GST amount, integer cents (0 if no GST)
 *   budget_category_id?               — budget category UUID
 *   cost_code?
 *   attachment?              — File (PDF or image)
 */
export async function upsertBillWithAttachmentAction(
  formData: FormData,
): Promise<CostControlResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const id = (formData.get('id') as string | null) || undefined;
  const project_id = String(formData.get('project_id') ?? '');
  const vendor = String(formData.get('vendor') ?? '').trim();
  const bill_date = String(formData.get('bill_date') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || null;
  const amount_cents = Math.round(parseFloat(String(formData.get('amount_cents') || '0')) || 0);
  const gst_cents = Math.round(parseFloat(String(formData.get('gst_cents') || '0')) || 0);
  const budget_category_id = (formData.get('budget_category_id') as string | null)?.trim() || null;
  const cost_line_id = (formData.get('cost_line_id') as string | null)?.trim() || null;
  const cost_code = (formData.get('cost_code') as string | null)?.trim() || null;
  const vendor_gst_number = (formData.get('vendor_gst_number') as string | null)?.trim() || null;
  const attachmentFile = formData.get('attachment');

  if (!project_id) return { ok: false, error: 'Missing project_id.' };
  if (!vendor) return { ok: false, error: 'Vendor is required.' };
  if (!bill_date) return { ok: false, error: 'Date is required.' };
  if (amount_cents <= 0) return { ok: false, error: 'Amount must be greater than 0.' };

  // Upload attachment if provided.
  let attachment_storage_path: string | null = null;
  if (attachmentFile instanceof File && attachmentFile.size > 0) {
    if (attachmentFile.size > MAX_BILL_ATTACHMENT_BYTES) {
      return { ok: false, error: 'Attachment is larger than 20MB.' };
    }
    const isImage = attachmentFile.type.startsWith('image/');
    const isPdf = attachmentFile.type === 'application/pdf';
    if (!isImage && !isPdf) {
      return { ok: false, error: 'Attachment must be an image or PDF.' };
    }
    const user = await getCurrentUser();
    if (!user) return { ok: false, error: 'Not signed in.' };
    const ext = isPdf ? 'pdf' : attachmentFile.type === 'image/png' ? 'png' : 'jpg';
    const path = `${tenant.id}/${user.id}/${randomUUID()}.${ext}`;
    const admin = createAdminClient();
    const { error: upErr } = await admin.storage
      .from(BILL_ATTACHMENT_BUCKET)
      .upload(path, attachmentFile, {
        contentType: attachmentFile.type || 'application/octet-stream',
        upsert: false,
      });
    if (upErr) return { ok: false, error: `Upload failed: ${upErr.message}` };
    attachment_storage_path = path;
  }

  const supabase = await createClient();
  const row: Record<string, unknown> = {
    project_id,
    vendor,
    bill_date,
    description,
    amount_cents,
    gst_cents,
    budget_category_id: budget_category_id || null,
    cost_line_id: cost_line_id || null,
    cost_code,
    vendor_gst_number,
    status: 'pending',
    updated_at: new Date().toISOString(),
  };
  if (attachment_storage_path) row.attachment_storage_path = attachment_storage_path;

  if (id) {
    const { error } = await supabase.from('project_bills').update(row).eq('id', id);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/projects/${project_id}`);
    return { ok: true, id };
  }

  row.tenant_id = tenant.id;
  const { data, error } = await supabase.from('project_bills').insert(row).select('id').single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to create bill.' };
  revalidatePath(`/projects/${project_id}`);
  return { ok: true, id: data.id as string };
}

/** @deprecated use upsertBillWithAttachmentAction */
export async function upsertBillAction(input: unknown): Promise<CostControlResult> {
  const billSchema = z.object({
    id: z.string().uuid().optional(),
    project_id: z.string().uuid(),
    vendor: z.string().trim().min(1, 'Vendor is required').max(200),
    bill_date: z.string().min(1, 'Date is required'),
    description: z.string().trim().max(1000).optional().or(z.literal('')),
    amount_cents: z.coerce.number().int().min(1, 'Amount must be greater than 0'),
    status: z.enum(['pending', 'approved', 'paid']).optional().default('pending'),
    cost_code: z.string().trim().max(50).optional().or(z.literal('')),
    vendor_gst_number: z.string().trim().max(40).optional().or(z.literal('')),
  });
  const parsed = billSchema.safeParse(input);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? 'Invalid input.' };
  }
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();
  const { id, description, cost_code, vendor_gst_number, ...fields } = parsed.data;
  const row = {
    ...fields,
    description: description || null,
    cost_code: cost_code || null,
    vendor_gst_number: vendor_gst_number?.trim() || null,
    updated_at: new Date().toISOString(),
  };
  if (id) {
    const { error } = await supabase.from('project_bills').update(row).eq('id', id);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/projects/${fields.project_id}`);
    return { ok: true, id };
  }
  const { data, error } = await supabase
    .from('project_bills')
    .insert({ ...row, tenant_id: tenant.id })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to create bill.' };
  revalidatePath(`/projects/${fields.project_id}`);
  return { ok: true, id: data.id as string };
}

export async function deleteBillAction(id: string, projectId: string): Promise<CostControlResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();
  const { error } = await supabase.from('project_bills').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id };
}

// ─── Cost line photos ─────────────────────────────────────────────────────────

export async function attachCostLinePhotoAction(formData: FormData): Promise<CostControlResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const costLineId = String(formData.get('cost_line_id') ?? '');
  const projectId = String(formData.get('project_id') ?? '');
  const file = formData.get('photo');
  if (!costLineId || !projectId) return { ok: false, error: 'Missing line or project.' };
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No photo provided.' };
  }
  if (file.size > MAX_COST_LINE_PHOTO_BYTES) {
    return { ok: false, error: 'Photo is larger than 10MB.' };
  }

  const supabase = await createClient();
  const { data: row, error: loadErr } = await supabase
    .from('project_cost_lines')
    .select('photo_storage_paths')
    .eq('id', costLineId)
    .single();
  if (loadErr || !row) return { ok: false, error: loadErr?.message ?? 'Line not found.' };

  // HEIC (iPhone) → JPEG: browsers outside Safari can't render HEIC, so
  // convert server-side with sharp (libheif). PNG/WEBP/JPEG pass through.
  let uploadBody: Blob | Buffer = file;
  let uploadContentType = file.type || 'image/jpeg';
  let uploadExt: string;
  const lowerName = (file.name ?? '').toLowerCase();
  const isHeic =
    file.type === 'image/heic' ||
    file.type === 'image/heif' ||
    lowerName.endsWith('.heic') ||
    lowerName.endsWith('.heif');

  if (isHeic) {
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      const jpeg = await sharp(buf).rotate().jpeg({ quality: 85 }).toBuffer();
      uploadBody = jpeg;
      uploadContentType = 'image/jpeg';
      uploadExt = 'jpg';
    } catch (err) {
      return {
        ok: false,
        error: `Could not convert HEIC photo: ${err instanceof Error ? err.message : String(err)}. Try exporting as JPEG first.`,
      };
    }
  } else {
    uploadExt = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  }

  const uploaded = await uploadToStorage({
    tenantId: tenant.id,
    projectId,
    photoId: randomUUID(),
    file: uploadBody,
    contentType: uploadContentType,
    extension: uploadExt,
  });
  if ('error' in uploaded) return { ok: false, error: uploaded.error };

  const existing = (row.photo_storage_paths as string[] | null) ?? [];
  const next = [...existing, uploaded.path];

  const { error: updErr } = await supabase
    .from('project_cost_lines')
    .update({ photo_storage_paths: next })
    .eq('id', costLineId);
  if (updErr) return { ok: false, error: updErr.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: costLineId };
}

export async function removeCostLinePhotoAction(input: {
  costLineId: string;
  projectId: string;
  storagePath: string;
}): Promise<CostControlResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data: row, error: loadErr } = await supabase
    .from('project_cost_lines')
    .select('photo_storage_paths')
    .eq('id', input.costLineId)
    .single();
  if (loadErr || !row) return { ok: false, error: loadErr?.message ?? 'Line not found.' };

  const existing = (row.photo_storage_paths as string[] | null) ?? [];
  const next = existing.filter((p) => p !== input.storagePath);

  const { error: updErr } = await supabase
    .from('project_cost_lines')
    .update({ photo_storage_paths: next })
    .eq('id', input.costLineId);
  if (updErr) return { ok: false, error: updErr.message };

  await supabase.storage.from('photos').remove([input.storagePath]);

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, id: input.costLineId };
}
