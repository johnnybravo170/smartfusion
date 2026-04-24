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
import { type ContactMatch, findContactMatches } from '@/lib/db/queries/contact-matches';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES = 12;
// Was gpt-4o-mini. Swapped up to gpt-4.1 because mini consistently
// undershoots on long conversational transcripts — it would lump
// flooring + baseboards + casings + demo into a single "Flooring"
// bucket with three line items even when the audio explicitly broke
// them out with quantities and unit prices. gpt-4.1 is materially
// better at multi-bucket decomposition and quantity disambiguation
// across context-heavy inputs. Cost difference per intake call is
// pennies; the win in completeness is much larger.
const PARSE_MODEL = 'gpt-4.1';

export type ParseInboundResult = { ok: true; draft: ParsedIntake } | { ok: false; error: string };

export async function parseInboundLeadAction(formData: FormData): Promise<ParseInboundResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'Server missing OPENAI_API_KEY' };

  const customerName = String(formData.get('customerName') ?? '').trim();
  let pastedText = String(formData.get('pastedText') ?? '').trim();

  // Every file rides via Supabase Storage now — the client uploads to
  // the `intake-audio` bucket (the name is historical; it stages
  // images + PDFs too) and we get only the storage entries here. Vercel
  // caps server-action bodies around 4.5 MB, so two photos or one voice
  // memo in the body killed the request before the action even ran.
  // Each entry carries the storage path + the original filename so the
  // prompt can use names like "Tony flooding job. 2452 mountain
  // drive.m4a" to extract customer / address context.
  const storageEntries: Array<{ path: string; name: string }> = [];
  for (const entry of formData.getAll('storageEntries')) {
    if (typeof entry !== 'string') continue;
    try {
      const parsed = JSON.parse(entry) as { path?: unknown; name?: unknown };
      if (typeof parsed.path === 'string' && parsed.path.length > 0) {
        storageEntries.push({
          path: parsed.path,
          name: typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : 'file',
        });
      }
    } catch {
      // Ignore malformed entry — better to drop one artifact than fail the whole intake.
    }
  }

  if (!customerName && !pastedText && storageEntries.length === 0) {
    return { ok: false, error: 'Need at least an image, pasted text, or a customer name.' };
  }
  if (storageEntries.length > MAX_IMAGES) {
    return { ok: false, error: `Too many files (max ${MAX_IMAGES}).` };
  }

  // Download each staged file via the service-role client (bypasses RLS
  // — the bucket is auth-scoped but the admin client skips that). Audio
  // goes to Whisper and its transcript is folded into pastedText.
  // Images + PDFs collect into `files` for the downstream vision pass.
  // Best-effort cleanup of each staging file after.
  const files: File[] = [];
  if (storageEntries.length > 0) {
    const admin = createAdminClient();
    for (const { path, name: originalName } of storageEntries) {
      const { data: blob, error: dlErr } = await admin.storage.from('intake-audio').download(path);
      if (dlErr || !blob) continue;
      if (blob.size > MAX_BYTES) {
        await admin.storage.from('intake-audio').remove([path]);
        return { ok: false, error: `A staged file is larger than 25MB.` };
      }
      const type = blob.type || 'application/octet-stream';
      const f = new File([blob], originalName, { type });
      if (type.startsWith('audio/')) {
        const transcript = await transcribeAudio(apiKey, f);
        if (transcript) {
          // Label the transcript with the original filename. The filename
          // frequently carries the customer's name and address ("Tony
          // flooding job. 2452 mountain drive.m4a") which the downstream
          // prompt can then extract into structured fields.
          const label = `Voice memo transcript (file: "${originalName}"):`;
          const block = `${label}\n${transcript}`;
          pastedText = pastedText ? `${pastedText}\n\n${block}` : block;
        }
      } else if (type.startsWith('image/') || type === 'application/pdf') {
        files.push(f);
      }
      await admin.storage.from('intake-audio').remove([path]);
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

export type AcceptInboundResult =
  | { ok: true; projectId: string }
  | { ok: false; error: string; duplicates?: ContactMatch[] };

export async function acceptInboundLeadAction(
  draft: ParsedIntake,
  options?: {
    /** Use this existing customer id instead of creating a new one. */
    useExistingContactId?: string;
    /** Skip the dedup check. Set after operator clicks "Create anyway". */
    confirmCreate?: boolean;
  },
): Promise<AcceptInboundResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  const customerName = draft.customer.name?.trim();
  if (!customerName) return { ok: false, error: 'Customer name is required.' };

  // 1. Customer — resolve to an existing row, or check for duplicates before
  //    creating a new one.
  let customerId: string;
  if (options?.useExistingContactId) {
    customerId = options.useExistingContactId;
  } else {
    if (!options?.confirmCreate) {
      const duplicates = await findContactMatches({
        name: customerName,
        phone: draft.customer.phone,
        email: draft.customer.email,
      });
      if (duplicates.length > 0) {
        return {
          ok: false,
          error:
            duplicates.length === 1
              ? 'A contact like this already exists. Attach the project to them or create a new contact.'
              : 'Contacts like this already exist. Attach the project to one of them or create new.',
          duplicates,
        };
      }
    }

    const { data: cust, error: custErr } = await supabase
      .from('customers')
      .insert({
        tenant_id: tenant.id,
        kind: 'customer',
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
    customerId = cust.id;
  }
  const cust = { id: customerId };

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
        project_id: proj.id,
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

/**
 * Audio transcription. We use OpenAI's `gpt-4o-transcribe` (same price as
 * the older `whisper-1` but materially better on proper nouns, addresses,
 * and noisy jobsite recordings — a lot of these memos are recorded with
 * compressors and saws running).
 *
 * The `prompt` parameter biases the model toward the vocabulary a GC is
 * likely to use, which improves recognition of construction terms +
 * proper-noun-like scope items.
 *
 * Returns the transcript text on success, null on any failure. The caller
 * folds the transcript into pastedText so the downstream vision/text
 * prompt sees it as if the operator had typed it.
 */
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
const TRANSCRIBE_PROMPT =
  "General contractor scoping a residential renovation. The speaker is the contractor, not the customer; they mention the customer's first name, the job address (street number + street name), budget hints, and scope items such as flooring, baseboards, trim, demo, paint, drywall, tile, framing, plumbing, electrical, HVAC, insulation, cabinets, countertops, plywood, subfloor, transitions, stair nose, carpet removal, fixtures, finishes, kitchen, bathroom, basement, deck, fence, roof, siding, exterior.";

async function transcribeAudio(apiKey: string, file: File): Promise<string | null> {
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('model', TRANSCRIBE_MODEL);
    fd.append('response_format', 'text');
    fd.append('prompt', TRANSCRIBE_PROMPT);
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text || null;
  } catch {
    return null;
  }
}
