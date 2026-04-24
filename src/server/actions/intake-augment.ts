'use server';

/**
 * Augment-mode project intake — operator drops artifacts on the
 * project page, Henry returns a list of suggested additions/updates,
 * operator reviews, then we apply.
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import {
  AUGMENT_JSON_SCHEMA,
  AUGMENT_SYSTEM_PROMPT,
  type AugmentResult,
} from '@/lib/ai/intake-augment-prompt';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { uploadToStorage } from '@/lib/storage/photos';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const RECEIPTS_BUCKET = 'receipts';

function extFromContentType(contentType: string): string {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/heic' || contentType === 'image/heif') return 'heic';
  if (contentType === 'application/pdf') return 'pdf';
  return 'jpg';
}

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES = 12;
const PARSE_MODEL = 'gpt-4o-mini';

export type ParseAugmentResult =
  | { ok: true; suggestions: AugmentResult; existingBuckets: string[] }
  | { ok: false; error: string };

export async function parseProjectAugmentAction(formData: FormData): Promise<ParseAugmentResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'Server missing OPENAI_API_KEY' };

  const projectId = String(formData.get('projectId') ?? '');
  if (!projectId) return { ok: false, error: 'Missing projectId.' };

  const supabase = await createClient();
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('id, name, description, customers:customer_id (name)')
    .eq('id', projectId)
    .maybeSingle();
  if (projErr || !project) {
    return { ok: false, error: 'Project not found.' };
  }

  const { data: bucketRows } = await supabase
    .from('project_cost_buckets')
    .select('id, name, section, project_cost_lines (label)')
    .eq('project_id', projectId)
    .order('display_order');

  const existingBuckets =
    bucketRows?.map((b) => ({
      name: b.name as string,
      section: (b.section as string | null) ?? null,
      lines: ((b.project_cost_lines as Array<{ label: string }> | null) ?? []).map((l) => l.label),
    })) ?? [];

  const files = formData.getAll('images').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) {
    return { ok: false, error: 'Drop at least one file.' };
  }
  if (files.length > MAX_IMAGES) {
    return { ok: false, error: `Too many files (max ${MAX_IMAGES}).` };
  }
  for (const f of files) {
    if (f.size > MAX_BYTES) {
      return { ok: false, error: `${f.name} is larger than 25MB.` };
    }
    const isImage = f.type.startsWith('image/');
    const isPdf = f.type === 'application/pdf';
    if (!isImage && !isPdf) {
      return { ok: false, error: `${f.name} is not an image or PDF (${f.type}).` };
    }
  }

  // Build the intro text: project context + bucket roster.
  const customerName = Array.isArray(project.customers)
    ? (project.customers[0] as { name?: string } | undefined)?.name
    : (project.customers as { name?: string } | null)?.name;
  const bucketRoster = existingBuckets.length
    ? existingBuckets
        .map((b) => {
          const sec = b.section ? `${b.section} / ` : '';
          const lines = b.lines.length
            ? `\n      lines: ${b.lines.map((l) => `"${l}"`).join(', ')}`
            : '';
          return `  - ${sec}${b.name}${lines}`;
        })
        .join('\n')
    : '  (none yet)';

  const intro = [
    `EXISTING PROJECT CONTEXT`,
    `Tenant: ${tenant.name ?? 'Contractor'}`,
    `Project name: ${project.name}`,
    `Customer: ${customerName ?? '(unknown)'}`,
    `Project description: ${project.description ?? '(none)'}`,
    `Existing buckets:\n${bucketRoster}`,
    '',
    `${files.length} new artifact(s) follow (images and/or PDFs), indexed 0..${files.length - 1}.`,
  ].join('\n');

  const userContent: Array<Record<string, unknown>> = [{ type: 'text', text: intro }];
  for (const f of files) {
    const buf = Buffer.from(await f.arrayBuffer());
    const b64 = buf.toString('base64');
    if (f.type === 'application/pdf') {
      userContent.push({
        type: 'file',
        file: {
          filename: f.name || 'document.pdf',
          file_data: `data:application/pdf;base64,${b64}`,
        },
      });
    } else {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:${f.type};base64,${b64}` },
      });
    }
  }

  const body = {
    model: PARSE_MODEL,
    messages: [
      { role: 'system', content: AUGMENT_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_schema', json_schema: AUGMENT_JSON_SCHEMA },
  };

  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { ok: false, error: `OpenAI ${res.status}: ${txt || res.statusText}` };
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) return { ok: false, error: 'OpenAI returned no content.' };

  let suggestions: AugmentResult;
  try {
    suggestions = JSON.parse(content) as AugmentResult;
  } catch {
    return { ok: false, error: 'OpenAI returned non-JSON.' };
  }

  return {
    ok: true,
    suggestions,
    existingBuckets: existingBuckets.map((b) => b.name),
  };
}

export type ApplyAugmentResult = { ok: true; appliedCount: number } | { ok: false; error: string };

export type ApplyAugmentInput = {
  projectId: string;
  description_addendum: string | null;
  new_buckets: Array<{ name: string; section: string | null }>;
  new_lines: Array<{
    bucket_name: string;
    label: string;
    notes: string | null;
    qty: number;
    unit: string;
    unit_price_cents: number | null;
    /** Indexes into the FormData "images" list — these get uploaded
     * and attached to this line's photo_storage_paths. */
    source_image_indexes: number[];
  }>;
  new_bills: Array<{
    vendor: string | null;
    vendor_gst_number: string | null;
    bill_date: string | null;
    description: string | null;
    amount_cents: number;
    gst_cents: number;
    bucket_name: string | null;
    /** Index into the FormData "images" list — uploaded as attachment_storage_path. */
    source_image_index: number | null;
  }>;
  new_expenses: Array<{
    vendor: string | null;
    vendor_gst_number: string | null;
    amount_cents: number;
    expense_date: string | null;
    description: string | null;
    bucket_name: string | null;
    /** Index into the FormData "images" list — uploaded as receipt_url. */
    source_image_index: number | null;
  }>;
  new_artifacts: Array<{
    kind: 'sketch' | 'inspiration' | 'drawing';
    label: string;
    summary: string | null;
    /** Index into the FormData "images" list — persisted to project_notes. */
    source_image_index: number;
  }>;
  mergeSignals: AugmentResult['signals'] | null;
  /** If set, persist as a kind='reply_draft' note in the project Notes feed. */
  replyDraft: string | null;
};

/**
 * Apply the augment plan + (optionally) upload images and attach them
 * to the cost lines that referenced them.
 *
 * formData fields:
 *  - "plan"   — JSON-serialized ApplyAugmentInput
 *  - "images" — File[] (the same artifacts the operator parsed),
 *               indexed in the same order parse received them
 */
export async function applyProjectAugmentAction(formData: FormData): Promise<ApplyAugmentResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const planRaw = String(formData.get('plan') ?? '');
  if (!planRaw) return { ok: false, error: 'Missing plan.' };
  let input: ApplyAugmentInput;
  try {
    input = JSON.parse(planRaw) as ApplyAugmentInput;
  } catch {
    return { ok: false, error: 'Invalid plan JSON.' };
  }

  const files = formData.getAll('images').filter((f): f is File => f instanceof File && f.size > 0);

  // Upload only images. PDFs aren't attached to cost lines in V1 (they
  // contributed to the parse but cost_lines schema only carries
  // photo_storage_paths). PDF persistence lands in a future phase.
  const indexToPath: Record<number, string> = {};
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f.type.startsWith('image/')) continue;
    const ext = f.type === 'image/png' ? 'png' : f.type === 'image/webp' ? 'webp' : 'jpg';
    const uploaded = await uploadToStorage({
      tenantId: tenant.id,
      projectId: input.projectId,
      photoId: randomUUID(),
      file: f,
      contentType: f.type || 'image/jpeg',
      extension: ext,
    });
    if ('error' in uploaded) return { ok: false, error: `Upload: ${uploaded.error}` };
    indexToPath[i] = uploaded.path;
  }

  const supabase = await createClient();
  let applied = 0;

  // 1. Description addendum.
  if (input.description_addendum?.trim()) {
    const { data: cur } = await supabase
      .from('projects')
      .select('description')
      .eq('id', input.projectId)
      .single();
    const next = [cur?.description ?? '', input.description_addendum.trim()]
      .filter(Boolean)
      .join('\n\n');
    const { error } = await supabase
      .from('projects')
      .update({ description: next, updated_at: new Date().toISOString() })
      .eq('id', input.projectId);
    if (error) return { ok: false, error: `Description: ${error.message}` };
    applied++;
  }

  // 2. New buckets.
  const bucketIdByName = new Map<string, string>();
  // Pull current buckets first so we can resolve line targets across both
  // pre-existing and freshly inserted buckets.
  {
    const { data: existing } = await supabase
      .from('project_cost_buckets')
      .select('id, name, display_order')
      .eq('project_id', input.projectId);
    for (const b of existing ?? []) {
      bucketIdByName.set((b.name as string).toLowerCase(), b.id as string);
    }
    const nextOrder =
      (existing ?? []).reduce((m, b) => Math.max(m, (b.display_order as number) ?? 0), 0) + 1;

    if (input.new_buckets.length) {
      const rows = input.new_buckets.map((b, i) => ({
        project_id: input.projectId,
        tenant_id: tenant.id,
        name: b.name,
        section: b.section?.trim() || 'General',
        display_order: nextOrder + i,
      }));
      const { data: inserted, error } = await supabase
        .from('project_cost_buckets')
        .insert(rows)
        .select('id, name');
      if (error) return { ok: false, error: `Buckets: ${error.message}` };
      for (const b of inserted ?? []) {
        bucketIdByName.set((b.name as string).toLowerCase(), b.id as string);
      }
      applied += inserted?.length ?? 0;
    }
  }

  // 3. New lines.
  if (input.new_lines.length) {
    // Track which image indexes are claimed by any line/expense so we
    // can sweep orphans onto the first line at the end.
    const claimed = new Set<number>();
    for (const l of input.new_lines) {
      for (const i of l.source_image_indexes ?? []) claimed.add(i);
    }
    for (const e of input.new_expenses ?? []) {
      if (e.source_image_index != null) claimed.add(e.source_image_index);
    }
    for (const a of input.new_artifacts ?? []) {
      claimed.add(a.source_image_index);
    }
    const orphanPaths = Object.entries(indexToPath)
      .filter(([i]) => !claimed.has(Number(i)))
      .map(([, p]) => p);

    const lineRows: Array<Record<string, unknown>> = [];
    input.new_lines.forEach((l, lineIdx) => {
      const bucketId = bucketIdByName.get(l.bucket_name.toLowerCase()) ?? null;
      const qty = Number(l.qty) || 1;
      const unitPrice = Number(l.unit_price_cents ?? 0) || 0;
      const ownPhotos = (l.source_image_indexes ?? [])
        .map((i) => indexToPath[i])
        .filter((p): p is string => !!p);
      // Attach any orphan images to the first new line so they're never
      // uploaded-but-invisible.
      const photoPaths = lineIdx === 0 ? [...ownPhotos, ...orphanPaths] : ownPhotos;
      lineRows.push({
        project_id: input.projectId,
        bucket_id: bucketId,
        category: 'material',
        label: l.label,
        notes: l.notes?.trim() || null,
        qty,
        unit: l.unit || 'lot',
        unit_cost_cents: 0,
        unit_price_cents: unitPrice,
        line_cost_cents: 0,
        line_price_cents: Math.round(qty * unitPrice),
        markup_pct: 0,
        sort_order: 0,
        photo_storage_paths: photoPaths.length ? photoPaths : null,
      });
    });
    const { error } = await supabase.from('project_cost_lines').insert(lineRows);
    if (error) return { ok: false, error: `Cost lines: ${error.message}` };
    applied += lineRows.length;
  }

  // 3b. Expenses (receipts).
  if (input.new_expenses?.length) {
    const user = await getCurrentUser();
    if (!user) return { ok: false, error: 'Not signed in.' };
    const admin = createAdminClient();

    for (const e of input.new_expenses) {
      let receiptStoragePath: string | null = null;
      const idx = e.source_image_index;
      if (idx != null && files[idx]) {
        const f = files[idx];
        if (f.size > MAX_BYTES) {
          return { ok: false, error: `Receipt ${f.name} larger than 25MB.` };
        }
        const ext = extFromContentType(f.type || 'image/jpeg');
        const path = `${tenant.id}/${user.id}/${randomUUID()}.${ext}`;
        const { error: upErr } = await admin.storage
          .from(RECEIPTS_BUCKET)
          .upload(path, f, { contentType: f.type || 'image/jpeg', upsert: false });
        if (upErr) return { ok: false, error: `Receipt upload: ${upErr.message}` };
        receiptStoragePath = path;
      }

      const bucketId = e.bucket_name
        ? (bucketIdByName.get(e.bucket_name.toLowerCase()) ?? null)
        : null;

      const { error: insErr } = await admin.from('expenses').insert({
        tenant_id: tenant.id,
        user_id: user.id,
        project_id: input.projectId,
        bucket_id: bucketId,
        amount_cents: e.amount_cents,
        vendor: e.vendor?.trim() || null,
        vendor_gst_number: e.vendor_gst_number?.trim() || null,
        description: e.description?.trim() || null,
        receipt_storage_path: receiptStoragePath,
        expense_date: e.expense_date || new Date().toISOString().slice(0, 10),
      });
      if (insErr) {
        if (receiptStoragePath) {
          await admin.storage.from(RECEIPTS_BUCKET).remove([receiptStoragePath]);
        }
        return { ok: false, error: `Expense: ${insErr.message}` };
      }
      applied++;
    }
  }

  // 3c. Bills (received invoices — money owed, not yet paid).
  if (input.new_bills?.length) {
    const user = await getCurrentUser();
    if (!user) return { ok: false, error: 'Not signed in.' };
    const admin = createAdminClient();

    for (const b of input.new_bills) {
      let attachmentStoragePath: string | null = null;
      const idx = b.source_image_index;
      if (idx != null && files[idx]) {
        const f = files[idx];
        if (f.size > MAX_BYTES) {
          return { ok: false, error: `Bill attachment ${f.name} larger than 25MB.` };
        }
        const ext = extFromContentType(f.type || 'application/pdf');
        const path = `${tenant.id}/${user.id}/${randomUUID()}.${ext}`;
        const { error: upErr } = await admin.storage
          .from(RECEIPTS_BUCKET)
          .upload(path, f, { contentType: f.type || 'application/pdf', upsert: false });
        if (upErr) return { ok: false, error: `Bill attachment upload: ${upErr.message}` };
        attachmentStoragePath = path;
      }

      const bucketId = b.bucket_name
        ? (bucketIdByName.get(b.bucket_name.toLowerCase()) ?? null)
        : null;

      const { error: insErr } = await supabase.from('project_bills').insert({
        tenant_id: tenant.id,
        project_id: input.projectId,
        vendor: b.vendor?.trim() || 'Unknown',
        vendor_gst_number: b.vendor_gst_number?.trim() || null,
        bill_date: b.bill_date || new Date().toISOString().slice(0, 10),
        description: b.description?.trim() || null,
        amount_cents: b.amount_cents,
        gst_cents: b.gst_cents ?? 0,
        bucket_id: bucketId,
        attachment_storage_path: attachmentStoragePath,
        status: 'pending',
      });
      if (insErr) {
        if (attachmentStoragePath) {
          await admin.storage.from(RECEIPTS_BUCKET).remove([attachmentStoragePath]);
        }
        return { ok: false, error: `Bill: ${insErr.message}` };
      }
      applied++;
    }
  }

  // 4. Merge signals into existing intake_signals (additive).
  if (input.mergeSignals) {
    const { data: cur } = await supabase
      .from('projects')
      .select('intake_signals')
      .eq('id', input.projectId)
      .single();
    const prior = (cur?.intake_signals as Record<string, unknown> | null) ?? {};
    const merged: Record<string, unknown> = { ...prior };
    const s = input.mergeSignals;
    if (s.competitive != null) merged.competitive = s.competitive;
    if (s.competitor_count != null) merged.competitor_count = s.competitor_count;
    if (s.urgency != null) merged.urgency = s.urgency;
    if (s.upsells.length) {
      merged.upsells = [...(((prior.upsells as unknown[]) ?? []) as unknown[]), ...s.upsells];
    }
    if (s.design_intent.length) {
      merged.design_intent = Array.from(
        new Set([...(((prior.design_intent as string[]) ?? []) as string[]), ...s.design_intent]),
      );
    }
    const { error } = await supabase
      .from('projects')
      .update({
        intake_signals: merged,
        intake_source: 'text-thread',
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.projectId);
    if (error) return { ok: false, error: `Signals: ${error.message}` };
    applied++;
  }

  // 4a. Persist artifact notes (sketches, inspiration, drawings) to the
  // Notes feed with the uploaded image path in metadata so the card can
  // render a thumbnail.
  if (input.new_artifacts?.length) {
    const user = await getCurrentUser();
    const artifactRows = input.new_artifacts
      .map((a) => {
        const path = indexToPath[a.source_image_index];
        if (!path) return null;
        const body = a.summary?.trim() || a.label;
        return {
          project_id: input.projectId,
          tenant_id: tenant.id,
          user_id: user?.id ?? null,
          body,
          kind: 'artifact',
          metadata: {
            kind: a.kind,
            label: a.label,
            image_path: path,
          },
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (artifactRows.length) {
      const { error } = await supabase.from('project_notes').insert(artifactRows);
      if (error) return { ok: false, error: `Artifacts: ${error.message}` };
      applied += artifactRows.length;
    }
  }

  // 4b. Persist reply draft to the Notes feed.
  if (input.replyDraft?.trim()) {
    const user = await getCurrentUser();
    const { error } = await supabase.from('project_notes').insert({
      project_id: input.projectId,
      tenant_id: tenant.id,
      user_id: user?.id ?? null,
      body: input.replyDraft.trim(),
      kind: 'reply_draft',
      metadata: { source: 'project-intake' },
    });
    if (error) return { ok: false, error: `Reply draft note: ${error.message}` };
    applied++;
  }

  // 5. Worklog
  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Project updated from intake',
    body: `Augmented project via dropped artifacts (${applied} change${applied === 1 ? '' : 's'}).`,
    related_type: 'project',
    related_id: input.projectId,
  });

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, appliedCount: applied };
}
