'use server';

/**
 * Inbound lead intake — V1.
 *
 * `parseInboundLeadAction` runs vision over uploaded screenshots /
 * photos and a pasted message. It returns a draft estimate the
 * operator can review. It does NOT mutate.
 *
 * `acceptInboundLeadAction` takes the (possibly edited) draft and
 * creates the customer, project, buckets, and cost lines. Reference-
 * photo upload to project storage is intentionally out of V1 — the
 * operator can attach photos to lines after creation through the
 * existing photo strip UI.
 */

import { revalidatePath } from 'next/cache';
import {
  INTAKE_JSON_SCHEMA,
  INTAKE_SYSTEM_PROMPT,
  type ParsedIntake,
} from '@/lib/ai/intake-prompt';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 12;
const PARSE_MODEL = 'gpt-4o-mini';

export type ParseInboundResult = { ok: true; draft: ParsedIntake } | { ok: false; error: string };

export async function parseInboundLeadAction(formData: FormData): Promise<ParseInboundResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'Server missing OPENAI_API_KEY' };

  const customerName = String(formData.get('customerName') ?? '').trim();
  const pastedText = String(formData.get('pastedText') ?? '').trim();
  if (!customerName && !pastedText && !formData.getAll('images').length) {
    return { ok: false, error: 'Need at least an image, pasted text, or a customer name.' };
  }

  const files = formData.getAll('images').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > MAX_IMAGES) {
    return { ok: false, error: `Too many files (max ${MAX_IMAGES}).` };
  }
  for (const f of files) {
    if (f.size > MAX_BYTES) {
      return { ok: false, error: `${f.name} is larger than 10MB.` };
    }
    const isImage = f.type.startsWith('image/');
    const isPdf = f.type === 'application/pdf';
    if (!isImage && !isPdf) {
      return { ok: false, error: `${f.name} is not an image or PDF (${f.type}).` };
    }
  }

  // Build the user message: a labelled text block + each image inline.
  const userContent: Array<Record<string, unknown>> = [];
  const intro = [
    `Tenant: ${tenant.name ?? 'Contractor'}`,
    `Customer (operator-supplied): ${customerName || '(not provided)'}`,
    pastedText
      ? `Pasted message text:\n${pastedText}`
      : '(No pasted text — extract everything from the screenshots.)',
    files.length
      ? `${files.length} artifact(s) follow (images and/or PDFs), indexed 0..${files.length - 1}.`
      : '(No artifacts.)',
  ].join('\n\n');
  userContent.push({ type: 'text', text: intro });

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
      { role: 'system', content: INTAKE_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_schema', json_schema: INTAKE_JSON_SCHEMA },
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

  let draft: ParsedIntake;
  try {
    draft = JSON.parse(content) as ParsedIntake;
  } catch {
    return { ok: false, error: 'OpenAI returned non-JSON.' };
  }

  // If operator typed a customer name, prefer it over whatever the model
  // pulled from the messages.
  if (customerName) draft.customer.name = customerName;

  return { ok: true, draft };
}

export type AcceptInboundResult = { ok: true; projectId: string } | { ok: false; error: string };

export async function acceptInboundLeadAction(draft: ParsedIntake): Promise<AcceptInboundResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  const customerName = draft.customer.name?.trim();
  if (!customerName) return { ok: false, error: 'Customer name is required.' };

  // 1. Customer
  const { data: cust, error: custErr } = await supabase
    .from('customers')
    .insert({
      tenant_id: tenant.id,
      type: 'residential',
      name: customerName,
      email: draft.customer.email?.trim() || null,
      phone: draft.customer.phone?.trim() || null,
      address_line1: draft.customer.address?.trim() || null,
    })
    .select('id')
    .single();
  if (custErr || !cust) {
    return { ok: false, error: custErr?.message ?? 'Failed to create customer.' };
  }

  // 2. Project
  const projectName = draft.project.name?.trim() || `${customerName} project`;
  const { data: proj, error: projErr } = await supabase
    .from('projects')
    .insert({
      tenant_id: tenant.id,
      customer_id: cust.id,
      name: projectName,
      description: draft.project.description?.trim() || null,
      intake_source: 'text-thread',
      intake_signals: draft.signals,
    })
    .select('id')
    .single();
  if (projErr || !proj) {
    return { ok: false, error: projErr?.message ?? 'Failed to create project.' };
  }

  // 3. Buckets
  const bucketRows = draft.buckets.map((b, i) => ({
    project_id: proj.id,
    tenant_id: tenant.id,
    name: b.name,
    section: b.section?.trim() || 'General',
    display_order: i,
  }));
  let bucketIds: string[] = [];
  if (bucketRows.length) {
    const { data: bs, error: bErr } = await supabase
      .from('project_cost_buckets')
      .insert(bucketRows)
      .select('id');
    if (bErr) return { ok: false, error: `Buckets: ${bErr.message}` };
    bucketIds = (bs ?? []).map((b) => b.id);
  }

  // 4. Cost lines
  const lineRows: Array<Record<string, unknown>> = [];
  draft.buckets.forEach((b, bi) => {
    const bucketId = bucketIds[bi] ?? null;
    b.lines.forEach((l, li) => {
      const qty = Number(l.qty) || 1;
      const unitPrice = Number(l.unit_price_cents ?? 0) || 0;
      lineRows.push({
        tenant_id: tenant.id,
        project_id: proj.id,
        bucket_id: bucketId,
        label: l.label,
        notes: l.notes?.trim() || null,
        qty,
        unit: l.unit || 'lot',
        unit_cost_cents: 0,
        unit_price_cents: unitPrice,
        line_cost_cents: 0,
        line_price_cents: Math.round(qty * unitPrice),
        markup_pct: 0,
        sort_order: li,
      });
    });
  });
  if (lineRows.length) {
    const { error: lErr } = await supabase.from('project_cost_lines').insert(lineRows);
    if (lErr) return { ok: false, error: `Cost lines: ${lErr.message}` };
  }

  // 5. Worklog
  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Project created from text thread',
    body: `Project "${projectName}" created via inbound intake.${
      draft.signals.competitive ? ' ⚠ Customer is shopping (competitive).' : ''
    }`,
    related_type: 'project',
    related_id: proj.id,
  });

  revalidatePath('/projects');
  return { ok: true, projectId: proj.id };
}
