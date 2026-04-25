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

import Anthropic from '@anthropic-ai/sdk';
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
// Opus on intake — this is the highest-reasoning task in the app
// (multimodal: audio transcript + images + PDFs, domain inference,
// supply/install decomposition, implicit upsell extraction, AND
// human-voice reply generation). Sonnet beat gpt-4.1 on the Tony
// A/B; we're pushing further to top-tier reasoning here. Cost
// ~25¢/call vs ~5¢ on Sonnet — fine for a feature that runs once
// per inbound lead.
const CLAUDE_PARSE_MODEL = 'claude-opus-4-5';
// Sonnet runs a focused structural-integrity verification pass over
// Opus's draft when there's a transcript to check against. Narrow
// task ("find missing scope areas + missing numbers"), much faster
// model — adds ~6-10s vs Opus's ~30-35s, but pulls the floor up
// where Opus alone defaulted whole bucket categories to qty:1/scope.
// Only fires when audio transcript exists; image-only runs skip it.
const VERIFY_MODEL = 'claude-sonnet-4-5';

export type ParseModelChoice = 'gpt-4.1' | 'claude-sonnet';

export type ParseInboundResult =
  | {
      ok: true;
      draft: ParsedIntake;
      /**
       * Concatenated Whisper transcript(s) from any audio attachments.
       * Surfaced on the review screen so the operator can see what the
       * model actually heard — invaluable when the buckets come back
       * thin and you need to diagnose whether the audio was unclear or
       * the extraction was lazy.
       */
      transcript: string | null;
      /**
       * Exact model id that produced this draft. Surfaced on the review
       * screen so any screenshot / PDF the operator captures is self-
       * labelled — no more "wait, was that Opus or Sonnet?".
       */
      parsedBy: string;
    }
  | { ok: false; error: string };

export async function parseInboundLeadAction(
  formData: FormData,
  options?: { model?: ParseModelChoice },
): Promise<ParseInboundResult> {
  const modelChoice: ParseModelChoice = options?.model ?? 'gpt-4.1';
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
  // goes to Whisper and its transcript is folded into pastedText AND
  // collected into transcriptParts so it can be surfaced on the review
  // screen for diagnosis. Images + PDFs collect into `files` for the
  // downstream vision pass. Best-effort cleanup of each staging file.
  const files: File[] = [];
  const transcriptParts: string[] = [];
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
          transcriptParts.push(`${originalName}\n\n${transcript}`);
        }
      } else if (type.startsWith('image/') || type === 'application/pdf') {
        files.push(f);
      }
      await admin.storage.from('intake-audio').remove([path]);
    }
  }
  const transcript = transcriptParts.length > 0 ? transcriptParts.join('\n\n---\n\n') : null;

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

  // Dispatch to either OpenAI gpt-4.1 (default) or Anthropic
  // claude-sonnet-4-5 depending on the operator's choice. Same prompt,
  // same JSON schema, different model — lets us A/B parse quality on
  // the same memo without redeploying.
  let draft: ParsedIntake;
  let parsedBy: string;
  if (modelChoice === 'claude-sonnet') {
    const claudeResult = await runClaudeParse(userContent);
    if (!claudeResult.ok) return { ok: false, error: claudeResult.error };
    draft = claudeResult.draft;
    parsedBy = CLAUDE_PARSE_MODEL;
  } else {
    const openaiResult = await runOpenAIParse(apiKey, userContent);
    if (!openaiResult.ok) return { ok: false, error: openaiResult.error };
    draft = openaiResult.draft;
    parsedBy = PARSE_MODEL;
  }

  // (Removed Sonnet verify pass — it was timing out on Vercel's 60s
  // function budget AND the one run that did land came back thinner
  // than first-pass alone. See `runVerifyPass` below; kept as dead
  // code for now while we redesign as a purely-additive delta merge
  // instead of a full draft regeneration.)

  // If operator typed a customer name, prefer it over whatever the model
  // pulled from the messages.
  if (customerName) draft.customer.name = customerName;

  return { ok: true, draft, transcript, parsedBy };
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

type ParseModelResult = { ok: true; draft: ParsedIntake } | { ok: false; error: string };

async function runOpenAIParse(
  apiKey: string,
  userContent: Array<Record<string, unknown>>,
): Promise<ParseModelResult> {
  const body = {
    model: PARSE_MODEL,
    messages: [
      { role: 'system', content: INTAKE_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_schema', json_schema: INTAKE_JSON_SCHEMA },
    temperature: 0.2,
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
  try {
    return { ok: true, draft: JSON.parse(content) as ParsedIntake };
  } catch {
    return { ok: false, error: 'OpenAI returned non-JSON.' };
  }
}

let _anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!_anthropicClient) _anthropicClient = new Anthropic();
  return _anthropicClient;
}

/**
 * Anthropic Claude Sonnet alternate parse path. Same system prompt, same
 * JSON schema, but the schema is bound through tool_use so the model is
 * forced to call `submit_intake` with input that satisfies the schema.
 *
 * For multimodal: image and PDF blocks come through as
 * `{type: 'image' | 'document', source: {type: 'base64', media_type, data}}`.
 * The OpenAI-shaped userContent we build above uses `image_url` /
 * `file` blocks that Anthropic doesn't understand, so we transform on
 * the way in.
 */
async function runClaudeParse(
  userContent: Array<Record<string, unknown>>,
): Promise<ParseModelResult> {
  const client = getAnthropicClient();

  // Transform the OpenAI-shaped userContent into Anthropic content blocks.
  type AnthropicBlock =
    | { type: 'text'; text: string }
    | {
        type: 'image';
        source: { type: 'base64'; media_type: string; data: string };
      }
    | {
        type: 'document';
        source: { type: 'base64'; media_type: 'application/pdf'; data: string };
      };
  const blocks: AnthropicBlock[] = [];
  for (const piece of userContent) {
    if (piece.type === 'text' && typeof piece.text === 'string') {
      blocks.push({ type: 'text', text: piece.text });
    } else if (piece.type === 'image_url' && typeof piece.image_url === 'object') {
      const url = (piece.image_url as { url?: string }).url ?? '';
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      }
    } else if (piece.type === 'file' && typeof piece.file === 'object') {
      const data = (piece.file as { file_data?: string }).file_data ?? '';
      const m = data.match(/^data:application\/pdf;base64,(.+)$/);
      if (m) {
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: m[1] },
        });
      }
    }
  }

  let response: Awaited<ReturnType<typeof client.messages.create>>;
  try {
    response = await client.messages.create({
      model: CLAUDE_PARSE_MODEL,
      max_tokens: 8000,
      temperature: 0.2,
      system: INTAKE_SYSTEM_PROMPT,
      tools: [
        {
          name: 'submit_intake',
          description: 'Submit the parsed intake structure for the operator to review.',
          input_schema:
            INTAKE_JSON_SCHEMA.schema as unknown as Anthropic.Messages.Tool['input_schema'],
        },
      ],
      tool_choice: { type: 'tool', name: 'submit_intake' },
      messages: [
        { role: 'user', content: blocks as unknown as Anthropic.Messages.ContentBlockParam[] },
      ],
    });
  } catch (e) {
    return { ok: false, error: `Anthropic error: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Find the tool_use block — the model is required to call submit_intake
  // because of tool_choice, so this should always exist on a 200.
  const toolBlock = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
  );
  if (!toolBlock) return { ok: false, error: 'Claude returned no tool_use block.' };
  return { ok: true, draft: toolBlock.input as ParsedIntake };
}

/**
 * Structural-integrity verification pass. The first-pass model (Opus or
 * gpt-4.1) is the highest-reasoning step but exhibits high run-to-run
 * variance — sometimes it gives a comprehensive draft with quantities
 * propagated to every line, sometimes it defaults whole bucket
 * categories to qty:1/scope and silently drops scope areas the speaker
 * mentioned.
 *
 * This pass is deliberately narrow and domain-agnostic:
 *   1. Did the first draft create a bucket for every distinct scope
 *      area / trade / material the transcript mentions?
 *   2. Did every number / dimension / count / lineal-ft / sq-ft in the
 *      transcript end up on a qty field (not buried in description
 *      prose)?
 *   3. Did every quoted unit price end up in unit_price_cents?
 *
 * Sonnet runs this in ~6-10s on top of Opus's ~30-35s — well within
 * the page's 60s budget. Only fires when there is an audio transcript;
 * image-only runs skip it because images don't carry the same kind of
 * spoken numerical detail and the marginal value drops.
 *
 * If this call fails for any reason (network, schema mismatch, etc.)
 * the caller falls back to the first-pass draft. The verify pass
 * should never block the operator's flow.
 */
const VERIFY_SYSTEM_PROMPT = `You are reviewing a draft estimate that another AI just produced from a contractor's voice memo. The draft may be missing scope areas or measurements that the contractor mentioned in the transcript.

Your job is a structural integrity check, NOT a re-do. Preserve everything correct. Fix what was missed.

1. SCOPE COMPLETENESS — Read the transcript. For every distinct trade, material, room, or scope area the contractor mentions, verify a bucket exists in the draft. If a scope area is missing, ADD a bucket for it with appropriate supply / install lines. Apply the same supply-and-install decomposition the first pass should have used: a "supply" line and an "install" line, plus pre-paint / finishing / disposal where the speaker mentioned them.

2. QUANTITY COMPLETENESS — For every number, dimension, count, square-footage, lineal-footage, hourly figure the contractor mentions, verify it appears on the qty field of the appropriate line item — NOT just in description prose. If a number is buried in a description string or missing entirely, MOVE it onto the qty field with the correct unit. Math: if the speaker says "9 sixteen-foot lengths" the qty is 144 lineal ft, not 9. If a single sq-ft figure (e.g. "657 sq ft") describes the whole work area, propagate it to every install / supply line that covers that area.

3. PRICE COMPLETENESS — If the contractor quoted a real unit price ("$0.50 a lineal foot", "$50 per sheet"), verify it appears in unit_price_cents (integer cents) on the right line. Do NOT invent prices.

4. "(BY OTHERS)" EXCLUSION BUCKETS — If the contractor explicitly says the customer or a third party (painter friend, son-in-law, relative) is handling part of the scope, ensure there's a bucket whose name ends with "(by others)" containing those line items at qty: 0 / unit_price_cents: 0 with notes explaining who's doing it.

5. PRESERVE everything else in the draft. Don't rewrite working content. Don't change the customer fields, project name/description, signals, image_roles, or reply_draft unless directly required by the corrections above.

Return the corrected draft using the same JSON schema. Call submit_intake with the corrected structure.`;

async function runVerifyPass(draft: ParsedIntake, transcript: string): Promise<ParseModelResult> {
  const client = getAnthropicClient();
  const userText = [
    'Here is the transcript the first-pass model worked from:',
    '',
    '<transcript>',
    transcript,
    '</transcript>',
    '',
    'Here is the draft it produced:',
    '',
    '<draft>',
    JSON.stringify(draft, null, 2),
    '</draft>',
    '',
    'Apply the structural-integrity check and return the corrected draft.',
  ].join('\n');

  let response: Awaited<ReturnType<typeof client.messages.create>>;
  try {
    response = await client.messages.create({
      model: VERIFY_MODEL,
      max_tokens: 8000,
      temperature: 0.2,
      system: VERIFY_SYSTEM_PROMPT,
      tools: [
        {
          name: 'submit_intake',
          description: 'Submit the corrected intake structure for the operator to review.',
          input_schema:
            INTAKE_JSON_SCHEMA.schema as unknown as Anthropic.Messages.Tool['input_schema'],
        },
      ],
      tool_choice: { type: 'tool', name: 'submit_intake' },
      messages: [{ role: 'user', content: userText }],
    });
  } catch (e) {
    return { ok: false, error: `Verify error: ${e instanceof Error ? e.message : String(e)}` };
  }

  const toolBlock = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
  );
  if (!toolBlock) return { ok: false, error: 'Verify returned no tool_use block.' };
  return { ok: true, draft: toolBlock.input as ParsedIntake };
}
