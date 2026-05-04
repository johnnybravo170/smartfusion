'use server';

/**
 * Vendor quote server actions — the "committed" layer of cost control.
 *
 * Phase 1 of SUB_QUOTES_PLAN.md. No AI upload yet; operator enters the
 * quote manually (or uploads an attachment that we just store; parsing
 * lands in Phase 2).
 *
 * Invariant enforced at the action layer (not DB): sum of allocations
 * must equal total_cents before a quote can transition to `accepted`.
 * See PATTERNS.md §5 for the { ok, error } action shape.
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  SUB_QUOTE_PARSE_JSON_SCHEMA,
  SUB_QUOTE_PARSE_SYSTEM_PROMPT,
  type SubQuoteParseResult,
} from '@/lib/ai/sub-quote-parse-prompt';
import { gateway, isAiError } from '@/lib/ai-gateway';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const ATTACHMENTS_BUCKET = 'sub-quotes';
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB
const PARSE_MODEL = 'gpt-4o-mini';

export type SubQuoteResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

const allocationInput = z.object({
  budget_category_id: z.string().uuid(),
  allocated_cents: z.coerce.number().int().min(0),
  notes: z.string().trim().max(500).nullable().optional(),
});

const subQuoteCreateSchema = z.object({
  project_id: z.string().uuid(),
  vendor_name: z.string().trim().min(1, { message: 'Vendor name is required.' }).max(200),
  vendor_email: z.string().trim().email().optional().or(z.literal('')),
  vendor_phone: z.string().trim().max(40).optional().or(z.literal('')),
  total_cents: z.coerce.number().int().min(0),
  scope_description: z.string().trim().max(5000).optional().or(z.literal('')),
  notes: z.string().trim().max(5000).optional().or(z.literal('')),
  quote_date: z.string().optional().or(z.literal('')),
  valid_until: z.string().optional().or(z.literal('')),
  allocations: z.array(allocationInput).optional().default([]),
});

function extFromContentType(contentType: string): string {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/heic' || contentType === 'image/heif') return 'heic';
  if (contentType === 'application/pdf') return 'pdf';
  return 'jpg';
}

/**
 * Create a new vendor quote with its allocations. Takes a FormData so we
 * can receive the attachment file alongside the JSON fields. Allocations
 * are passed as a JSON string in `allocations`.
 *
 * Quote starts as `pending_review` regardless of whether allocations
 * balance — acceptance is a separate step that enforces the invariant.
 */
export async function createSubQuoteAction(formData: FormData): Promise<SubQuoteResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const rawAllocations = formData.get('allocations');
  let parsedAllocations: unknown[] = [];
  if (typeof rawAllocations === 'string' && rawAllocations.length > 0) {
    try {
      parsedAllocations = JSON.parse(rawAllocations);
    } catch {
      return { ok: false, error: 'Invalid allocations payload.' };
    }
  }

  const parsed = subQuoteCreateSchema.safeParse({
    project_id: String(formData.get('project_id') ?? ''),
    vendor_name: String(formData.get('vendor_name') ?? ''),
    vendor_email: String(formData.get('vendor_email') ?? ''),
    vendor_phone: String(formData.get('vendor_phone') ?? ''),
    total_cents: Number(formData.get('total_cents') ?? 0),
    scope_description: String(formData.get('scope_description') ?? ''),
    notes: String(formData.get('notes') ?? ''),
    quote_date: String(formData.get('quote_date') ?? ''),
    valid_until: String(formData.get('valid_until') ?? ''),
    allocations: parsedAllocations,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const admin = createAdminClient();

  // Optional attachment upload. Path convention: {tenant_id}/{quote_id}.{ext}.
  const attachment = formData.get('attachment');
  let attachmentPath: string | null = null;
  if (attachment && attachment instanceof File && attachment.size > 0) {
    if (attachment.size > MAX_ATTACHMENT_BYTES) {
      return { ok: false, error: 'Attachment is larger than 10MB.' };
    }
    const ext = extFromContentType(attachment.type);
    // Pre-generate the quote id so the storage path and DB row line up.
    const quoteId = randomUUID();
    const path = `${tenant.id}/${quoteId}.${ext}`;
    const { error: upErr } = await admin.storage.from(ATTACHMENTS_BUCKET).upload(path, attachment, {
      contentType: attachment.type || 'application/pdf',
      upsert: false,
    });
    if (upErr) return { ok: false, error: `Attachment upload failed: ${upErr.message}` };
    attachmentPath = path;

    return insertQuote({
      quoteId,
      tenantId: tenant.id,
      createdBy: tenant.member.id,
      parsed: parsed.data,
      attachmentPath,
    });
  }

  return insertQuote({
    quoteId: randomUUID(),
    tenantId: tenant.id,
    createdBy: tenant.member.id,
    parsed: parsed.data,
    attachmentPath: null,
  });
}

async function insertQuote(args: {
  quoteId: string;
  tenantId: string;
  createdBy: string;
  parsed: z.infer<typeof subQuoteCreateSchema>;
  attachmentPath: string | null;
}): Promise<SubQuoteResult> {
  const { quoteId, tenantId, createdBy, parsed, attachmentPath } = args;

  const supabase = await createClient();

  const { error: insertErr } = await supabase.from('project_sub_quotes').insert({
    id: quoteId,
    tenant_id: tenantId,
    project_id: parsed.project_id,
    vendor_name: parsed.vendor_name.trim(),
    vendor_email: parsed.vendor_email?.trim() || null,
    vendor_phone: parsed.vendor_phone?.trim() || null,
    total_cents: parsed.total_cents,
    scope_description: parsed.scope_description?.trim() || null,
    notes: parsed.notes?.trim() || null,
    quote_date: parsed.quote_date || null,
    valid_until: parsed.valid_until || null,
    attachment_storage_path: attachmentPath,
    source: attachmentPath ? 'upload' : 'manual',
    created_by: createdBy,
  });
  if (insertErr) return { ok: false, error: insertErr.message };

  // Allocations — bulk insert. Zero-count is OK; balance is checked only
  // on accept, not on create.
  if (parsed.allocations.length > 0) {
    const rows = parsed.allocations.map((a) => ({
      sub_quote_id: quoteId,
      budget_category_id: a.budget_category_id,
      allocated_cents: a.allocated_cents,
      notes: a.notes?.trim() || null,
    }));
    const { error: allocErr } = await supabase.from('project_sub_quote_allocations').insert(rows);
    if (allocErr) {
      // Roll back the quote row so we don't leave a dangling parent.
      await supabase.from('project_sub_quotes').delete().eq('id', quoteId);
      return { ok: false, error: `Allocation insert failed: ${allocErr.message}` };
    }
  }

  revalidatePath(`/projects/${parsed.project_id}`);
  return { ok: true, id: quoteId };
}

// ---------------------------------------------------------------------------
// Update / status transitions
// ---------------------------------------------------------------------------

const subQuoteUpdateSchema = subQuoteCreateSchema.extend({
  id: z.string().uuid(),
});

/**
 * Edit an existing vendor quote's fields + allocations. Status is preserved
 * (edit is allowed on any status so operators can recategorize an already-
 * accepted quote). Allocations are wipe+reinsert, same as
 * setSubQuoteAllocationsAction. Balance invariant is only enforced on
 * accept — an edit can leave an accepted quote unbalanced.
 */
export async function updateSubQuoteAction(input: {
  id: string;
  project_id: string;
  vendor_name: string;
  vendor_email?: string;
  vendor_phone?: string;
  total_cents: number;
  scope_description?: string;
  notes?: string;
  quote_date?: string;
  valid_until?: string;
  allocations: Array<{
    budget_category_id: string;
    allocated_cents: number;
    notes?: string | null;
  }>;
}): Promise<SubQuoteResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = subQuoteUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = await createClient();

  const { error: updErr } = await supabase
    .from('project_sub_quotes')
    .update({
      vendor_name: parsed.data.vendor_name.trim(),
      vendor_email: parsed.data.vendor_email?.trim() || null,
      vendor_phone: parsed.data.vendor_phone?.trim() || null,
      total_cents: parsed.data.total_cents,
      scope_description: parsed.data.scope_description?.trim() || null,
      notes: parsed.data.notes?.trim() || null,
      quote_date: parsed.data.quote_date || null,
      valid_until: parsed.data.valid_until || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.id);
  if (updErr) return { ok: false, error: updErr.message };

  const { error: delErr } = await supabase
    .from('project_sub_quote_allocations')
    .delete()
    .eq('sub_quote_id', parsed.data.id);
  if (delErr) return { ok: false, error: delErr.message };

  if (parsed.data.allocations.length > 0) {
    const rows = parsed.data.allocations.map((a) => ({
      sub_quote_id: parsed.data.id,
      budget_category_id: a.budget_category_id,
      allocated_cents: a.allocated_cents,
      notes: a.notes?.trim() || null,
    }));
    const { error: insErr } = await supabase.from('project_sub_quote_allocations').insert(rows);
    if (insErr) return { ok: false, error: insErr.message };
  }

  revalidatePath(`/projects/${parsed.data.project_id}`);
  return { ok: true, id: parsed.data.id };
}

/**
 * Replace a vendor quote's allocation set. Used when the operator edits
 * allocations in the editor. Takes the full new set; we wipe+reinsert
 * because the math is clearer than diffing. Doesn't change quote status.
 */
export async function setSubQuoteAllocationsAction(input: {
  subQuoteId: string;
  projectId: string;
  allocations: Array<{
    budget_category_id: string;
    allocated_cents: number;
    notes?: string | null;
  }>;
}): Promise<SubQuoteResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const schema = z.object({
    subQuoteId: z.string().uuid(),
    projectId: z.string().uuid(),
    allocations: z.array(allocationInput),
  });
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };

  const supabase = await createClient();
  const { error: delErr } = await supabase
    .from('project_sub_quote_allocations')
    .delete()
    .eq('sub_quote_id', parsed.data.subQuoteId);
  if (delErr) return { ok: false, error: delErr.message };

  if (parsed.data.allocations.length > 0) {
    const rows = parsed.data.allocations.map((a) => ({
      sub_quote_id: parsed.data.subQuoteId,
      budget_category_id: a.budget_category_id,
      allocated_cents: a.allocated_cents,
      notes: a.notes?.trim() || null,
    }));
    const { error: insErr } = await supabase.from('project_sub_quote_allocations').insert(rows);
    if (insErr) return { ok: false, error: insErr.message };
  }

  await supabase
    .from('project_sub_quotes')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', parsed.data.subQuoteId);

  revalidatePath(`/projects/${parsed.data.projectId}`);
  return { ok: true, id: parsed.data.subQuoteId };
}

/**
 * Accept a vendor quote. Enforces the invariant: sum of allocations must
 * equal total_cents. If a prior accepted quote from the same vendor
 * exists on this project AND shares a category, that prior quote is
 * superseded (its status flips, `superseded_by_id` points at this one).
 *
 * `replaceExisting`:
 *   - `'auto'` — apply supersede if category-overlap, else leave in place
 *   - `'yes'`  — force supersede every accepted quote from this vendor
 *   - `'no'`   — leave any existing accepted quotes alone
 */
export async function acceptSubQuoteAction(input: {
  subQuoteId: string;
  projectId: string;
  replaceExisting?: 'auto' | 'yes' | 'no';
}): Promise<SubQuoteResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  // Load the quote + allocations so we can check the balance invariant.
  const { data: quote, error: qErr } = await supabase
    .from('project_sub_quotes')
    .select('id, vendor_name, total_cents, status, project_id')
    .eq('id', input.subQuoteId)
    .single();
  if (qErr || !quote) return { ok: false, error: 'Vendor quote not found.' };

  const { data: allocations, error: aErr } = await supabase
    .from('project_sub_quote_allocations')
    .select('budget_category_id, allocated_cents')
    .eq('sub_quote_id', input.subQuoteId);
  if (aErr) return { ok: false, error: aErr.message };

  const allocSum = (allocations ?? []).reduce(
    (s, a) => s + ((a.allocated_cents as number) ?? 0),
    0,
  );
  if (allocSum !== (quote.total_cents as number)) {
    return {
      ok: false,
      error: `Allocations total $${(allocSum / 100).toFixed(2)}, but the quote total is $${((quote.total_cents as number) / 100).toFixed(2)}. Balance them before accepting.`,
    };
  }
  if ((quote.total_cents as number) === 0) {
    return { ok: false, error: 'Cannot accept a zero-dollar quote.' };
  }

  // Existing accepted quotes from the same vendor on the same project.
  const { data: priorAccepted } = await supabase
    .from('project_sub_quotes')
    .select('id, total_cents')
    .eq('project_id', quote.project_id as string)
    .eq('vendor_name', quote.vendor_name as string)
    .eq('status', 'accepted')
    .neq('id', input.subQuoteId);

  const replaceMode = input.replaceExisting ?? 'auto';
  const toSupersede: string[] = [];
  if (replaceMode === 'yes') {
    toSupersede.push(...(priorAccepted ?? []).map((p) => p.id as string));
  } else if (replaceMode === 'auto' && priorAccepted?.length) {
    // Supersede only when category overlap exists — different categories =
    // genuinely separate scopes (tile kitchen vs tile bathroom).
    const ourCategories = new Set((allocations ?? []).map((a) => a.budget_category_id as string));
    for (const prior of priorAccepted) {
      const { data: priorAllocs } = await supabase
        .from('project_sub_quote_allocations')
        .select('budget_category_id')
        .eq('sub_quote_id', prior.id as string);
      const overlap = (priorAllocs ?? []).some((pa) =>
        ourCategories.has(pa.budget_category_id as string),
      );
      if (overlap) toSupersede.push(prior.id as string);
    }
  }

  if (toSupersede.length) {
    await supabase
      .from('project_sub_quotes')
      .update({
        status: 'superseded',
        superseded_by_id: input.subQuoteId,
        updated_at: new Date().toISOString(),
      })
      .in('id', toSupersede);
  }

  const { error: updErr } = await supabase
    .from('project_sub_quotes')
    .update({ status: 'accepted', updated_at: new Date().toISOString() })
    .eq('id', input.subQuoteId);
  if (updErr) return { ok: false, error: updErr.message };

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, id: input.subQuoteId };
}

export async function rejectSubQuoteAction(input: {
  subQuoteId: string;
  projectId: string;
}): Promise<SubQuoteResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('project_sub_quotes')
    .update({ status: 'rejected', updated_at: new Date().toISOString() })
    .eq('id', input.subQuoteId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, id: input.subQuoteId };
}

export async function deleteSubQuoteAction(input: {
  subQuoteId: string;
  projectId: string;
}): Promise<SubQuoteResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase.from('project_sub_quotes').delete().eq('id', input.subQuoteId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, id: input.subQuoteId };
}

// ---------------------------------------------------------------------------
// Inline category creation (from the allocation editor)
// ---------------------------------------------------------------------------

const categorySectionSchema = z.enum(['interior', 'exterior', 'general']);

/**
 * Create a new budget category on a project from inside the allocation
 * editor. Returns the new category so the caller can append it to the
 * in-memory category list and select it in a fresh allocation row.
 */
export async function createProjectCategoryAction(input: {
  projectId: string;
  name: string;
  section: 'interior' | 'exterior' | 'general';
}): Promise<
  | {
      ok: true;
      category: { id: string; name: string; section: 'interior' | 'exterior' | 'general' };
    }
  | { ok: false; error: string }
> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = z
    .object({
      projectId: z.string().uuid(),
      name: z.string().trim().min(1).max(120),
      section: categorySectionSchema,
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };

  const supabase = await createClient();

  // Next display_order = max(existing) + 10 so the new category lands at
  // the end of the list without clashing.
  const { data: existing } = await supabase
    .from('project_budget_categories')
    .select('display_order')
    .eq('project_id', parsed.data.projectId)
    .order('display_order', { ascending: false })
    .limit(1);
  const nextOrder = ((existing?.[0]?.display_order as number | undefined) ?? 0) + 10;

  const { data, error } = await supabase
    .from('project_budget_categories')
    .insert({
      tenant_id: tenant.id,
      project_id: parsed.data.projectId,
      name: parsed.data.name.trim(),
      section: parsed.data.section,
      display_order: nextOrder,
    })
    .select('id, name, section')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to create category.' };

  revalidatePath(`/projects/${parsed.data.projectId}`);
  return {
    ok: true,
    category: {
      id: data.id as string,
      name: data.name as string,
      section: data.section as 'interior' | 'exterior' | 'general',
    },
  };
}

// ---------------------------------------------------------------------------
// AI parsing — Phase 2
// ---------------------------------------------------------------------------

export type ParseSubQuoteResult =
  | {
      ok: true;
      docType: 'sub_quote' | 'not_sub_quote';
      confidence: 'high' | 'medium' | 'low';
      reasonIfNot: string | null;
      extracted: SubQuoteParseResult['extracted'];
      /**
       * Allocations already mapped to real category IDs. AI returns names; we
       * resolve to IDs server-side. Category names the AI suggests that don't
       * match a real category are dropped (operator allocates manually).
       */
      allocations: Array<{
        categoryId: string;
        categoryName: string;
        allocatedCents: number;
        confidence: 'high' | 'medium' | 'low';
        reasoning: string;
      }>;
      unmatchedAllocations: Array<{
        proposedCategoryName: string;
        allocatedCents: number;
        reasoning: string;
      }>;
    }
  | { ok: false; error: string };

/**
 * Parse an uploaded sub-quote document and return extracted fields +
 * allocation suggestions. Does not persist anything — the operator
 * reviews, edits, then submits via createSubQuoteAction (which will
 * re-upload the same File as the attachment).
 */
export async function parseSubQuoteFromFileAction(
  formData: FormData,
): Promise<ParseSubQuoteResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const projectId = String(formData.get('project_id') ?? '');
  if (!projectId) return { ok: false, error: 'Missing projectId.' };

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No file provided.' };
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: 'File is larger than 10MB.' };
  }
  const isImage = file.type.startsWith('image/');
  const isPdf = file.type === 'application/pdf';
  if (!isImage && !isPdf) {
    return { ok: false, error: `Unsupported file type: ${file.type}.` };
  }

  const supabase = await createClient();

  // Load project + existing categories so the AI can map scope → categories.
  const { data: project } = await supabase
    .from('projects')
    .select('id, name, description, customers:customer_id (name)')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) return { ok: false, error: 'Project not found.' };

  const { data: categoryRows } = await supabase
    .from('project_budget_categories')
    .select('id, name, section')
    .eq('project_id', projectId)
    .order('display_order');

  const categoriesById = new Map<string, { id: string; name: string; section: string | null }>();
  const categoriesByName = new Map<string, { id: string; name: string; section: string | null }>();
  for (const b of categoryRows ?? []) {
    const entry = {
      id: b.id as string,
      name: b.name as string,
      section: (b.section as string | null) ?? null,
    };
    categoriesById.set(entry.id, entry);
    // Case-preserving key; the prompt tells the model to match exactly.
    categoriesByName.set(entry.name, entry);
  }

  if (categoriesByName.size === 0) {
    return {
      ok: false,
      error:
        'This project has no budget categories yet. Create at least one category before parsing a quote.',
    };
  }

  // Build the intro: project + customer + category roster.
  const customerName = Array.isArray(project.customers)
    ? (project.customers[0] as { name?: string } | undefined)?.name
    : (project.customers as { name?: string } | null)?.name;
  const categoryRoster = Array.from(categoriesByName.values())
    .map((b) => `  - ${b.section ? `[${b.section}] ` : ''}${b.name}`)
    .join('\n');

  const intro = [
    'PROJECT CONTEXT',
    `Project: ${project.name}`,
    `Customer: ${customerName ?? '(unknown)'}`,
    `Description: ${project.description ?? '(none)'}`,
    `Existing budget categories (you may ONLY reference these exact names in allocations):`,
    categoryRoster,
    '',
    'The document that follows is what the operator uploaded. Parse it.',
  ].join('\n');

  const buf = Buffer.from(await file.arrayBuffer());
  const b64 = buf.toString('base64');

  let parsed: SubQuoteParseResult;
  try {
    const res = await gateway().runStructured<SubQuoteParseResult>({
      kind: 'structured',
      task: 'sub_quote_parse',
      tenant_id: tenant.id,
      model_override: PARSE_MODEL,
      prompt: `${SUB_QUOTE_PARSE_SYSTEM_PROMPT}\n\n${intro}`,
      schema: SUB_QUOTE_PARSE_JSON_SCHEMA.schema,
      file: { mime: file.type, base64: b64, filename: file.name || undefined },
    });
    parsed = res.data;
  } catch (err) {
    if (isAiError(err)) {
      if (err.kind === 'quota')
        return { ok: false, error: 'AI parsing temporarily unavailable across providers.' };
      if (err.kind === 'overload' || err.kind === 'rate_limit')
        return { ok: false, error: 'AI parsing is busy right now. Try again in a moment.' };
    }
    return { ok: false, error: 'Failed to parse the quote. Try again.' };
  }

  // Map AI allocation category names back to real category IDs. Anything the
  // AI invented (or mis-cased) goes into unmatchedAllocations so the UI
  // can surface it as context without silently persisting junk.
  type MatchedAllocation = {
    categoryId: string;
    categoryName: string;
    allocatedCents: number;
    confidence: 'high' | 'medium' | 'low';
    reasoning: string;
  };
  type UnmatchedAllocation = {
    proposedCategoryName: string;
    allocatedCents: number;
    reasoning: string;
  };
  const matched: MatchedAllocation[] = [];
  const unmatched: UnmatchedAllocation[] = [];

  for (const a of parsed.allocations) {
    const hit = categoriesByName.get(a.budget_category_name);
    if (hit) {
      matched.push({
        categoryId: hit.id,
        categoryName: hit.name,
        allocatedCents: a.allocated_cents,
        confidence: a.confidence,
        reasoning: a.reasoning,
      });
    } else {
      unmatched.push({
        proposedCategoryName: a.budget_category_name,
        allocatedCents: a.allocated_cents,
        reasoning: a.reasoning,
      });
    }
  }

  return {
    ok: true,
    docType: parsed.doc_type,
    confidence: parsed.confidence,
    reasonIfNot: parsed.reason_if_not,
    extracted: parsed.extracted,
    allocations: matched,
    unmatchedAllocations: unmatched,
  };
}
